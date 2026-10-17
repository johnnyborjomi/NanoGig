/**
 * State sync engine: owns every transition from raw c305 packets to store
 * fields.
 *
 *   connect → metadata dump (names + full state) → current-state dump
 *   preset-changed event → set active preset, confirm with a state dump
 *   bypass-changed event → state dump at once (the notice names no block)
 *   unknown event / knob burst → debounced state dump
 *   encoder turn → capture / IR name from the cached lists, then a debounced dump
 *   expression telemetry → store only (position, values)
 *
 * Confirm flow (ported from the NanoGig Screen firmware, 2026-09-27): every state request's
 * send time is queued, so a dump is known to answer a request older than a tile tap made
 * meanwhile and cannot undo that tap; one preset select is in flight at a time and the newest
 * target goes out on its ack, so fast taps never make the pedal load every preset in between;
 * a state request inside the minimum gap is retried at the end of the gap, never dropped.
 *
 * Both dump replies share one schema (the metadata reply is the state message
 * with the capture/preset/IR lists included), so every completed message goes
 * through the same handler: apply names if preset records are present, apply
 * state if state fields are present.
 *
 * Fast start: when names are already known (from earlier in the session or the
 * persistent metadata cache) the link goes straight to the small state dump and
 * is `ready` within a second. The 6 s metadata stream is NOT re-read by default:
 * the pedal sends notifications in order, so while it streams the dump every
 * footswitch event queues behind it and the screen is deaf for the duration.
 * Names are re-read only when the state dump contradicts the cache (the active
 * preset's capture / IR differ from its cached record) or on Menu → Refresh.
 *
 * Writes (FX toggle, preset switch) are gated behind `writesEnabled`, off by
 * default, optimistic, and confirmed by a follow-up state dump.
 */
import {
  decodeCurrentState,
  decodeEvent,
  decodeMetadata,
  describeDeviceSettings,
  inferActivePreset,
  type CurrentState,
  type Metadata, type ExpressionAssignments, EMPTY_EXPRESSION_VALUES } from '../protocol/decode';
import {
  CURRENT_STATE_REQUEST,
  DEVICE_SETTINGS_REQUEST,
  FX_SLOTS,
  METADATA_DUMP_REQUEST,
  PRESET_CHANGE_ACK,
  BLE_MIDI_STRATEGIES,
  BLE_SELECT_STRATEGY,
  PRESET_COUNT,
  TUNER_OFF,
  TEMPO_MAX_BPM,
  TEMPO_MIN_BPM,
  TUNER_REFERENCE_MAX_HZ,
  TUNER_REFERENCE_MIN_HZ,
  WEB_MIDI_STRATEGY,
  cabIrSlotFrame,
  captureBypassFrame,
  expressionAssignmentsRequest,
  captureSelectFrame,
  fxBlockBypassFrame,
  gateBypassFrame,
  midiStrategyById,
  outputsMuteFrame,
  tempoExitFrame,
  tempoSetFrame,
  presetSelectFrame,
  programChange,
  tunerOnFrame,
  type FxSlot,
  type MidiStrategy,
} from '../protocol/frames';
import { expressionAssignmentsWrite, outputLevelFrame, sameExpressionAssignments } from '../protocol/edit';
import { toHex } from '../protocol/hex';
import { MSG, MessageAssembler, classifyPacket, isTunerPitchPacket, parseFrameHeader, splitTrailer } from '../protocol/reassembly';
import type { ExpressionWriteState, Store } from '../state/store';
import { lookupFxModel, type FxModelsBySlot } from '../protocol/models';
import type { LogDirection, NotifyPacket, Transport } from '../transport/types';
import type { MidiOut } from '../transport/webmidi';
import { metadataFingerprint, type MetadataCache } from './metadata-cache';
import { EditController, writtenSince } from './editor';

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
  /** Persistent preset/capture/IR names: applied at connect, refreshed in the background. */
  metadataCache?: MetadataCache | null;
  /**
   * With cached names, re-read them silently once the pedal has sent nothing for this long
   * (ms; 0 = never). Bounded cost: a footswitch press during the ~6 s stream lags until it ends.
   */
  idleNamesRefreshMs?: number;
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
  /** Fingerprint of the metadata last written to (or read from) the cache. */
  private cachedFingerprint: string | null = null;
  /** Check the next state dump against the cached names (set at connect and after preset changes). */
  private validateNamesOnNextState = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Device settings (outputs mute) are read once per link, after the first state dump. */
  private settingsRequestedThisLink = false;
  /** Pending outputs-mute write waiting for the pedal's 0x44 ack. */
  private muteWaiter: { muted: boolean; resolve: () => void } | null = null;
  private unsubs: (() => void)[] = [];
  /** MIDI delivery that the device confirmed (or the pinned one). */
  private midiStrategy: MidiStrategy | null = null;
  private midiPinned = false;
  private presetWaiters: { index: number; resolve: (ok: boolean) => void }[] = [];
  /** Send time of every outstanding state request, oldest first: a dump answers the oldest one, so we know how old its picture is. */
  private stateRequestTimes: number[] = [];
  /** A state request that fell inside the minimum gap, waiting for the end of the gap. */
  private stateGapTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the metadata dump was requested: the state it embeds is that old. */
  private metadataRequestedAt = 0;
  /** When each block was last written from here: a dump requested before that cannot undo the tap. */
  private readonly writtenAt = { fx: { pre1: 0, pre2: 0, post1: 0, post2: 0, post3: 0 } as Record<FxSlot, number>, gate: 0, capture: 0, cab: 0, outputLevel: 0 };
  /** Preset select the user asked for last: shown at once; a dump that still reports an older preset does not undo it. */
  private pendingPreset: number | null = null;
  private pendingPresetSince = 0;
  /** One select on the wire at a time; the newest pending target goes out when it is acked. */
  private selectInflight = false;
  private selectSent: number | null = null;
  private selectAckWaiter: (() => void) | null = null;
  private lastSelectAt = 0;
  private readonly opts: Required<EngineOptions>;
  /** FX models / parameters, capture / IR / gate edits, the library and preset rename (Edit mode). */
  readonly edit: EditController;

  /** Minimum gap between two state requests: a select's notices ask twice; one dump is enough. */
  private static readonly STATE_MIN_GAP_MS = 200;
  /** A pending preset target that nothing confirms this long is dropped (the pedal ignored the select). */
  private static readonly PENDING_PRESET_TIMEOUT_MS = 2500;
  /** The pedal acks a select in ~100 ms; past this the next target goes out anyway. */
  private static readonly SELECT_ACK_TIMEOUT_MS = 400;
  /** No cached-names check this soon after a select: the pedal may still be loading the preset. */
  private static readonly SELECT_SETTLE_MS = 1500;

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
      metadataCache: opts.metadataCache ?? null,
      idleNamesRefreshMs: opts.idleNamesRefreshMs ?? 60_000,
    };
    this.midiStrategy = midiStrategyById(this.opts.midiStrategy);
    this.midiPinned = this.midiStrategy !== null;
    this.store.patch({ transportName: transport.name, writesEnabled: this.opts.writesEnabled });
    this.edit = new EditController({
      transport,
      store,
      writesEnabled: () => this.opts.writesEnabled,
      log: (dir, text, hex) => this.log(dir, text, hex),
      confirm: (delayMs) => this.scheduleConfirm(delayMs),
      metadata: () => this.metadata,
      metadataChanged: (md) => {
        this.metadata = md;
        this.publishNames(md, 'metadata');
        this.updateSlotKnowledge(Date.now());
        this.persistMetadata(md);
      },
      refreshNames: () => void this.requestMetadata({ silent: true }).catch((err) => this.log('warn', `Metadata refresh failed: ${(err as Error).message}`)),
      lastState: () => this.lastState,
      reloadPreset: async () => {
        const i = this.store.get().activePreset.value;
        if (i !== null) await this.selectPreset(i);
      },
    });
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
    this.edit.dispose();
    for (const t of [this.unknownEventTimer, this.metadataTimer, this.confirmTimer, this.idleTimer, this.stateGapTimer, this.expAssignTimer, this.tempoWriteTimer, this.tempoSettleTimer]) if (t) clearTimeout(t);
  }

  private log(dir: LogDirection, text: string, hex?: string) {
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
      this.validateNamesOnNextState = false;
      this.stopIdleTimer();
      this.stateRequestInFlightSince = 0; // never coalesce the first request of a new link
      this.stateRequestTimes = [];
      if (this.stateGapTimer) clearTimeout(this.stateGapTimer);
      this.stateGapTimer = null;
      this.settingsRequestedThisLink = false;
      this.tunerOverlayOpen = false;
      this.expAssignReset();
      this.edit.reset();
      this.pendingPreset = null;
      this.selectAckWaiter?.();
      this.settlePresetWaiters(-1);
      this.settleMuteWaiter();
      if (status === 'disconnected' || status === 'reconnecting') this.store.clearDeviceState();
    }
  }

  /**
   * Full sync. First link with nothing known: metadata (names + state), then a fresh state
   * dump. Names already known (session or persistent cache): just the state dump, so the
   * screen is live at once; the names are checked against it (see `validateCachedNames`).
   */
  async startSync(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    this.store.patch({ lastError: null });
    try {
      if (!this.metadata && !this.opts.alwaysRefreshMetadata) this.restoreCachedMetadata();
      if (!this.metadata || this.opts.alwaysRefreshMetadata) {
        await this.requestMetadata();
      } else {
        // Names carried over from an earlier link (or the persistent cache) may have been renamed
        // in Cortex Cloud meanwhile: treat them as provisional so the staleness check and the
        // idle refresh apply to this link too, not only to the first one after a page load.
        this.publishNames(this.metadata, 'cache');
        this.log('info', 'Preset names already known; reading state only (Menu → Refresh re-reads them)');
        this.validateNamesOnNextState = true;
        await this.requestState();
      }
    } catch (err) {
      this.store.patch({ syncPhase: 'error', lastError: (err as Error).message });
      this.log('error', `Sync failed: ${(err as Error).message}`);
    }
  }

  /** Apply the persistent cache (if any) as provisional names, before the pedal has said anything. */
  private restoreCachedMetadata(): void {
    const cache = this.opts.metadataCache;
    if (!cache) return;
    const md = cache.load();
    if (!md || md.presetRecordCount < MIN_PRESET_RECORDS) return;
    this.metadata = md;
    this.cachedFingerprint = metadataFingerprint(md);
    this.publishNames(md, 'cache');
    this.log('info', `Preset names restored from the cache (${md.presetRecordCount} presets, ${md.captures.length} captures, ${md.irs.length} IRs)`);
  }

  /** Write the metadata to the persistent cache when it differs from what is stored. */
  private persistMetadata(md: Metadata): void {
    const cache = this.opts.metadataCache;
    if (!cache) return;
    const fp = metadataFingerprint(md);
    if (fp === this.cachedFingerprint) return;
    cache.save(md);
    this.cachedFingerprint = fp;
    this.log('info', 'Preset names changed on the pedal; cache updated');
  }

  /**
   * Request the metadata dump. `silent` keeps the sync phase as it is (refresh of names that
   * are already on screen); otherwise the UI shows "Loading presets…" and a state dump follows
   * once the reply completes (or times out). Either way the pedal is busy streaming for ~6 s
   * and footswitch events arrive only after it.
   */
  async requestMetadata(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.transport.status !== 'connected') return;
    this.stopIdleTimer();
    if (!opts.silent) this.store.patch({ syncPhase: 'metadata' });
    else this.store.patch({ namesRefreshing: true });
    this.awaitingMetadata = true;
    this.metadataRequestedAt = Date.now();
    if (this.metadataTimer) clearTimeout(this.metadataTimer);
    this.metadataTimer = setTimeout(() => {
      if (!this.awaitingMetadata) return;
      this.awaitingMetadata = false;
      this.store.patch({ namesRefreshing: false });
      this.log('warn', opts.silent ? 'No complete metadata reply; keeping the known preset names' : 'No complete metadata reply; continuing with current-state dump');
      if (!opts.silent) void this.requestState();
    }, this.opts.metadataTimeoutMs);
    await this.transport.writeCommand(METADATA_DUMP_REQUEST);
  }

  /**
   * Menu → Refresh: re-read the preset names and then the state. Names that are already on
   * screen stay while the pedal streams (silent mode); only a screen without names shows the
   * "Loading presets…" phase. A fresh state dump follows the metadata reply either way.
   */
  async refresh(): Promise<void> {
    const silent = this.store.get().presetNames.source !== 'none';
    await this.requestMetadata({ silent });
  }

  /**
   * Idle refresh: (re)arm after any pedal activity. Fires once the pedal has been quiet for
   * `idleNamesRefreshMs`, only while names still come from the cache and the setting is on.
   * Nobody is playing when the pedal has sent nothing for a minute, so the ~6 s stream, which
   * holds back footswitch events, is least likely to be noticed then.
   */
  private armIdleTimer(): void {
    this.stopIdleTimer();
    const ms = this.opts.idleNamesRefreshMs;
    if (!ms || this.transport.status !== 'connected') return;
    if (this.store.get().presetNames.source !== 'cache' || this.awaitingMetadata) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const s = this.store.get();
      if (!s.autoRefreshNames || s.presetNames.source !== 'cache' || this.awaitingMetadata || this.transport.status !== 'connected') return;
      this.log('info', `Pedal idle for ${Math.round(ms / 1000)} s; re-reading the preset names in the background`);
      void this.requestMetadata({ silent: true }).catch((err) => this.log('warn', `Metadata refresh failed: ${(err as Error).message}`));
    }, ms);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Request the current-state dump. A request inside the minimum gap after the previous one is
   * not dropped but sent at the end of the gap (a dropped one cost a whole tile toggle on the
   * screen firmware: the confirming dump never came). A reply ends the gap early.
   */
  async requestState(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    const now = Date.now();
    const wait = this.stateRequestInFlightSince + SyncEngine.STATE_MIN_GAP_MS - now;
    if (wait > 0) {
      if (!this.stateGapTimer) {
        this.stateGapTimer = setTimeout(() => {
          this.stateGapTimer = null;
          void this.requestState();
        }, wait);
      }
      return;
    }
    this.stateRequestInFlightSince = now;
    this.stateRequestTimes.push(now);
    if (this.stateRequestTimes.length > 8) this.stateRequestTimes.shift();
    if (this.store.get().syncPhase !== 'ready') this.store.patch({ syncPhase: 'state' });
    await this.transport.writeCommand(CURRENT_STATE_REQUEST);
  }

  /**
   * Request the device-settings message (`06 C0 08 03 41 00 00 00`, type 0x42 reply). Cortex
   * Cloud sends it at every connect. The reply carries the outputs 1/2 mute (field 16) and is
   * logged in full since the other fields are still being mapped. Read-only, not gated.
   */
  async requestDeviceSettings(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    await this.transport.writeCommand(DEVICE_SETTINGS_REQUEST);
  }

  // -------------------------------------------------------------------------
  // Inbound packets
  // -------------------------------------------------------------------------

  private onPacket(pkt: NotifyPacket) {
    // A pitch reading is a complete tiny message (START|END header); with the live tuner on it
    // can arrive while a metadata stream is being reassembled and must not be taken as a fragment.
    if (isTunerPitchPacket(pkt.data)) {
      this.onEvent(pkt);
      return;
    }
    const kind = classifyPacket(pkt.data, this.assembler.open);
    switch (kind) {
      case 'empty':
        return;
      case 'fx-param-reply':
      case 'cab-param-reply':
        // FX parameters (0x8A) and IR settings (0x60) replies: the editor's reads.
        this.onSingleMessage(pkt);
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
      if (msgType !== null && this.edit.onMessage(msgType, payload, toHex(pkt.data))) {
        this.armIdleTimer();
        return;
      }
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
    if (msgType !== null && msgType !== MSG.DUMP && this.edit.onMessage(msgType, payload, toHex(payload.subarray(0, 32)))) return;
    if (msgType !== null && msgType !== MSG.DUMP) {
      this.log('warn', `Multi-packet message of unexpected type 0x${msgType.toString(16)} (${body.length} B)`, toHex(payload.subarray(0, 32)));
    }
    this.handleDump(payload, meta);
  }

  private onEvent(pkt: NotifyPacket) {
    const ev = decodeEvent(pkt.data);
    this.armIdleTimer(); // any pedal activity restarts the idle clock
    if (ev.kind === 'tuner') {
      // ~30/s while a note sounds: one store update per reading, nothing logged. A reading
      // also proves the pedal's tuner is running, however it was started (footswitch or app).
      const t = this.store.get().tuner;
      if (!t.on) {
        // A reading in flight when we wrote tuner-off does not mean the pedal is still tuning.
        if (pkt.at - this.tunerOffSentAt < SyncEngine.TUNER_OFF_GRACE_MS) return;
        this.log('info', 'Tuner running on the pedal', toHex(pkt.data));
      }
      this.store.patch({ lastEventAt: pkt.at, tuner: { ...t, on: true, reading: ev.reading, readingAt: pkt.at } });
      return;
    }
    if (ev.kind === 'expression') {
      // ~20/s while the pedal moves, with a values event alongside: one update each, nothing logged.
      const x = this.store.get().expression;
      this.store.patch({ lastEventAt: pkt.at, expression: { ...x, position: ev.position, movedAt: pkt.at } });
      return;
    }
    if (ev.kind === 'expression-values') {
      const x = this.store.get().expression;
      this.store.patch({ lastEventAt: pkt.at, expression: { ...x, values: ev.values, valuesAt: pkt.at } });
      return;
    }
    this.store.patch({ lastEventAt: pkt.at });
    switch (ev.kind) {
      case 'program-change':
        this.log('info', `Preset changed → ${ev.preset + 1} (${ev.shape})`, toHex(pkt.data));
        // The pedal's own word: it settles a matching select, and a footswitch press wins over a
        // target nothing is in flight for. A different preset reported while a select is still
        // out belongs to that select (MIDI fallback path); the newer target follows on its ack.
        if (ev.preset === this.pendingPreset || !this.selectInflight) this.pendingPreset = null;
        if (this.store.get().activePreset.value !== ev.preset) this.expAssignTries = 0;
        this.store.setField('activePreset', ev.preset, 'event', pkt.at);
        // A freshly loaded preset is the one moment its capture / IR should match the cached record.
        if (this.store.get().presetNames.source === 'cache') this.validateNamesOnNextState = true;
        if (ev.assignments) this.store.setField('footswitches', ev.assignments, 'event', pkt.at);
        this.settlePresetWaiters(ev.preset);
        this.scheduleConfirm(150);
        // Whether a preset change on the pedal ends its tuner is unknown: re-arm the big tuner to be safe.
        if (this.tunerOverlayOpen) void this.writeTunerOn().catch((err) => this.log('warn', `Tuner re-arm failed: ${(err as Error).message}`));
        return;
      case 'bypass-changed':
        // The notice names no block, so the state is read right away: a block toggled on the pedal
        // or over MIDI used to show ~0.5 s late behind a debounce, while the native app is instant
        // (screen firmware finding 2026-09-27). The minimum gap absorbs bursts. After our own select
        // the notice comes ~50 ms before the ack: read now unless a newer target waits for the ack.
        this.log('info', 'Bypass changed on device; re-reading state', toHex(pkt.data));
        if (!this.selectInflight || this.pendingPreset === this.selectSent) this.scheduleConfirm(0);
        return;
      case 'expression-assignments': {
        const preset = this.expAssignRequested;
        if (this.expAssignTimer) clearTimeout(this.expAssignTimer);
        this.expAssignTimer = null;
        this.expAssignRequested = null;
        const ranges = Object.entries(ev.assignments.ranges).map(([t, r]) => `${t} ${r.min}–${r.max}${r.inverted ? ' inverted' : ''}`);
        const bypasses = Object.entries(ev.assignments.bypasses).map(([t, b]) => `${t} on / off (${b.mode}${b.delayMs ? `, ${b.delayMs} ms` : ''}${b.inverted ? ', inverted' : ''}${b.latch ? ', latch' : ''})`);
        const all = [...ranges, ...bypasses];
        this.log('info', `Expression assignments${preset !== null ? ` of preset ${preset + 1}` : ''}: ${all.length ? all.join(', ') : 'none'}`, toHex(pkt.data));
        // The read-back of our own write: "saved" when the pedal has what was written.
        const verify = this.expVerify !== null && this.expVerify.preset === preset ? this.expVerify : null;
        if (verify) {
          this.expVerify = null;
          const same = sameExpressionAssignments(verify.assignments, ev.assignments);
          if (!same) this.log('warn', `Expression assignments of preset ${verify.preset + 1} differ from what was written`);
          this.setExpWrite(verify.preset, same ? 'saved' : 'mismatch');
          // Shown elsewhere now, or edited again since: the list on screen stays.
          if (preset !== this.store.get().activePreset.value || this.expWriteNext?.preset === preset) {
            this.expAssignTick();
            return;
          }
        } else if (this.expWriteNext !== null && this.expWriteNext.preset === preset) {
          return; // an edit waits to be written: it wins over what the pedal had
        }
        const x = this.store.get().expression;
        // Values belong to a preset's targets: a new preset starts without the old ones.
        const values = preset === x.assignmentsPreset ? x.values : EMPTY_EXPRESSION_VALUES;
        // A plain read (a reload, the save light out): what the pedal has now, no longer our write's result.
        const write = !verify && x.write?.preset === preset ? null : x.write;
        this.store.patch({ expression: { ...x, assignments: ev.assignments, assignmentsPreset: preset, values, valuesAt: preset === x.assignmentsPreset ? x.valuesAt : null, write } });
        this.expAssignTick();
        return;
      }
      case 'expression-assign-ack':
        this.log('info', 'Expression assignment write acknowledged', toHex(pkt.data));
        return;
      case 'tuner-ack': {
        // The pedal reports its tuner state (echoing our write, or its own footswitch tuner):
        // mirror it, nothing to re-read (the preset is untouched).
        this.log('info', `Tuner ${ev.on ? 'on' : 'off'} reported by the pedal${ev.referenceHz !== null ? ` · ${ev.referenceHz} Hz` : ''}${ev.on ? (ev.muted ? ' · muted' : ' · sound on') : ''}`, toHex(pkt.data));
        if (!ev.on) this.tunerOverlayOpen = false; // the view follows the pedal's exit; nothing to re-arm later
        const t = this.store.get().tuner;
        this.store.patch({
          tuner: {
            ...t,
            on: ev.on,
            // The pedal's own mute toggle (footswitch while tuning) arrives as a report too: mirror it.
            muted: ev.on ? ev.muted : t.muted,
            referenceHz: ev.referenceHz ?? t.referenceHz,
            reading: ev.on ? t.reading : null,
            readingAt: ev.on ? t.readingAt : null,
          },
        });
        return;
      }
      case 'tap-tempo':
        // One message per tap with the running tempo; the exit carries the final value. The exit
        // is not always followed by a change notice, so the tempo is taken from the message and
        // the state re-read (screen firmware finding 2026-09-26).
        this.log('info', ev.active ? `Tap tempo: ${Math.round(ev.bpm)} BPM` : `Tap tempo left at ${Math.round(ev.bpm)} BPM; re-reading state`, toHex(pkt.data));
        this.store.setField('tempo', ev.bpm, 'event', pkt.at);
        this.store.patch({ tapTempo: ev.active });
        if (!ev.active) this.scheduleConfirm(150);
        return;
      case 'preset-select-ack':
        // The pedal's reply to a c304 preset select (2026-09-19). Cortex Cloud requests the
        // state right after it; field 13 there is what settles the switch.
        this.log('info', 'Preset select acknowledged; re-reading state', toHex(pkt.data));
        if (this.selectAckWaiter) this.selectAckWaiter(); // the select loop confirms, or sends the newer target
        else this.scheduleConfirm(0);
        return;
      case 'settings':
        this.log('info', `Device settings: outputs 1/2 ${ev.settings.outputsMuted ? 'muted' : 'on'} · ${describeDeviceSettings(ev.settings)}`, toHex(pkt.data));
        this.store.setField('outputsMuted', ev.settings.outputsMuted, 'dump', pkt.at);
        return;
      case 'outputs-mute-ack': {
        const w = this.muteWaiter;
        this.log('info', w ? `Outputs 1/2 ${w.muted ? 'muted' : 'unmuted'}: acknowledged by the pedal` : 'Outputs-mute ack without a pending write', toHex(pkt.data));
        if (w) this.store.setField('outputsMuted', w.muted, 'event', pkt.at);
        this.settleMuteWaiter();
        // Confirm against the pedal's own report (settings field 16), like every other write.
        setTimeout(() => void this.requestDeviceSettings().catch(() => {}), this.opts.confirmDelayMs);
        return;
      }
      case 'control':
        // Knobs (0x1A) and expression (0x40) change nothing on screen. The footswitch encoders
        // (0x1C, same `18 <selector> 20 <value>` shape as our slot-select writes) scroll through
        // captures / cabs, so the names must be re-read; debounced because a rotation is a burst.
        // Knob events (0x1A) may also carry tap-tempo / tempo changes, so re-read after a burst.
        if (ev.msgType === MSG.ENCODER) this.showEncoderFromCache(ev.selector, ev.value, pkt.at);
        if (ev.msgType === MSG.ENCODER || ev.msgType === MSG.KNOB) this.scheduleDebouncedRefresh();
        return;
      case 'dirty':
        // The pedal's save light (0x73, field 3). Also the ack to slot writes and sent after footswitch presses,
        // so the state is read again as before.
        this.noteDirty(ev.dirty);
        this.store.setField('presetDirty', ev.dirty, 'dump', pkt.at);
        this.log('info', ev.dirty ? 'The preset has unsaved changes' : 'No unsaved changes', toHex(pkt.data));
        if (this.opts.refreshOnUnknownEvent) this.scheduleDebouncedRefresh();
        return;
      case 'unknown':
        // Undocumented: re-read the state, it may have changed.
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
        this.publishNames(md, 'metadata');
        this.updateSlotKnowledge(Date.now());
        this.store.patch({ lastMetadataAt: Date.now() });
        this.persistMetadata(md);
      } else {
        this.log('warn', `Only ${md.presetRecordCount} preset records; keeping previous names`);
      }
      if (this.awaitingMetadata) {
        this.awaitingMetadata = false;
        this.store.patch({ namesRefreshing: false });
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
    // The state embedded in a metadata reply is as old as the request (~6 s of streaming). On a
    // link that is already live, applying it would flip the screen back to whatever preset was
    // active before a footswitch press made during the stream; the fresh state dump requested
    // above supersedes it anyway. Only the very first sync uses it, to get on screen sooner.
    if (md.presetRecordCount > 0 && this.store.get().syncPhase === 'ready') {
      this.log('info', 'Ignoring the state embedded in the metadata reply (a fresh state dump follows)');
      return;
    }
    // The picture in a dump is as old as the request it answers: the oldest outstanding one.
    const requestedAt = md.presetRecordCount > 0 ? this.metadataRequestedAt : (this.stateRequestTimes.shift() ?? 0);
    this.applyState(state, requestedAt);
  }

  /**
   * Footswitch encoder turned on the pedal (`18 <selector> 20 <value>`, same shape as our
   * slot-select writes): the capture / IR it scrolled to is in the cached metadata lists, so show
   * the name at once instead of after the debounced dump (screen firmware, 2026-09-27).
   */
  private showEncoderFromCache(selector: number | null, value: number, at: number): void {
    const md = this.metadata;
    if (selector === null || !this.lastState) return;
    if (selector === 4 && md && value >= 0 && value < md.captures.length && md.captures[value]!.name) {
      this.store.setField('captureName', md.captures[value]!.name, 'event', at);
      this.store.setField('captureOn', true, 'event', at);
    } else if (selector === 3 && md && value >= 1 && value <= md.irs.length && (md.irs[value - 1]!.shortName || md.irs[value - 1]!.fullName)) {
      const ir = md.irs[value - 1]!;
      this.store.setField('irName', ir.shortName || ir.fullName, 'event', at);
      this.store.setField('cabOn', true, 'event', at);
    } else if (selector === 3 && value === 0) {
      this.store.setField('cabOn', false, 'event', at);
    } else if (selector === 1 && value === 0) {
      this.store.setField('captureOn', false, 'event', at);
    } else {
      return;
    }
    this.log('info', `Encoder: selector ${selector} → ${value} (shown from the cached names; the dump confirms)`);
  }

  /** A select is pending until the pedal reports its target, or for a bounded time if it never does. */
  private pendingPresetActive(): boolean {
    if (this.pendingPreset === null) return false;
    if (Date.now() - this.pendingPresetSince > SyncEngine.PENDING_PRESET_TIMEOUT_MS) {
      this.pendingPreset = null;
      return false;
    }
    return true;
  }

  /** A preset select is on the wire, unconfirmed, or the pedal may still be loading its target. */
  private presetSwitching(): boolean {
    return this.pendingPresetActive() || this.selectInflight || Date.now() - this.lastSelectAt < SyncEngine.SELECT_SETTLE_MS;
  }

  /**
   * Cheap staleness check for cached names: the state dump names the active preset's capture
   * and IR, and the cached preset record says what they should be. A mismatch right after a
   * connect or a preset change means the pedal's presets changed since the cache was written,
   * so the metadata dump is re-read (silently; names stay on screen meanwhile). A rename that
   * keeps the same capture and IR is not detectable this way: Menu → Refresh covers it.
   */
  private validateCachedNames(state: CurrentState): void {
    if (!this.validateNamesOnNextState) return;
    // Right after a select the pedal may still be loading: its capture name then contradicts the
    // record and the ~6 s metadata stream would follow, freezing the screen (seen on the screen
    // firmware during fast preset taps). Check the next dump once the switch has settled instead.
    if (this.presetSwitching()) return;
    this.validateNamesOnNextState = false;
    if (this.store.get().presetNames.source !== 'cache' || !this.metadata || state.activePreset === null || this.awaitingMetadata) return;
    const rec = this.metadata.presets[state.activePreset];
    if (!rec) return;
    const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
    const capOk = norm(rec.captureName) === norm(state.capture?.name);
    const irOk = norm(rec.irShortName) === norm(state.ir?.shortName);
    if (capOk && irOk) return;
    this.log(
      'info',
      `Cached names look stale (preset ${state.activePreset + 1}: capture "${state.capture?.name ?? ''}" / IR "${state.ir?.shortName ?? ''}" vs cached "${rec.captureName}" / "${rec.irShortName}"); re-reading the preset list`,
    );
    void this.requestMetadata({ silent: true }).catch((err) => this.log('warn', `Metadata refresh failed: ${(err as Error).message}`));
  }

  /** Preset names and the capture slots' names, from a metadata read (or its cache). */
  private publishNames(md: Metadata, source: 'metadata' | 'cache'): void {
    this.store.setField('presetNames', md.presets.map((p) => p.name), source);
    this.store.patch({ captureSlots: md.captures.map((c) => c.name), irSlots: md.irs.map((r) => r.shortName || r.fullName) });
  }

  private applyState(state: CurrentState, requestedAt = 0) {
    const at = Date.now();
    const prev = this.store.get();
    this.lastState = state;
    this.stateRequestInFlightSince = 0; // reply received; the next request may go out immediately
    // Edits made after this dump was requested (model, volume, threshold, capture / IR slot) keep their value.
    const editHeld = this.edit.filterState(state, requestedAt);
    if (this.stateGapTimer) {
      clearTimeout(this.stateGapTimer);
      this.stateGapTimer = null;
      void this.requestState(); // a request was waiting for the gap: it can go now
    }
    // Blocks written after this dump was requested keep their tapped state (the dump shows the
    // pedal before the write); one more dump, requested after the write, confirms them.
    let stale = false;
    if (state.fxOn) {
      const fxOn = { ...state.fxOn };
      for (const slot of FX_SLOTS) {
        if (writtenSince(this.writtenAt.fx[slot], requestedAt)) {
          fxOn[slot] = prev.fxOn.value[slot] ?? fxOn[slot];
          stale = true;
        }
      }
      this.store.setField('fxOn', fxOn, stale ? 'optimistic' : 'dump', at);
    }
    const models = {} as FxModelsBySlot;
    for (const slot of FX_SLOTS) models[slot] = lookupFxModel(state.fxModelIds[slot]);
    this.store.setField('fxModels', models, 'dump', at);
    this.noteDirty(state.dirty);
    this.store.setField('presetDirty', state.dirty, 'dump', at);
    const gateStale = writtenSince(this.writtenAt.gate, requestedAt);
    this.store.setField('gateOn', gateStale ? prev.gateOn.value : state.gateOn, gateStale ? 'optimistic' : 'dump', at);
    const cabStale = writtenSince(this.writtenAt.cab, requestedAt);
    this.store.setField('cabOn', cabStale ? prev.cabOn.value : state.cabOn, cabStale ? 'optimistic' : 'dump', at);
    // A preview plays: its name stands (the dump may still name the capture underneath).
    const preview = this.store.get().edit.capturePreview;
    if (preview && preview.preset === state.activePreset) this.store.setField('captureName', preview.name, 'optimistic', at);
    else this.store.setField('captureName', state.capture?.name || null, 'dump', at); // '' (no capture) → null
    // Capture on/off follows field 11 (rotary position, 0/absent = bypassed) as in the web editor.
    // Field 32.1 ("enabled") is NOT used: hardware dumps show it stuck at 1 after a bypass
    // (2026-09-13) and at 0 with position 4 (2026-09-12), so it means something else.
    const captureStale = writtenSince(this.writtenAt.capture, requestedAt);
    const captureOn = captureStale ? prev.captureOn.value : (state.captureSlot ?? 0) > 0;
    this.store.setField('captureOn', captureOn, captureStale ? 'optimistic' : 'dump', at);
    if (stale || gateStale || cabStale || captureStale || editHeld) this.scheduleConfirm();
    this.store.setField('captureSlot', state.captureSlot ?? 0, editHeld ? 'optimistic' : 'dump', at);
    if (state.captureBank !== null) this.store.setField('captureBank', state.captureBank, editHeld ? 'optimistic' : 'dump', at);
    // Field 44 absent = raw 0 (-24 dB): the pedal leaves zero varints out.
    this.store.setField('captureVolume', state.captureVolumeRaw ?? 0, 'dump', at);
    // Fields 3..7 absent = raw 0, as field 44.
    const k = state.amp;
    this.store.setField('amp', { gain: k.gain ?? 0, bass: k.bass ?? 0, mid: k.mid ?? 0, treble: k.treble ?? 0 }, 'dump', at);
    if (!writtenSince(this.writtenAt.outputLevel, requestedAt)) this.store.setField('outputLevel', k.level ?? 0, 'dump', at);
    this.store.setField('gateThreshold', state.gateThresholdRaw, 'dump', at);
    this.store.setField('cabSlot', state.cabOn ? state.cabSlot : null, 'dump', at);
    const irPreview = this.store.get().edit.irPreview;
    if (irPreview && irPreview.preset === state.activePreset) this.store.setField('irName', irPreview.name, 'optimistic', at);
    else this.store.setField('irName', state.ir?.shortName || null, 'dump', at);
    if (state.firmware) this.store.setField('firmware', state.firmware, 'dump', at);
    if (state.footswitchAssignments) this.store.setField('footswitches', state.footswitchAssignments, 'dump', at);
    this.store.setField('tempo', state.tempoBpm, 'dump', at);
    this.store.patch({ tapTempo: state.tapTempoMode });
    // The pedal's saved reference pitch seeds the tuner while the app is not driving it.
    if (state.tunerReferenceHz !== null && !this.store.get().tuner.on && this.store.get().tuner.referenceHz !== state.tunerReferenceHz) {
      this.store.patch({ tuner: { ...this.store.get().tuner, referenceHz: state.tunerReferenceHz } });
    }
    this.updateSlotKnowledge(at);
    // A preset seen for the first time since it loaded: what it shows is what it has saved.
    this.edit.noteSaved(state.activePreset);

    if (state.activePreset !== null) {
      if (prev.activePreset.value !== state.activePreset) this.expAssignTries = 0;
      if (this.pendingPresetActive() && state.activePreset !== this.pendingPreset) {
        // A dump for an earlier select (or from before it): keep showing the target, the next dump settles it.
        this.store.setField('activePreset', this.pendingPreset!, 'optimistic', at);
        this.scheduleConfirm();
      } else {
        if (state.activePreset === this.pendingPreset) this.pendingPreset = null; // confirmed
        this.store.setField('activePreset', state.activePreset, 'dump', at);
      }
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
    this.validateCachedNames(state);
    this.edit.onState();
    this.expAssignTick();
    this.armIdleTimer();
    if (!this.settingsRequestedThisLink) {
      this.settingsRequestedThisLink = true;
      setTimeout(() => void this.requestDeviceSettings().catch((err) => this.log('warn', `Settings request failed: ${(err as Error).message}`)), this.opts.confirmDelayMs);
    }
    const on = FX_SLOTS.map((s) => `${s}=${models[s]?.name ?? 'empty'}:${state.fxOn ? (state.fxOn[s] ? 'on' : 'off') : '?'}`).join(' ');
    this.log(
      'info',
      `State: preset=${state.activePreset === null ? '?' : state.activePreset + 1} ${on} gate=${state.gateOn} cab=${state.cabOn} capture="${state.capture?.name ?? ''}" ir="${state.ir?.shortName ?? ''}"`,
    );
  }

  private scheduleConfirm(delayMs = this.opts.confirmDelayMs) {
    this.armIdleTimer(); // every app-initiated write comes through here: that is activity too
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
    this.writtenAt.fx[slot] = Date.now();
    await this.transport.writeCommand(fxBlockBypassFrame(slot, next));
    this.scheduleConfirm();
  }

  // -------------------------------------------------------------------------
  // Tempo view (ported from the screen firmware, 2026-09-27): the pedal's own tempo screen is its
  // tap tempo mode, so opening the view puts the pedal in that mode and Done takes it out; −/+ are
  // coalesced (instant on screen, one write per 80 ms with the latest value, one confirming dump
  // 600 ms after the last press). Like the tuner it needs no control mode: control mode gates the
  // gig view's preset / block writes only (user's rule, 2026-09-27).
  // -------------------------------------------------------------------------

  private tempoTarget: number | null = null;
  private tempoDirty = false;
  private tempoLastWriteAt = 0;
  private tempoWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private tempoSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TEMPO_WRITE_GAP_MS = 80;
  private static readonly TEMPO_SETTLE_MS = 600;

  /** Tempo view opened from the menu: the pedal enters its tap tempo mode as well. */
  async openTempo(): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    const bpm = Math.round(this.store.get().tempo.value ?? 120);
    this.store.patch({ tapTempo: true });
    const frame = tempoSetFrame(bpm);
    this.log('tx', `Tap tempo mode on · ${bpm} BPM`, toHex(frame));
    await this.transport.writeCommand(frame);
  }

  /** −/+ on the tempo view. Shown at once; the write and the confirming dump are coalesced. */
  stepTempo(delta: number): void {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    const current = this.store.get().tempo.value;
    if (current === null) throw new Error('Tempo unknown; refusing to change it blind');
    const base = this.tempoTarget ?? current;
    const bpm = Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, Math.round(base) + delta));
    this.tempoTarget = bpm;
    this.tempoDirty = true;
    this.store.setField('tempo', bpm, 'optimistic');
    this.store.patch({ tapTempo: true });
    this.flushTempo();
    if (this.tempoSettleTimer) clearTimeout(this.tempoSettleTimer);
    this.tempoSettleTimer = setTimeout(() => {
      this.tempoSettleTimer = null;
      this.tempoTarget = null;
      void this.requestState(); // field 56 confirms
    }, SyncEngine.TEMPO_SETTLE_MS);
  }

  private flushTempo(): void {
    if (!this.tempoDirty || this.tempoTarget === null || this.transport.status !== 'connected') return;
    const wait = this.tempoLastWriteAt + SyncEngine.TEMPO_WRITE_GAP_MS - Date.now();
    if (wait > 0) {
      if (!this.tempoWriteTimer) {
        this.tempoWriteTimer = setTimeout(() => {
          this.tempoWriteTimer = null;
          this.flushTempo();
        }, wait);
      }
      return;
    }
    const bpm = this.tempoTarget;
    this.tempoDirty = false;
    this.tempoLastWriteAt = Date.now();
    const frame = tempoSetFrame(bpm);
    this.log('tx', `Tempo set · ${bpm} BPM`, toHex(frame));
    void this.transport.writeCommand(frame).catch((err) => this.log('warn', `Tempo write failed: ${(err as Error).message}`));
  }

  /**
   * Tempo view closed: the pedal leaves its tap tempo mode (whoever started it) with the latest
   * value; the state re-read confirms. The pedal's own exit needs no echo.
   */
  async closeTempo(): Promise<void> {
    for (const t of [this.tempoWriteTimer, this.tempoSettleTimer]) if (t) clearTimeout(t);
    this.tempoWriteTimer = this.tempoSettleTimer = null;
    const bpm = Math.round(this.tempoTarget ?? this.store.get().tempo.value ?? 120);
    const pending = this.tempoDirty;
    this.tempoTarget = null;
    this.tempoDirty = false;
    if (!this.store.get().tapTempo || this.transport.status !== 'connected') return;
    this.store.patch({ tapTempo: false });
    if (pending) await this.transport.writeCommand(tempoSetFrame(bpm));
    const frame = tempoExitFrame(bpm);
    this.log('tx', `Tap tempo mode off · ${bpm} BPM`, toHex(frame));
    await this.transport.writeCommand(frame);
    this.scheduleConfirm();
  }

  /**
   * Set the preset tempo: the pedal's per-tap message written back (enters its tap tempo mode),
   * then the exit shape so the pedal returns to normal with the new tempo (both found by trial on
   * the pedal with the NanoGig Screen firmware, 2026-09-26). The state re-read (field 56) confirms.
   */
  async setTempo(bpm: number): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    const rounded = Math.round(bpm);
    this.store.setField('tempo', rounded, 'optimistic');
    await this.transport.writeCommand(tempoSetFrame(rounded));
    await this.transport.writeCommand(tempoExitFrame(rounded));
    this.store.patch({ tapTempo: false });
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
    this.writtenAt.capture = Date.now();
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
    this.writtenAt.cab = Date.now();
    if (current) {
      this.store.setField('cabOn', false, 'optimistic');
      await this.transport.writeCommand(cabIrSlotFrame(0));
    } else {
      this.store.setField('cabOn', true, 'optimistic');
      await this.transport.writeCommand(cabIrSlotFrame(slot));
    }
    this.scheduleConfirm();
  }

  private settleMuteWaiter() {
    const w = this.muteWaiter;
    this.muteWaiter = null;
    w?.resolve();
  }

  /**
   * Mute or unmute outputs 1/2 (Cortex Cloud's global "Mute Outputs 1/2", for monitoring
   * through a DAW over USB). Frame captured from Cortex Cloud 2026-09-15; the pedal acks
   * with a type 0x44 message. Resolves on the ack or after the confirm timeout.
   * Not gated by control mode: it is a deliberate switch in Settings, touches no preset,
   * and is the one write the user needs while the pedal is otherwise left alone.
   */
  async setOutputsMuted(muted: boolean): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    this.settleMuteWaiter();
    this.store.setField('outputsMuted', muted, 'optimistic');
    const acked = new Promise<void>((resolve) => {
      this.muteWaiter = { muted, resolve };
    });
    await this.transport.writeCommand(outputsMuteFrame(muted));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.opts.presetConfirmTimeoutMs));
    await Promise.race([acked, timeout]);
    if (this.muteWaiter) {
      this.settleMuteWaiter();
      this.log('warn', `Outputs 1/2 ${muted ? 'mute' : 'unmute'} not acknowledged by the pedal`);
    }
  }

  /**
   * Outputs 1/2 volume (the pedal's LEVEL knob). As the mute: not gated by control mode, it touches no preset.
   * Drags are coalesced: the newest value waits for the write in flight; a state read afterwards confirms.
   */
  setOutputLevel(raw: number): void {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    const v = Math.round(Math.min(255, Math.max(0, raw)));
    this.writtenAt.outputLevel = Date.now();
    this.store.setField('outputLevel', v, 'optimistic');
    this.outputLevelNext = v;
    if (!this.outputLevelBusy) void this.flushOutputLevel();
  }

  private outputLevelNext: number | null = null;
  private outputLevelBusy = false;

  private async flushOutputLevel(): Promise<void> {
    this.outputLevelBusy = true;
    try {
      while (this.outputLevelNext !== null) {
        const v = this.outputLevelNext;
        this.outputLevelNext = null;
        await this.transport.writeCommand(outputLevelFrame(v));
      }
    } catch (err) {
      this.outputLevelNext = null;
      this.log('warn', `Output level write failed: ${(err as Error).message}`);
    } finally {
      this.outputLevelBusy = false;
    }
    this.scheduleConfirm();
  }

  async toggleGate(): Promise<void> {
    this.assertWrites();
    const current = this.store.get().gateOn.value;
    if (current === null) throw new Error('Gate state unknown; refusing to toggle blind');
    const next = !current;
    this.store.setField('gateOn', next, 'optimistic');
    this.writtenAt.gate = Date.now();
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
   * Switch preset by zero-based index. Writes the pedal's own preset-select
   * frame on c304 (Cortex Cloud's path, Bluetooth only) and waits for the
   * device to report the new preset (preset-changed event or state dump field
   * 13). If that is not confirmed, the MIDI deliveries follow: a Program Change
   * over Web MIDI (USB) and the BLE variants, each followed by the ack frame.
   * The first delivery the device confirms is remembered for the session.
   */
  async selectPreset(index: number): Promise<void> {
    this.assertWrites();
    if (!Number.isInteger(index) || index < 0 || index >= PRESET_COUNT) throw new RangeError(`bad preset index ${index}`);
    // Shown at once. While an earlier select is still unacked the target is only remembered: the
    // pedal loads every preset it is asked for (~150 ms each), so fast taps must not queue up.
    this.pendingPreset = index;
    this.pendingPresetSince = Date.now();
    this.expAssignTries = 0;
    // The shown preset loaded again (Discard): assignments edited here are back as saved, read them.
    if (index === this.expEditedPreset) this.expStale = true;
    this.expEditedPreset = null;
    this.store.setField('activePreset', index, 'optimistic');
    this.edit.clearCapturePreview(); // a load puts the preset's own capture back
    this.edit.clearIrPreview();

    if (this.selectInflight) {
      this.log('info', `Preset ${index + 1} held until the pedal acks the select in flight`);
      return;
    }
    await this.sendSelect(index);
  }

  /** Resolves on the pedal's select ack (0x1E), or after a bounded wait if it never comes. */
  private waitForSelectAck(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (this.selectAckWaiter === done) this.selectAckWaiter = null;
        resolve();
      };
      this.selectAckWaiter = done;
      setTimeout(() => {
        if (this.selectAckWaiter === done) done();
      }, SyncEngine.SELECT_ACK_TIMEOUT_MS);
    });
  }

  /** The select (and its fallbacks) for one target; on return, a newer pending target goes out. */
  private async sendSelect(index: number): Promise<void> {
    this.selectInflight = true;
    this.selectSent = index;
    this.lastSelectAt = Date.now();
    try {
      await this.deliverSelect(index);
    } finally {
      this.selectInflight = false;
      this.selectSent = null;
      this.lastSelectAt = Date.now();
      const next = this.pendingPresetActive() ? this.pendingPreset : null;
      if (next !== null && next !== index) void this.sendSelect(next).catch((err) => this.log('warn', `Preset switch failed: ${(err as Error).message}`));
      else this.expAssignTick(); // the switch is through: the tile tracks may need this preset's assignments
    }
  }

  private async deliverSelect(index: number): Promise<void> {
    const midiOut = this.opts.midiOut;
    const all = [BLE_SELECT_STRATEGY, ...(midiOut?.isSupported() ? [WEB_MIDI_STRATEGY] : []), ...BLE_MIDI_STRATEGIES];
    const candidates = this.midiStrategy ? [this.midiStrategy, ...(this.midiPinned ? [] : all.filter((s) => s.id !== this.midiStrategy!.id))] : all;
    for (const strategy of candidates) {
      const confirmed = this.waitForPreset(index);
      const acked = strategy.framing === 'select' ? this.waitForSelectAck() : null;
      try {
        if (strategy.framing === 'select') {
          this.log('tx', `TX c304 [${strategy.id}] preset select`, toHex(presetSelectFrame(index)));
          await this.transport.writeCommand(presetSelectFrame(index));
        } else if (strategy.char === 'web-midi') {
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
        this.selectAckWaiter?.();
        this.settlePresetWaiters(-1);
        continue;
      }
      if (acked) {
        // The pedal acks the c304 select by itself (~100 ms); a newer tap meanwhile supersedes
        // this target, and goes out right away instead of waiting for this one's confirming dump.
        await Promise.race([acked, confirmed]);
        if (this.pendingPresetActive() && this.pendingPreset !== index) return;
        this.scheduleConfirm(0);
      } else {
        // MIDI deliveries: the web editor follows the Program Change with the ack frame.
        await new Promise((r) => setTimeout(r, 50));
        await this.transport.writeCommand(PRESET_CHANGE_ACK).catch((err) => this.log('warn', `ack frame failed: ${(err as Error).message}`));
        this.scheduleConfirm(this.midiStrategy === strategy ? this.opts.confirmDelayMs : 400);
      }
      if (await confirmed) {
        if (this.midiStrategy !== strategy) {
          this.midiStrategy = strategy;
          this.log('info', `Preset switching works via ${strategy.id}; remembering it for this session`);
        }
        return;
      }
      if (this.pendingPresetActive() && this.pendingPreset !== index) return; // superseded while waiting
      this.log('warn', `Preset switch via ${strategy.id} not confirmed by the device`);
      if (this.midiPinned) break;
    }
    this.log(
      'error',
      'Preset switch failed: no delivery was confirmed by the device (Bluetooth select, then MIDI). Check the pedal is on NanOS 2.2.x; on other firmware, USB Web MIDI may still work.',
    );
    if (this.pendingPreset === index) this.pendingPreset = null;
    void this.requestState(); // resync the optimistic value with reality
  }

  // -------------------------------------------------------------------------
  // Tuner (works whenever connected: it changes no preset)
  //
  // Only the full-screen tuner switches the pedal's tuner on. The live tuner in the top bar is
  // passive: it shows whatever the pedal streams, whether the tuner was started here or on the
  // pedal itself, so toggling the setting never changes the pedal's screen. Its one effect on
  // the pedal: with it on, closing the full-screen tuner leaves the pedal in tuner mode.
  // -------------------------------------------------------------------------

  /** Preset whose expression assignments were last requested (the reply carries no index). */
  private expAssignRequested: number | null = null;
  private expAssignTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unanswered assignment requests for the shown preset; after a few the preset is left alone until it changes. */
  private expAssignTries = 0;
  private static readonly EXP_ASSIGN_TIMEOUT_MS = 1500;
  private static readonly EXP_ASSIGN_MAX_TRIES = 3;
  /** The full-screen tuner is open (it may mute; the live tuner never does). */
  private tunerOverlayOpen = false;
  /** When tuner-off was last written; readings still in flight for a moment after are ignored. */
  private tunerOffSentAt = 0;
  /** Only pitch readings trail a tuner-off, for up to ~0.9 s (screen firmware capture 2026-09-27). */
  private static readonly TUNER_OFF_GRACE_MS = 900;

  /**
   * The assignments shown may no longer be the pedal's: edited here, then the preset was loaded again or its save
   * light went out (saved, or the edits dropped by the pedal's EXIT). Read them once more.
   */
  private expStale = false;
  /** The preset whose assignments were written here since it loaded (null: none). */
  private expEditedPreset: number | null = null;

  private noteDirty(dirty: boolean): void {
    if (this.store.get().presetDirty.value === true && !dirty && this.expEditedPreset !== null) {
      this.expEditedPreset = null;
      this.expStale = true;
      this.expAssignTries = 0;
    }
  }

  private expAssignReset(): void {
    this.expStale = false;
    this.expEditedPreset = null;
    if (this.expAssignTimer) clearTimeout(this.expAssignTimer);
    this.expAssignTimer = null;
    this.expAssignRequested = null;
    this.expAssignTries = 0;
    if (this.expWriteTimer) clearTimeout(this.expWriteTimer);
    this.expWriteTimer = null;
    this.expWriteNext = null;
    this.expVerify = null;
  }

  /** An assignment list edited here, waiting for the pause after the last change. */
  private expWriteNext: { preset: number; assignments: ExpressionAssignments } | null = null;
  private expWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Written and to be read back: "saved" once the pedal reports the same list. */
  private expVerify: { preset: number; assignments: ExpressionAssignments } | null = null;
  private static readonly EXP_WRITE_PAUSE_MS = 400;

  private setExpWrite(preset: number, state: ExpressionWriteState): void {
    this.store.patch({ expression: { ...this.store.get().expression, write: { preset, state } } });
  }

  /**
   * The shown preset's expression assignments, as edited in the EXP sheet: on screen at once, written (0x3E, the
   * whole list) after a short pause so a slider drag sends one write, then read back. They are an edit of the preset
   * like the others: Save keeps them, Discard (a reload) drops them.
   */
  setExpressionAssignments(assignments: ExpressionAssignments): void {
    this.assertWrites();
    const preset = this.store.get().activePreset.value;
    if (preset === null) throw new Error('No preset shown');
    // Another preset's edit still waiting (the preset changed under the sheet): it goes first, to its own preset.
    if (this.expWriteNext && this.expWriteNext.preset !== preset) this.flushExpWrite();
    this.expWriteNext = { preset, assignments };
    this.expEditedPreset = preset;
    const x = this.store.get().expression;
    const values = x.assignmentsPreset === preset ? x.values : EMPTY_EXPRESSION_VALUES;
    this.store.patch({ expression: { ...x, assignments, assignmentsPreset: preset, values, write: { preset, state: 'saving' } } });
    if (this.expWriteTimer) clearTimeout(this.expWriteTimer);
    this.expWriteTimer = setTimeout(() => this.flushExpWrite(), SyncEngine.EXP_WRITE_PAUSE_MS);
  }

  private flushExpWrite(): void {
    if (this.expWriteTimer) clearTimeout(this.expWriteTimer);
    this.expWriteTimer = null;
    const w = this.expWriteNext;
    if (!w) return;
    this.expWriteNext = null;
    const frame = expressionAssignmentsWrite(w.preset, w.assignments);
    this.log('tx', `Expression assignments write · preset ${w.preset + 1}`, toHex(frame));
    void this.transport
      .writeCommand(frame)
      .then(() => {
        if (this.expWriteNext?.preset === w.preset) return; // edited again: checked after its own write
        this.expVerify = w;
        this.expAssignTick();
      })
      .catch((err) => {
        this.log('warn', `Expression assignments write failed: ${(err as Error).message}`);
        if (this.expWriteNext?.preset !== w.preset) this.setExpWrite(w.preset, 'failed');
      });
  }

  /**
   * Expression assignments are per preset (Cortex Cloud's 0x3C request, 0x3D reply with no
   * preset number): read them for the shown preset once its select is through (acked and
   * confirmed by a dump; no settle window, it held the tile tracks back by 1.5 s per tap on the
   * screen firmware). One request at a time; a preset that never answers is asked a few times.
   */
  private expAssignTick(): void {
    if (this.transport.status !== 'connected' || this.store.get().syncPhase !== 'ready') return;
    if (this.expAssignRequested !== null) return; // its timeout re-enters here
    // A read-back of our write goes first (and only after the reads sent before the write are answered).
    const verify = this.expVerify;
    const preset = verify ? verify.preset : this.store.get().activePreset.value;
    if (!verify) {
      if (preset === null || this.pendingPresetActive() || this.selectInflight) return;
      if (preset === this.store.get().expression.assignmentsPreset && !this.expStale) return;
      if (this.expAssignTries >= SyncEngine.EXP_ASSIGN_MAX_TRIES) return;
      this.expAssignTries++;
    }
    if (preset === null) return;
    if (!verify) this.expStale = false;
    this.expAssignRequested = preset;
    const req = expressionAssignmentsRequest(preset);
    this.log('tx', `Expression assignments ${verify ? 'check' : 'request'} · preset ${preset + 1}`, toHex(req));
    this.expAssignTimer = setTimeout(() => {
      this.expAssignTimer = null;
      if (this.expAssignRequested === null) return;
      this.log('warn', `Expression assignments request (preset ${this.expAssignRequested + 1}) unanswered`);
      if (this.expVerify?.preset === this.expAssignRequested) {
        this.setExpWrite(this.expVerify.preset, 'unchecked');
        this.expVerify = null;
      }
      this.expAssignRequested = null;
      this.expAssignTick();
    }, SyncEngine.EXP_ASSIGN_TIMEOUT_MS);
    void this.transport.writeCommand(req).catch((err) => {
      this.log('warn', `Expression assignments request failed: ${(err as Error).message}`);
    });
  }

  /** Full-screen tuner opened: tuner on with the current reference and mute; the pedal streams readings. */
  async startTuner(): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    this.tunerOverlayOpen = true;
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, on: true, reading: t.on ? t.reading : null, readingAt: t.on ? t.readingAt : null } });
    await this.writeTunerOn();
  }

  /**
   * Full-screen tuner closed. With the live tuner setting on, the pedal stays in tuner mode
   * (unmuted, so sound passes) and the top bar keeps showing the note; otherwise the pedal's
   * tuner goes off and the reading is cleared.
   */
  async stopTuner(): Promise<void> {
    this.tunerOverlayOpen = false;
    const t = this.store.get().tuner;
    if (this.store.get().liveTuner && t.on && this.transport.status === 'connected') {
      if (t.muted) {
        this.store.patch({ tuner: { ...t, muted: false } });
        await this.writeTunerOn();
      }
      return;
    }
    await this.tunerOff();
  }

  private async tunerOff(): Promise<void> {
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, on: false, reading: null, readingAt: null } });
    if (this.transport.status !== 'connected') return;
    this.log('tx', 'Tuner off', toHex(TUNER_OFF));
    this.tunerOffSentAt = Date.now();
    await this.transport.writeCommand(TUNER_OFF);
  }

  /** Reference pitch in Hz; re-sent as a tuner-on write while the tuner is running (Cortex Cloud does the same on every slider step). */
  async setTunerReference(hz: number): Promise<void> {
    const referenceHz = Math.min(TUNER_REFERENCE_MAX_HZ, Math.max(TUNER_REFERENCE_MIN_HZ, Math.round(hz)));
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, referenceHz } });
    if (t.on) await this.writeTunerOn();
  }

  /** The tuner's mute switch (outputs silent while tuning); re-sent like the reference. */
  async setTunerMute(muted: boolean): Promise<void> {
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, muted } });
    if (t.on) await this.writeTunerOn();
  }

  private async writeTunerOn(): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    const t = this.store.get().tuner;
    const frame = tunerOnFrame(t.referenceHz, t.muted);
    this.log('tx', `Tuner on · ${t.referenceHz} Hz${t.muted ? ' · muted' : ''}`, toHex(frame));
    await this.transport.writeCommand(frame);
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
