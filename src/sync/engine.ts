/**
 * State sync engine: owns every transition from raw c305 packets to store
 * fields.
 *
 *   connect → metadata dump (names + full state) → current-state dump
 *   preset-changed event → set active preset, confirm with a state dump
 *   bypass-changed / unknown event → (debounced) state dump
 *   knob / encoder / expression telemetry → ignored
 *
 * Both dump replies share one schema (the metadata reply is the state message
 * with the capture/preset/IR lists included), so every completed message goes
 * through the same handler: apply names if preset records are present, apply
 * state if state fields are present.
 *
 * Writes (FX toggle, preset switch) are gated behind `writesEnabled`, off by
 * default, optimistic, and confirmed by a follow-up state dump.
 */
import {
  decodeCurrentState,
  decodeEvent,
  decodeMetadata,
  inferActivePreset,
  type CurrentState,
  type Metadata,
} from '../protocol/decode';
import {
  CURRENT_STATE_REQUEST,
  FX_SLOTS,
  METADATA_DUMP_REQUEST,
  PRESET_CHANGE_ACK,
  BLE_MIDI_STRATEGIES,
  PRESET_COUNT,
  WEB_MIDI_STRATEGY,
  cabIrSlotFrame,
  captureBypassFrame,
  captureSelectFrame,
  fxBlockBypassFrame,
  gateBypassFrame,
  midiStrategyById,
  programChange,
  type FxSlot,
  type MidiStrategy,
} from '../protocol/frames';
import { toHex } from '../protocol/hex';
import { MSG, MessageAssembler, classifyPacket, parseFrameHeader, splitTrailer } from '../protocol/reassembly';
import type { Store } from '../state/store';
import { lookupFxModel, type FxModelsBySlot } from '../protocol/models';
import type { NotifyPacket, Transport } from '../transport/types';
import type { MidiOut } from '../transport/webmidi';

export interface EngineOptions {
  writesEnabled?: boolean;
  /** Re-request the state dump after an unrecognised live event (default true). */
  refreshOnUnknownEvent?: boolean;
  /** Debounce for the unknown-event refresh, ms. */
  unknownEventDebounceMs?: number;
  /** Hard cap on waiting for the metadata reply (it streams ~17 KB in ~6 s), ms. */
  metadataTimeoutMs?: number;
  /** Delay between an app-initiated change and the confirming state request, ms. */
  confirmDelayMs?: number;
  /** Re-request metadata on every (re)connect instead of reusing cached names. */
  alwaysRefreshMetadata?: boolean;
  /** Assembler inactivity fallback, ms. */
  inactivityMs?: number;
  /** Pin one MIDI delivery strategy (id from MIDI_STRATEGIES) instead of probing. */
  midiStrategy?: string | null;
  /** How long to wait for the device to confirm a preset switch, ms. */
  presetConfirmTimeoutMs?: number;
  /** OS-level MIDI output (Web MIDI). Tried first for preset switching when supported. */
  midiOut?: MidiOut | null;
}

/** Fewer preset records than this is treated as a corrupt / partial list and not applied. */
const MIN_PRESET_RECORDS = 32;

export class SyncEngine {
  private readonly assembler: MessageAssembler;
  private metadata: Metadata | null = null;
  private lastState: CurrentState | null = null;
  private unknownEventTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private stateRequestInFlightSince = 0;
  private awaitingMetadata = false;
  private unsubs: (() => void)[] = [];
  /** MIDI delivery that the device confirmed (or the pinned one). */
  private midiStrategy: MidiStrategy | null = null;
  private midiPinned = false;
  private presetWaiters: { index: number; resolve: (ok: boolean) => void }[] = [];
  private readonly opts: Required<EngineOptions>;

  constructor(
    private readonly transport: Transport,
    private readonly store: Store,
    opts: EngineOptions = {},
  ) {
    this.opts = {
      writesEnabled: opts.writesEnabled ?? false,
      refreshOnUnknownEvent: opts.refreshOnUnknownEvent ?? true,
      unknownEventDebounceMs: opts.unknownEventDebounceMs ?? 400,
      metadataTimeoutMs: opts.metadataTimeoutMs ?? 30000,
      confirmDelayMs: opts.confirmDelayMs ?? 300,
      alwaysRefreshMetadata: opts.alwaysRefreshMetadata ?? false,
      inactivityMs: opts.inactivityMs ?? 2500,
      midiStrategy: opts.midiStrategy ?? null,
      presetConfirmTimeoutMs: opts.presetConfirmTimeoutMs ?? 1500,
      midiOut: opts.midiOut ?? null,
    };
    this.midiStrategy = midiStrategyById(this.opts.midiStrategy);
    this.midiPinned = this.midiStrategy !== null;
    this.store.patch({ transportName: transport.name, writesEnabled: this.opts.writesEnabled });
    this.assembler = new MessageAssembler({
      onMessage: (body, meta) => this.onAssembledMessage(body, meta),
      inactivityMs: this.opts.inactivityMs,
    });
    this.unsubs.push(
      transport.onPacket((p) => this.onPacket(p)),
      transport.onStatus((s) => this.onStatus(s)),
      transport.onLog((line) => this.store.appendLog(line)),
    );
  }

  get writesEnabled(): boolean {
    return this.opts.writesEnabled;
  }

  setWritesEnabled(enabled: boolean): void {
    this.opts.writesEnabled = enabled;
    this.store.patch({ writesEnabled: enabled });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.assembler.cancel();
    for (const t of [this.unknownEventTimer, this.metadataTimer, this.confirmTimer]) if (t) clearTimeout(t);
  }

  private log(dir: 'info' | 'warn' | 'error', text: string, hex?: string) {
    this.store.appendLog({ at: Date.now(), dir, text, ...(hex ? { hex } : {}) });
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onStatus(status: Transport['status']) {
    this.store.patch({ connection: status, deviceName: this.transport.deviceName });
    if (status === 'connected') {
      void this.startSync();
    } else {
      this.assembler.cancel();
      this.awaitingMetadata = false;
      this.stateRequestInFlightSince = 0; // never coalesce the first request of a new link
      this.settlePresetWaiters(-1);
      if (status === 'disconnected' || status === 'reconnecting') this.store.clearDeviceState();
    }
  }

  /** Full sync: metadata (names + state) then a fresh state dump. Safe to call repeatedly. */
  async startSync(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    this.store.patch({ lastError: null });
    try {
      if (!this.metadata || this.opts.alwaysRefreshMetadata) {
        await this.requestMetadata();
      } else {
        this.log('info', 'Metadata cached from earlier in this session; skipping metadata dump');
        await this.requestState();
      }
    } catch (err) {
      this.store.patch({ syncPhase: 'error', lastError: (err as Error).message });
      this.log('error', `Sync failed: ${(err as Error).message}`);
    }
  }

  /** Request the metadata dump; a state dump follows once it completes (or times out). */
  async requestMetadata(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    this.store.patch({ syncPhase: 'metadata' });
    this.awaitingMetadata = true;
    if (this.metadataTimer) clearTimeout(this.metadataTimer);
    this.metadataTimer = setTimeout(() => {
      if (!this.awaitingMetadata) return;
      this.awaitingMetadata = false;
      this.log('warn', 'No complete metadata reply; continuing with current-state dump');
      void this.requestState();
    }, this.opts.metadataTimeoutMs);
    await this.transport.writeCommand(METADATA_DUMP_REQUEST);
  }

  /** Request the current-state dump. Coalesces requests issued within 250 ms. */
  async requestState(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    const now = Date.now();
    if (now - this.stateRequestInFlightSince < 250) return;
    this.stateRequestInFlightSince = now;
    if (this.store.get().syncPhase !== 'ready') this.store.patch({ syncPhase: 'state' });
    await this.transport.writeCommand(CURRENT_STATE_REQUEST);
  }

  // -------------------------------------------------------------------------
  // Inbound packets
  // -------------------------------------------------------------------------

  private onPacket(pkt: NotifyPacket) {
    const kind = classifyPacket(pkt.data, this.assembler.open);
    switch (kind) {
      case 'empty':
        return;
      case 'fx-param-reply':
      case 'cab-param-reply':
        // Parameter refresh replies are never requested by the gig view.
        return;
      case 'fragment':
        this.assembler.push(pkt.data);
        return;
      case 'message':
        this.onSingleMessage(pkt);
        return;
    }
  }

  /** A complete single-packet message: a dump reply or a live event. */
  private onSingleMessage(pkt: NotifyPacket) {
    const header = parseFrameHeader(pkt.data);
    if (header) {
      const { payload, msgType } = splitTrailer(pkt.data.subarray(2));
      if (msgType === MSG.DUMP || (msgType === null && payload.length > 40)) {
        this.handleDump(payload, { packets: 1, complete: true });
        return;
      }
    }
    this.onEvent(pkt);
  }

  private onAssembledMessage(body: Uint8Array, meta: { packets: number; complete: boolean }) {
    const { payload, msgType } = splitTrailer(body);
    if (!meta.complete) {
      this.log('warn', `Unterminated message flushed after inactivity (${body.length} B, ${meta.packets} pkts)`);
    }
    if (msgType !== null && msgType !== MSG.DUMP) {
      this.log('warn', `Multi-packet message of unexpected type 0x${msgType.toString(16)} (${body.length} B)`, toHex(payload.subarray(0, 32)));
    }
    this.handleDump(payload, meta);
  }

  private onEvent(pkt: NotifyPacket) {
    const ev = decodeEvent(pkt.data);
    this.store.patch({ lastEventAt: pkt.at });
    switch (ev.kind) {
      case 'program-change':
        this.log('info', `Preset changed → ${ev.preset + 1} (${ev.shape})`, toHex(pkt.data));
        this.store.setField('activePreset', ev.preset, 'event', pkt.at);
        if (ev.assignments) this.store.setField('footswitches', ev.assignments, 'event', pkt.at);
        this.settlePresetWaiters(ev.preset);
        this.scheduleConfirm(150);
        return;
      case 'bypass-changed':
        this.log('info', 'Bypass changed on device; re-reading state', toHex(pkt.data));
        this.scheduleConfirm(150);
        return;
      case 'control':
        // Knobs (0x1A) and expression (0x40) change nothing on screen. The footswitch encoders
        // (0x1C, same `18 <selector> 20 <value>` shape as our slot-select writes) scroll through
        // captures / cabs, so the names must be re-read; debounced because a rotation is a burst.
        // Knob events (0x1A) may also carry tap-tempo / tempo changes, so re-read after a burst.
        if (ev.msgType === MSG.ENCODER || ev.msgType === MSG.KNOB) this.scheduleDebouncedRefresh();
        return;
      case 'unknown':
        // 0x73 is the pedal's generic "something changed" notice: seen after footswitch presses and
        // as the ack to our capture/cab slot writes (2026-09-13). Undocumented, so we just re-read state.
        this.log('info', `Undocumented event${ev.msgType !== null ? ` type 0x${ev.msgType.toString(16)}` : ''}; re-reading state shortly`, toHex(pkt.data));
        if (this.opts.refreshOnUnknownEvent) this.scheduleDebouncedRefresh();
        return;
    }
  }

  /** Any dump reply: names if preset records are present, state if state fields are present. */
  private handleDump(payload: Uint8Array, meta: { packets: number; complete: boolean }) {
    const md = decodeMetadata(payload);
    if (md.presetRecordCount > 0) {
      this.log('info', `Metadata: ${md.presetRecordCount} preset records, ${md.captures.length} captures, ${md.irs.length} IRs (${payload.length} B, ${meta.packets} pkts)`);
      if (md.irs.length) this.log('info', `IR slots: ${md.irs.map((r, i) => `${i + 1}=${r.shortName || r.fullName}`).join(' | ')}`);
      else this.log('warn', 'Metadata carried no IR slot list (field 19); cab re-enable will not be possible until it does');
      if (md.presetRecordCount >= MIN_PRESET_RECORDS) {
        this.metadata = md;
        this.store.setField('presetNames', md.presets.map((p) => p.name), 'metadata');
        this.updateSlotKnowledge(Date.now());
        this.store.patch({ lastMetadataAt: Date.now() });
      } else {
        this.log('warn', `Only ${md.presetRecordCount} preset records; keeping previous names`);
      }
      if (this.awaitingMetadata) {
        this.awaitingMetadata = false;
        if (this.metadataTimer) clearTimeout(this.metadataTimer);
        // The metadata reply already carries the state; a fresh state dump is cheap and confirms it.
        void this.requestState();
      }
    }

    const state = decodeCurrentState(payload);
    if (!state) {
      if (md.presetRecordCount === 0) {
        this.log('warn', `Unrecognised dump payload (${payload.length} B, ${meta.packets} pkts)`, toHex(payload.subarray(0, 64)));
      }
      return;
    }
    this.applyState(state);
  }

  private applyState(state: CurrentState) {
    const at = Date.now();
    this.lastState = state;
    this.stateRequestInFlightSince = 0; // reply received; the next request may go out immediately
    if (state.fxOn) this.store.setField('fxOn', { ...state.fxOn }, 'dump', at);
    const models = {} as FxModelsBySlot;
    for (const slot of FX_SLOTS) models[slot] = lookupFxModel(state.fxModelIds[slot]);
    this.store.setField('fxModels', models, 'dump', at);
    this.store.setField('gateOn', state.gateOn, 'dump', at);
    this.store.setField('cabOn', state.cabOn, 'dump', at);
    this.store.setField('captureName', state.capture?.name || null, 'dump', at); // '' (no capture) → null
    // Capture on/off follows field 11 (rotary position, 0/absent = bypassed) as in the web editor.
    // Field 32.1 ("enabled") is NOT used: hardware dumps show it stuck at 1 after a bypass
    // (2026-09-13) and at 0 with position 4 (2026-09-12), so it means something else.
    const captureOn = (state.captureSlot ?? 0) > 0;
    this.store.setField('captureOn', captureOn, 'dump', at);
    this.store.setField('irName', state.ir?.shortName || null, 'dump', at);
    if (state.firmware) this.store.setField('firmware', state.firmware, 'dump', at);
    if (state.footswitchAssignments) this.store.setField('footswitches', state.footswitchAssignments, 'dump', at);
    this.store.setField('tempo', state.tempoBpm, 'dump', at);
    this.updateSlotKnowledge(at);

    if (state.activePreset !== null) {
      this.store.setField('activePreset', state.activePreset, 'dump', at);
      this.settlePresetWaiters(state.activePreset);
    } else {
      const current = this.store.get().activePreset;
      if (this.metadata && (current.value === null || current.source === 'inferred')) {
        const inferred = inferActivePreset(this.metadata, state);
        if (inferred !== null && inferred !== current.value) {
          this.store.setField('activePreset', inferred, 'inferred', at);
          this.log('info', `Active preset inferred from capture/IR names → ${inferred + 1} (unconfirmed)`);
        }
      }
    }
    this.store.patch({ lastStateSyncAt: at, syncPhase: 'ready' });
    const on = FX_SLOTS.map((s) => `${s}=${models[s]?.name ?? 'empty'}:${state.fxOn ? (state.fxOn[s] ? 'on' : 'off') : '?'}`).join(' ');
    this.log(
      'info',
      `State: preset=${state.activePreset === null ? '?' : state.activePreset + 1} ${on} gate=${state.gateOn} cab=${state.cabOn} capture="${state.capture?.name ?? ''}" ir="${state.ir?.shortName ?? ''}"`,
    );
  }

  private scheduleConfirm(delayMs = this.opts.confirmDelayMs) {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => void this.requestState(), delayMs);
  }

  // -------------------------------------------------------------------------
  // Optional writes (flag-gated)
  // -------------------------------------------------------------------------

  private assertWrites() {
    if (!this.opts.writesEnabled) throw new Error('Writes are disabled (enable with ?writes=1)');
    if (this.transport.status !== 'connected') throw new Error('Not connected');
  }

  async toggleFx(slot: FxSlot): Promise<void> {
    this.assertWrites();
    const current = this.store.get().fxOn.value[slot];
    if (current === null) throw new Error(`FX ${slot} state unknown; refusing to toggle blind`);
    const next = !current;
    this.store.setField('fxOn', { ...this.store.get().fxOn.value, [slot]: next }, 'optimistic');
    await this.transport.writeCommand(fxBlockBypassFrame(slot, next));
    this.scheduleConfirm();
  }

  /** Capture slot 1..25 of the current capture, from the metadata list (by id, then name). */
  private currentCaptureSlot(): number | null {
    const cap = this.lastState?.capture;
    const list = this.metadata?.captures ?? [];
    if (!cap) return null;
    let i = cap.id ? list.findIndex((c) => c.id === cap.id) : -1;
    if (i < 0 && cap.name) i = list.findIndex((c) => c.name.trim().toLowerCase() === cap.name.trim().toLowerCase());
    return i >= 0 ? i + 1 : null;
  }

  /** Cab/IR slot 1..5 of the current IR, from the metadata list (by short name). */
  private currentCabSlot(): number | null {
    const ir = this.lastState?.ir;
    const list = this.metadata?.irs ?? [];
    if (!ir?.shortName) return null;
    const i = list.findIndex((r) => r.shortName.trim().toLowerCase() === ir.shortName.trim().toLowerCase());
    return i >= 0 ? i + 1 : null;
  }

  /**
   * Re-enabling capture/cab needs the slot index, which only comes from matching the current
   * name against the metadata slot lists. Publish whether that match exists so the UI can lock
   * the toggle for library captures/IRs instead of failing on tap.
   */
  private updateSlotKnowledge(at: number): void {
    if (!this.lastState) return;
    // No name at all (preset has no capture / no IR) → nothing to re-enable → locked too.
    const known = (name: string | null | undefined, slot: number | null): boolean | null =>
      !name ? false : this.metadata ? slot !== null : null;
    this.store.setField('captureSlotKnown', known(this.lastState.capture?.name, this.currentCaptureSlot()), 'dump', at);
    this.store.setField('cabSlotKnown', known(this.lastState.ir?.shortName, this.currentCabSlot()), 'dump', at);
  }

  /** Human-readable reason why the current capture/IR could not be mapped to a slot. */
  private slotLookupDiag(kind: 'capture' | 'ir'): string {
    const current = kind === 'capture' ? this.lastState?.capture?.name : this.lastState?.ir?.shortName;
    if (!this.lastState) return 'no state dump received yet';
    if (!current) return `the pedal did not report a current ${kind} name`;
    if (!this.metadata) return `metadata not loaded yet (current ${kind} "${current}")`;
    const names = kind === 'capture' ? this.metadata.captures.map((c) => c.name) : this.metadata.irs.map((r) => r.shortName || r.fullName);
    if (names.length === 0) return `metadata listed no ${kind} slots (current ${kind} "${current}")`;
    return `"${current}" is not among the pedal's ${names.length} ${kind} slots: ${names.join(' | ')}`;
  }

  /** Bypass or re-enable the capture block. Re-enabling needs the slot; refuses rather than guessing. */
  async toggleCapture(): Promise<void> {
    this.assertWrites();
    const current = this.store.get().captureOn.value;
    if (current === null) throw new Error('Capture state unknown; refusing to toggle blind');
    // Locked both ways: bypassing a capture we could not re-enable would strand the user.
    const slot = this.currentCaptureSlot();
    if (slot === null) throw new Error(`Capture toggle locked: ${this.slotLookupDiag('capture')}`);
    if (current) {
      this.store.setField('captureOn', false, 'optimistic');
      await this.transport.writeCommand(captureBypassFrame());
    } else {
      this.store.setField('captureOn', true, 'optimistic');
      await this.transport.writeCommand(captureSelectFrame(slot));
    }
    this.scheduleConfirm();
  }

  /** Bypass or re-enable the cab/IR block. Re-enabling needs the IR slot; refuses rather than guessing. */
  async toggleCab(): Promise<void> {
    this.assertWrites();
    const current = this.store.get().cabOn.value;
    if (current === null) throw new Error('Cab/IR state unknown; refusing to toggle blind');
    const slot = this.currentCabSlot();
    if (slot === null) throw new Error(`Cab toggle locked: ${this.slotLookupDiag('ir')}`);
    if (current) {
      this.store.setField('cabOn', false, 'optimistic');
      await this.transport.writeCommand(cabIrSlotFrame(0));
    } else {
      this.store.setField('cabOn', true, 'optimistic');
      await this.transport.writeCommand(cabIrSlotFrame(slot));
    }
    this.scheduleConfirm();
  }

  async toggleGate(): Promise<void> {
    this.assertWrites();
    const current = this.store.get().gateOn.value;
    if (current === null) throw new Error('Gate state unknown; refusing to toggle blind');
    const next = !current;
    this.store.setField('gateOn', next, 'optimistic');
    await this.transport.writeCommand(gateBypassFrame(next));
    this.scheduleConfirm();
  }

  /** One state re-read shortly after the last of a burst of events (encoder turns, 0x73 notices). */
  private scheduleDebouncedRefresh(): void {
    if (this.store.get().syncPhase !== 'ready') return;
    if (this.unknownEventTimer) clearTimeout(this.unknownEventTimer);
    this.unknownEventTimer = setTimeout(() => void this.requestState(), this.opts.unknownEventDebounceMs);
  }

  private settlePresetWaiters(actual: number) {
    const waiters = this.presetWaiters;
    this.presetWaiters = [];
    for (const w of waiters) w.resolve(w.index === actual);
  }

  /** Resolve true when the device reports `index` as active (event or dump), false on timeout. */
  private waitForPreset(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter = { index, resolve: (ok: boolean) => resolve(ok) };
      this.presetWaiters.push(waiter);
      setTimeout(() => {
        if (this.presetWaiters.includes(waiter)) {
          this.presetWaiters = this.presetWaiters.filter((w) => w !== waiter);
          resolve(false);
        }
      }, this.opts.presetConfirmTimeoutMs);
    });
  }

  /** The MIDI delivery currently in use (confirmed, pinned, or null while unknown). */
  get activeMidiStrategy(): MidiStrategy | null {
    return this.midiStrategy;
  }

  /**
   * Switch preset by zero-based index. Sends a MIDI Program Change, then the
   * ack frame on c304, then waits for the device to report the new preset
   * (preset-changed event or state dump field 13). If the delivery strategy is
   * not yet known, the documented variants are tried in order until the device
   * confirms one; the winner is remembered for the session.
   */
  async selectPreset(index: number): Promise<void> {
    this.assertWrites();
    if (!Number.isInteger(index) || index < 0 || index >= PRESET_COUNT) throw new RangeError(`bad preset index ${index}`);
    this.store.setField('activePreset', index, 'optimistic');
    const midiOut = this.opts.midiOut;
    const all = [...(midiOut?.isSupported() ? [WEB_MIDI_STRATEGY] : []), ...BLE_MIDI_STRATEGIES];
    const candidates = this.midiStrategy ? [this.midiStrategy, ...(this.midiPinned ? [] : all.filter((s) => s.id !== this.midiStrategy!.id))] : all;
    for (const strategy of candidates) {
      const confirmed = this.waitForPreset(index);
      try {
        if (strategy.char === 'web-midi') {
          if (!midiOut) throw new Error('Web MIDI not configured');
          await midiOut.open();
          const pc = programChange(index);
          this.log('info', `TX web-midi [${strategy.id}] → ${midiOut.portName}`, toHex(pc));
          await midiOut.send(pc);
        } else {
          await this.transport.writeMidi(programChange(index), strategy);
        }
      } catch (err) {
        this.log('warn', `Preset switch via ${strategy.id} rejected: ${(err as Error).message}`);
        this.settlePresetWaiters(-1);
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
      await this.transport.writeCommand(PRESET_CHANGE_ACK).catch((err) => this.log('warn', `ack frame failed: ${(err as Error).message}`));
      this.scheduleConfirm(this.midiStrategy === strategy ? this.opts.confirmDelayMs : 400);
      if (await confirmed) {
        if (this.midiStrategy !== strategy) {
          this.midiStrategy = strategy;
          this.log('info', `Preset switching works via ${strategy.id}; remembering it for this session`);
        }
        return;
      }
      this.log('warn', `Preset switch via ${strategy.id} not confirmed by the device`);
      if (this.midiPinned) break;
    }
    this.log(
      'error',
      'Preset switch failed: no MIDI delivery was confirmed by the device. Connect the pedal over USB so Web MIDI can reach its "Nano Cortex" port.',
    );
    void this.requestState(); // resync the optimistic value with reality
  }

  async nextPreset(): Promise<void> {
    const cur = this.store.get().activePreset.value;
    await this.selectPreset(cur === null ? 0 : (cur + 1) % PRESET_COUNT);
  }

  async prevPreset(): Promise<void> {
    const cur = this.store.get().activePreset.value;
    await this.selectPreset(cur === null ? 0 : (cur + PRESET_COUNT - 1) % PRESET_COUNT);
  }

  /** Diagnostics accessors. */
  get lastDecodedState(): CurrentState | null {
    return this.lastState;
  }
  get metadataSnapshot(): Metadata | null {
    return this.metadata;
  }
}
