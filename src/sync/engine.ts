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
  type Metadata,
} from '../protocol/decode';
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
  TUNER_REFERENCE_MAX_HZ,
  TUNER_REFERENCE_MIN_HZ,
  WEB_MIDI_STRATEGY,
  cabIrSlotFrame,
  captureBypassFrame,
  captureSelectFrame,
  fxBlockBypassFrame,
  gateBypassFrame,
  midiStrategyById,
  outputsMuteFrame,
  presetSelectFrame,
  programChange,
  tunerOnFrame,
  type FxSlot,
  type MidiStrategy,
} from '../protocol/frames';
import { toHex } from '../protocol/hex';
import { MSG, MessageAssembler, classifyPacket, isTunerPitchPacket, parseFrameHeader, splitTrailer } from '../protocol/reassembly';
import type { Store } from '../state/store';
import { lookupFxModel, type FxModelsBySlot } from '../protocol/models';
import type { LogDirection, NotifyPacket, Transport } from '../transport/types';
import type { MidiOut } from '../transport/webmidi';
import { metadataFingerprint, type MetadataCache } from './metadata-cache';

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
      metadataCache: opts.metadataCache ?? null,
      idleNamesRefreshMs: opts.idleNamesRefreshMs ?? 60_000,
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
    for (const t of [this.unknownEventTimer, this.metadataTimer, this.confirmTimer, this.idleTimer]) if (t) clearTimeout(t);
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
      this.settingsRequestedThisLink = false;
      this.liveTunerStartedThisLink = false;
      this.tunerOverlayOpen = false;
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
        this.store.setField('presetNames', this.metadata.presets.map((p) => p.name), 'cache');
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
    this.store.setField('presetNames', md.presets.map((p) => p.name), 'cache');
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

  /** Request the current-state dump. Coalesces requests issued within 250 ms. */
  async requestState(): Promise<void> {
    if (this.transport.status !== 'connected') return;
    const now = Date.now();
    if (now - this.stateRequestInFlightSince < 250) return;
    this.stateRequestInFlightSince = now;
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
    this.armIdleTimer(); // any pedal activity restarts the idle clock
    if (ev.kind === 'tuner') {
      // ~30/s while a note sounds: one store update per reading, nothing logged.
      const t = this.store.get().tuner;
      this.store.patch({ lastEventAt: pkt.at, tuner: { ...t, reading: ev.reading, readingAt: pkt.at } });
      return;
    }
    this.store.patch({ lastEventAt: pkt.at });
    switch (ev.kind) {
      case 'program-change':
        this.log('info', `Preset changed → ${ev.preset + 1} (${ev.shape})`, toHex(pkt.data));
        this.store.setField('activePreset', ev.preset, 'event', pkt.at);
        // A freshly loaded preset is the one moment its capture / IR should match the cached record.
        if (this.store.get().presetNames.source === 'cache') this.validateNamesOnNextState = true;
        if (ev.assignments) this.store.setField('footswitches', ev.assignments, 'event', pkt.at);
        this.settlePresetWaiters(ev.preset);
        this.scheduleConfirm(150);
        // Whether a preset change on the pedal ends its tuner is unknown: re-arm it to be safe.
        if (this.store.get().tuner.on) void this.writeTunerOn().catch((err) => this.log('warn', `Tuner re-arm failed: ${(err as Error).message}`));
        return;
      case 'bypass-changed':
        this.log('info', 'Bypass changed on device; re-reading state', toHex(pkt.data));
        this.scheduleConfirm(150);
        return;
      case 'tuner-ack':
        // The pedal echoes the tuner write; nothing to re-read (the preset is untouched).
        this.log('info', `Tuner ${ev.on ? 'on' : 'off'} acknowledged${ev.referenceHz !== null ? ` · ${ev.referenceHz} Hz` : ''}`, toHex(pkt.data));
        return;
      case 'preset-select-ack':
        // The pedal's reply to a c304 preset select (2026-09-19). Cortex Cloud requests the
        // state right after it; field 13 there is what settles the switch.
        this.log('info', 'Preset select acknowledged; re-reading state', toHex(pkt.data));
        this.scheduleConfirm(50);
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
    this.applyState(state);
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
    // The pedal's saved reference pitch seeds the tuner while the app is not driving it.
    if (state.tunerReferenceHz !== null && !this.store.get().tuner.on && this.store.get().tuner.referenceHz !== state.tunerReferenceHz) {
      this.store.patch({ tuner: { ...this.store.get().tuner, referenceHz: state.tunerReferenceHz } });
    }
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
    this.validateCachedNames(state);
    this.armIdleTimer();
    if (!this.settingsRequestedThisLink) {
      this.settingsRequestedThisLink = true;
      setTimeout(() => void this.requestDeviceSettings().catch((err) => this.log('warn', `Settings request failed: ${(err as Error).message}`)), this.opts.confirmDelayMs);
    }
    if (!this.liveTunerStartedThisLink && this.store.get().liveTuner) {
      // Live tuner: keep the pedal's tuner on for the session (after the settings request has gone out).
      this.liveTunerStartedThisLink = true;
      setTimeout(() => void this.setLiveTuner(true).catch((err) => this.log('warn', `Live tuner start failed: ${(err as Error).message}`)), this.opts.confirmDelayMs * 2);
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
    this.store.setField('activePreset', index, 'optimistic');
    const midiOut = this.opts.midiOut;
    const all = [BLE_SELECT_STRATEGY, ...(midiOut?.isSupported() ? [WEB_MIDI_STRATEGY] : []), ...BLE_MIDI_STRATEGIES];
    const candidates = this.midiStrategy ? [this.midiStrategy, ...(this.midiPinned ? [] : all.filter((s) => s.id !== this.midiStrategy!.id))] : all;
    for (const strategy of candidates) {
      const confirmed = this.waitForPreset(index);
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
        this.settlePresetWaiters(-1);
        continue;
      }
      if (strategy.framing !== 'select') {
        // MIDI deliveries: the web editor follows the Program Change with the ack frame.
        // The c304 select needs none — the pedal acks it by itself (2026-09-19 capture).
        await new Promise((r) => setTimeout(r, 50));
        await this.transport.writeCommand(PRESET_CHANGE_ACK).catch((err) => this.log('warn', `ack frame failed: ${(err as Error).message}`));
      }
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
      'Preset switch failed: no delivery was confirmed by the device (Bluetooth select, then MIDI). Check the pedal is on NanOS 2.2.x; on other firmware, USB Web MIDI may still work.',
    );
    void this.requestState(); // resync the optimistic value with reality
  }

  // -------------------------------------------------------------------------
  // Tuner (works whenever connected: it changes no preset)
  // -------------------------------------------------------------------------

  private liveTunerStartedThisLink = false;
  /** The full-screen tuner is open (it may mute; the live tuner never does). */
  private tunerOverlayOpen = false;

  /** Full-screen tuner opened: tuner on with the current reference and mute; the pedal streams readings. */
  async startTuner(): Promise<void> {
    if (this.transport.status !== 'connected') throw new Error('Not connected');
    this.tunerOverlayOpen = true;
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, on: true, reading: t.on ? t.reading : null, readingAt: t.on ? t.readingAt : null } });
    await this.writeTunerOn();
  }

  /**
   * Full-screen tuner closed. With the live tuner on, the pedal's tuner stays on but unmuted;
   * otherwise it is switched off and the reading cleared.
   */
  async stopTuner(): Promise<void> {
    this.tunerOverlayOpen = false;
    const t = this.store.get().tuner;
    if (this.store.get().liveTuner && this.transport.status === 'connected') {
      this.store.patch({ tuner: { ...t, muted: false } });
      if (t.muted || !t.on) await this.writeTunerOn();
      return;
    }
    await this.tunerOff();
  }

  /** Live tuner setting: on = keep the pedal's tuner running (unmuted) while connected. */
  async setLiveTuner(on: boolean): Promise<void> {
    if (this.transport.status !== 'connected') return;
    const t = this.store.get().tuner;
    if (on) {
      if (t.on) return;
      this.store.patch({ tuner: { ...t, on: true, muted: false, reading: null, readingAt: null } });
      await this.writeTunerOn();
    } else if (t.on && !this.tunerOverlayOpen) {
      await this.tunerOff();
    }
  }

  private async tunerOff(): Promise<void> {
    const t = this.store.get().tuner;
    this.store.patch({ tuner: { ...t, on: false, reading: null, readingAt: null } });
    if (this.transport.status !== 'connected') return;
    this.log('tx', 'Tuner off', toHex(TUNER_OFF));
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
