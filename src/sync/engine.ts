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
  PRESET_COUNT,
  fxBlockBypassFrame,
  gateBypassFrame,
  programChange,
  type FxSlot,
} from '../protocol/frames';
import { toHex } from '../protocol/hex';
import { MSG, MessageAssembler, classifyPacket, parseFrameHeader, splitTrailer } from '../protocol/reassembly';
import type { Store } from '../state/store';
import type { NotifyPacket, Transport } from '../transport/types';

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
    };
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
        this.scheduleConfirm(150);
        return;
      case 'bypass-changed':
        this.log('info', 'Bypass changed on device; re-reading state', toHex(pkt.data));
        this.scheduleConfirm(150);
        return;
      case 'control':
        return; // knob / encoder / expression: nothing on screen depends on it
      case 'unknown':
        this.log('info', `Unrecognised event${ev.msgType !== null ? ` type 0x${ev.msgType.toString(16)}` : ''}`, toHex(pkt.data));
        if (this.opts.refreshOnUnknownEvent && this.store.get().syncPhase === 'ready') {
          if (this.unknownEventTimer) clearTimeout(this.unknownEventTimer);
          this.unknownEventTimer = setTimeout(() => void this.requestState(), this.opts.unknownEventDebounceMs);
        }
        return;
    }
  }

  /** Any dump reply: names if preset records are present, state if state fields are present. */
  private handleDump(payload: Uint8Array, meta: { packets: number; complete: boolean }) {
    const md = decodeMetadata(payload);
    if (md.presetRecordCount > 0) {
      this.log('info', `Metadata: ${md.presetRecordCount} preset records, ${md.captures.length} captures, ${md.irs.length} IRs (${payload.length} B, ${meta.packets} pkts)`);
      if (md.presetRecordCount >= MIN_PRESET_RECORDS) {
        this.metadata = md;
        this.store.setField('presetNames', md.presets.map((p) => p.name), 'metadata');
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
    if (state.fxOn) this.store.setField('fxOn', { ...state.fxOn }, 'dump', at);
    this.store.setField('gateOn', state.gateOn, 'dump', at);
    this.store.setField('cabOn', state.cabOn, 'dump', at);
    this.store.setField('captureName', state.capture?.name ?? null, 'dump', at);
    this.store.setField('irName', state.ir?.shortName ?? null, 'dump', at);
    if (state.firmware) this.store.setField('firmware', state.firmware, 'dump', at);

    if (state.activePreset !== null) {
      this.store.setField('activePreset', state.activePreset, 'dump', at);
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
    const on = FX_SLOTS.map((s) => `${s}=${state.fxOn ? (state.fxOn[s] ? 'on' : 'off') : '?'}`).join(' ');
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

  async toggleGate(): Promise<void> {
    this.assertWrites();
    const current = this.store.get().gateOn.value;
    if (current === null) throw new Error('Gate state unknown; refusing to toggle blind');
    const next = !current;
    this.store.setField('gateOn', next, 'optimistic');
    await this.transport.writeCommand(gateBypassFrame(next));
    this.scheduleConfirm();
  }

  /** Switch preset by zero-based index: MIDI PC on c302, ack frame on c304, then state re-request. */
  async selectPreset(index: number): Promise<void> {
    this.assertWrites();
    if (!Number.isInteger(index) || index < 0 || index >= PRESET_COUNT) throw new RangeError(`bad preset index ${index}`);
    this.store.setField('activePreset', index, 'optimistic');
    await this.transport.writeMidi(programChange(index));
    await new Promise((r) => setTimeout(r, 50));
    await this.transport.writeCommand(PRESET_CHANGE_ACK);
    this.scheduleConfirm();
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
