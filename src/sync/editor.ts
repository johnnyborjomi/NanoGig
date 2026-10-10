/**
 * Editing: everything the NanoGig Screen firmware learned to change on the pedal besides block on / off and preset
 * select (ported from its main/block_edits.c, fx_page.c, ir_page.c, library.c, rename.c, 2026-10-10):
 *
 *   FX block     model (the pedal loads its defaults) and parameters, read back per block (0x89 → 0x8A)
 *   capture      volume, on / off and the pedal's capture slots (selector 1: 1..5, 6 = the preset's own)
 *   IR           on / off and the pedal's IR list (selector 3), level / high pass / low pass / phase,
 *                microphone and position of a factory IR (0x5F → 0x60, writes 0x5E)
 *   gate         threshold
 *   library      every capture and IR on the pedal (0x4C → 0x4D); a capture goes into the slot the preset
 *                plays and that slot is selected, an IR loads into the preset
 *   presets      rename, create (the shown preset stored under a name), delete, footswitch assignment,
 *                and the pedal's own save button (0x1B)
 *
 * All of these are live edits: audible at once, the preset is only saved by the pedal's save button (renames,
 * creates and deletes are stored at once). Gated by control mode AND Edit mode (the top bar's Edit button).
 *
 * Shown at once (optimistic) and confirmed by a state dump, like the tile taps: a dump requested before a write
 * keeps the written value (`filterState`, the firmware's block_edits_filter). Slider writes are coalesced: one
 * write per key in flight, the newest value goes out when it completes (the BLE queue writes with response).
 */
import type { CurrentState, Metadata } from '../protocol/decode';
import {
  CAPTURE_OWN_SLOT,
  CAPTURE_SELECT_SLOTS,
  EDIT_MSG,
  cabLoadFrame,
  cabMicFrame,
  cabPhaseFrame,
  cabSelectFrame,
  cabSettingFrame,
  cabSettingsRequest,
  captureSlotLoadFrame,
  captureSlotSelectFrame,
  captureVolumeFrame,
  decodeCabSettings,
  decodeFxParams,
  decodeLibrary,
  decodeOk,
  decodePresetReply,
  footswitchAssignFrame,
  fxDef,
  fxModelFrame,
  fxModelId,
  fxModelType,
  fxParamFrame,
  fxParamsRequest,
  gateThresholdFrame,
  isPresetSaved,
  libraryRequest,
  presetCreateFrame,
  presetDeleteFrame,
  presetNameProblem,
  presetRenameFrame,
  type CabParam,
  type Footswitch,
  type LibraryItem,
  type LibraryKind,
} from '../protocol/edit';
import { CAB_SLOT_COUNT, FX_SLOTS, type FxSlot } from '../protocol/frames';
import { toHex } from '../protocol/hex';
import { lookupFxModel, type FxModelsBySlot } from '../protocol/models';
import type { EditState, FxEditState, IrEditState, SavedModels, SavedParams, Store } from '../state/store';
import type { LogDirection, Transport } from '../transport/types';

/** What the editor needs from the sync engine. */
export interface EditHost {
  readonly transport: Transport;
  readonly store: Store;
  writesEnabled(): boolean;
  log(dir: LogDirection, text: string, hex?: string): void;
  /** A confirming state dump shortly (the engine's own coalescing applies). */
  confirm(delayMs?: number): void;
  metadata(): Metadata | null;
  /** The metadata changed here (a rename, a load into a slot): names on screen and in the cache follow. */
  metadataChanged(md: Metadata): void;
  /** Re-read the names from the pedal (after a delete: the cache cannot follow it). */
  refreshNames(): void;
  lastState(): CurrentState | null;
}

const PRESET_REPLY_TIMEOUT_MS = 3000;
const READ_TIMEOUT_MS = 2500;
const LIBRARY_TIMEOUT_MS = 15000;

/**
 * A write made at `writtenAt` is newer than what a dump requested at `requestedAt` shows. The same millisecond
 * counts as newer: Date.now() ticks in ms, and a dump asked just before a write in the same ms (a slow machine,
 * CI) shows the pedal before it. 0 = never written.
 */
export function writtenSince(writtenAt: number, requestedAt: number): boolean {
  return writtenAt > 0 && writtenAt >= requestedAt;
}

type Read = { preset: number | null; key: string; at: number };

export class EditController {
  /** When each value was last written from here: an older dump cannot undo it. */
  private readonly writtenAt = {
    model: { pre1: 0, pre2: 0, post1: 0, post2: 0, post3: 0 } as Record<FxSlot, number>,
    captureVolume: 0,
    gateThreshold: 0,
    capture: 0,
    ir: 0,
  };
  /** The slot this preset last played while on (field 11 / 12): where "on" goes back to (firmware's ir_slot / capture_slot). */
  private lastIr: { preset: number | null; slot: number } | null = null;
  private lastCapture: { preset: number | null; slot: number } | null = null;
  /** Coalesced writes: the newest frame per key waits for the one in flight. */
  private readonly inflight = new Set<string>();
  private readonly queued = new Map<string, { frame: Uint8Array; label: string }>();
  /** FX / IR reads asked, oldest first: a reply answers the oldest (the firmware's remote_page). */
  private fxReads: Read[] = [];
  private irReads: Read[] = [];
  private fxTimer: ReturnType<typeof setTimeout> | null = null;
  /** Key of the picture last asked for (`fxKey` / `irKey`): a state that changes it reads again. */
  private fxAsked: string | null = null;
  private irAsked: string | null = null;
  private irTimer: ReturnType<typeof setTimeout> | null = null;
  private libraryAsked: LibraryKind[] | null = null;
  private libraryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A capture load into this slot (1..5) awaits the pedal's 0x51; then the slot is selected. */
  private loadingCaptureSlot: number | null = null;
  private presetTimer: ReturnType<typeof setTimeout> | null = null;
  /** A preset write whose answer timed out: a late answer still applies (a delete is done on the pedal either way). */
  private lateOp: { kind: 'rename' | 'create' | 'delete'; index: number; name: string } | null = null;

  constructor(private readonly host: EditHost) {}

  private get store() {
    return this.host.store;
  }

  private patchEdit(patch: Partial<EditState>) {
    this.store.patch({ edit: { ...this.store.get().edit, ...patch } });
  }

  private assertEdit() {
    if (this.host.transport.status !== 'connected') throw new Error('Not connected');
    if (!this.host.writesEnabled()) throw new Error('Control mode is off');
    if (!this.store.get().editing) throw new Error('Edit mode is off (the Edit button in the top bar)');
  }

  private activePreset(): number | null {
    return this.store.get().activePreset.value;
  }

  private send(frame: Uint8Array, label: string): Promise<void> {
    this.host.log('tx', label, toHex(frame));
    return this.host.transport.writeCommand(frame);
  }

  /** Coalesced send: while one write of `key` is on the wire, only the newest of the later ones follows it. */
  private sendLatest(key: string, frame: Uint8Array, label: string): void {
    if (this.inflight.has(key)) {
      this.queued.set(key, { frame, label });
      return;
    }
    this.inflight.add(key);
    void this.send(frame, label)
      .catch((err) => this.host.log('warn', `${label} failed: ${(err as Error).message}`))
      .finally(() => {
        this.inflight.delete(key);
        const next = this.queued.get(key);
        this.queued.delete(key);
        if (next && this.host.transport.status === 'connected') this.sendLatest(key, next.frame, next.label);
      });
  }

  // -------------------------------------------------------------------------
  // Link and state
  // -------------------------------------------------------------------------

  reset(): void {
    for (const t of [this.fxTimer, this.irTimer, this.libraryTimer, this.presetTimer]) if (t) clearTimeout(t);
    this.fxTimer = this.irTimer = this.libraryTimer = this.presetTimer = null;
    this.fxReads = [];
    this.irReads = [];
    this.fxAsked = this.irAsked = null;
    this.libraryAsked = null;
    this.loadingCaptureSlot = null;
    this.inflight.clear();
    this.queued.clear();
    const busy = this.store.get().edit.preset.busy;
    if (busy) this.presetAnswer(false, 'Connection to the pedal lost');
  }

  dispose(): void {
    this.reset();
  }

  /**
   * A dump requested before one of our writes shows the pedal before it: keep what was written (the next dump,
   * requested after the write, confirms). Mutates `state`; true when something was held.
   */
  filterState(state: CurrentState, requestedAt: number): boolean {
    const s = this.store.get();
    const samePreset = state.activePreset === s.activePreset.value;
    let held = false;
    for (const slot of FX_SLOTS) {
      if (writtenSince(this.writtenAt.model[slot], requestedAt) && samePreset) {
        state.fxModelIds[slot] = s.fxModels.value[slot]?.id ?? state.fxModelIds[slot];
        held = true;
      }
    }
    if (writtenSince(this.writtenAt.captureVolume, requestedAt) && samePreset && s.captureVolume.value !== null) {
      state.captureVolumeRaw = s.captureVolume.value;
      held = true;
    }
    if (writtenSince(this.writtenAt.gateThreshold, requestedAt) && samePreset && s.gateThreshold.value !== null) {
      state.gateThresholdRaw = s.gateThreshold.value;
      held = true;
    }
    if (writtenSince(this.writtenAt.ir, requestedAt) && samePreset) {
      state.cabOn = s.cabOn.value ?? state.cabOn;
      state.cabSlot = s.cabSlot.value;
      if (state.ir && s.irName.value) state.ir = { ...state.ir, shortName: s.irName.value };
      held = true;
    }
    if (writtenSince(this.writtenAt.capture, requestedAt) && samePreset) {
      state.captureSlot = s.captureOn.value ? (s.captureSlot.value ?? state.captureSlot) : 0;
      if (state.capture && s.captureName.value) state.capture = { ...state.capture, name: s.captureName.value };
      held = true;
    }
    const slot = state.captureSlot ?? 0;
    if (slot >= 1 && slot <= CAPTURE_SELECT_SLOTS) this.lastCapture = { preset: state.activePreset, slot };
    if (state.cabOn && state.cabSlot) this.lastIr = { preset: state.activePreset, slot: state.cabSlot };
    return held;
  }

  /** After every applied state: open panels re-read when the preset, the block's model or its on / off changed. */
  onState(): void {
    this.fxTick();
    this.irTick();
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /** A complete message of `msgType`; true when it was the editor's. */
  onMessage(msgType: number, payload: Uint8Array, hex: string): boolean {
    switch (msgType) {
      case EDIT_MSG.FX_PARAMS:
        this.onFxParams(payload, hex);
        return true;
      case EDIT_MSG.CAB_SETTINGS:
        this.onCabSettings(payload, hex);
        return true;
      case EDIT_MSG.LIBRARY:
        this.onLibrary(payload);
        return true;
      case EDIT_MSG.CAPTURE_SLOT_LOADED:
        this.onCaptureLoaded(decodeOk(payload), hex);
        return true;
      case EDIT_MSG.CAB_SLOT_LOADED:
      case EDIT_MSG.CAPTURE_PREVIEWED:
        this.host.log(decodeOk(payload) ? 'info' : 'warn', `Library ${msgType === EDIT_MSG.CAB_SLOT_LOADED ? 'IR slot load' : 'capture preview'} ${decodeOk(payload) ? 'acknowledged' : 'refused'}`, hex);
        return true;
      case EDIT_MSG.RENAME_REPLY:
      case EDIT_MSG.PRESET_CREATED:
      case EDIT_MSG.PRESET_DELETED:
        this.onPresetReply(msgType, payload, hex);
        return true;
      case EDIT_MSG.STORE:
        if (!isPresetSaved(payload)) return false; // a bare 0x1B: the engine's generic re-read
        this.onPresetSaved(hex);
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // FX block: model and parameters
  // -------------------------------------------------------------------------

  /** Model type of a slot as shown. */
  private slotType(slot: FxSlot): number {
    return fxModelType(this.store.get().fxModels.value[slot]?.id);
  }

  private slotOn(slot: FxSlot): boolean {
    const s = this.store.get();
    return s.fxOn.value[slot] === true && !!s.fxModels.value[slot];
  }

  /** What a read describes: the preset, the slot, its model and whether it is on. A change of any of them reads again. */
  private fxKey(slot: FxSlot): string {
    return `${this.activePreset()}|${slot}|${this.slotType(slot)}|${this.slotOn(slot) ? 'on' : 'off'}`;
  }

  openFx(slot: FxSlot): void {
    this.fxAsked = null;
    this.patchEdit({ fx: { slot, type: this.slotType(slot), preset: this.activePreset(), values: null, status: 'loading' } });
    this.fxTick();
  }

  closeFx(): void {
    this.patchEdit({ fx: null });
    this.fxAsked = null;
  }

  /** Ask for the open block's parameters when what they belong to changed (or `force`, after a write the pedal answers by reloading). */
  private fxTick(force = false): void {
    const fx = this.store.get().edit.fx;
    if (!fx) return;
    const slot = fx.slot;
    const key = this.fxKey(slot);
    if (!force && key === this.fxAsked) return;
    this.fxAsked = key;
    const type = this.slotType(slot);
    const preset = this.activePreset();
    const same = fx.type === type && fx.preset === preset;
    const next: FxEditState = { slot, type, preset, values: same ? fx.values : null, status: 'loading' };
    if (!type) next.status = 'empty';
    else if (!fxDef(type)) next.status = 'unknown';
    // Never for a bypassed block: DrD85 saw that crash the pedal.
    else if (!this.slotOn(slot)) next.status = 'off';
    this.patchEdit({ fx: next });
    if (next.status !== 'loading' || this.host.transport.status !== 'connected') return;
    this.fxReads.push({ preset, key, at: Date.now() });
    if (this.fxReads.length > 4) this.fxReads.shift();
    if (this.fxTimer) clearTimeout(this.fxTimer);
    this.fxTimer = setTimeout(() => {
      this.fxTimer = null;
      const cur = this.store.get().edit.fx;
      if (cur?.status === 'loading') {
        this.host.log('warn', `FX parameters of ${slot} unanswered`);
        // The read stays queued: a late reply still pops its own entry, not the next read's.
        this.patchEdit({ fx: { ...cur, status: 'error' } });
        this.fxAsked = null; // the next state may ask again
      }
    }, READ_TIMEOUT_MS);
    void this.send(fxParamsRequest(slot), `FX parameters read · ${slot}`).catch((err) => this.host.log('warn', `FX read failed: ${(err as Error).message}`));
  }

  /** Re-read the open block (the editor's retry button). */
  retryFx(): void {
    this.fxTick(true);
  }

  private onFxParams(payload: Uint8Array, hex: string): void {
    const read = this.fxReads.shift();
    const values = decodeFxParams(payload);
    const fx = this.store.get().edit.fx;
    this.host.log('info', `FX parameters: ${values.length} values${read ? '' : ' (unasked)'}`, hex);
    if (!fx || !read || this.fxReads.length > 0) return; // closed, unasked, or a newer read is out
    if (read.key !== this.fxKey(fx.slot)) return; // answers an older picture
    if (this.fxTimer) clearTimeout(this.fxTimer);
    this.fxTimer = null;
    this.patchEdit({ fx: { ...fx, values: values.length ? values : null, status: values.length ? 'ready' : 'error' } });
    if (values.length) this.noteSavedParams(fx.slot, values);
  }

  /** The first read of a block on its saved model, since the preset loaded or was saved: its saved parameters. */
  private noteSavedParams(slot: FxSlot, values: number[]): void {
    const s = this.store.get();
    const saved = s.edit.savedParams;
    const preset = s.activePreset.value;
    if (!saved || saved.preset !== preset || saved.slots[slot]) return;
    const id = s.fxModels.value[slot]?.id ?? null;
    if (!id || s.edit.savedModels?.preset !== preset || s.edit.savedModels.ids[slot] !== id) return;
    this.patchEdit({ savedParams: { ...saved, slots: { ...saved.slots, [slot]: { type: fxModelType(id), values: values.slice() } } } });
  }

  /** Load a model into a slot. Shown at once from the catalogue; the pedal loads the model's defaults. */
  async setFxModel(slot: FxSlot, type: number): Promise<void> {
    this.assertEdit();
    const id = fxModelId(type);
    const model = lookupFxModel(id);
    if (!model?.known) throw new Error(`Unknown FX model ${type}`);
    const frame = fxModelFrame(slot, type);
    this.writtenAt.model[slot] = Date.now();
    this.store.setField('fxModels', { ...this.store.get().fxModels.value, [slot]: model }, 'optimistic');
    await this.send(frame, `FX ${slot} model → ${model.name}`);
    this.host.confirm();
    const fx = this.store.get().edit.fx;
    if (fx?.slot === slot) this.fxTick(true);
  }

  /** The model the preset has saved in a slot, if the shown one is another (null: no change, or not known). */
  savedModelChanged(slot: FxSlot): string | null {
    const saved = this.store.get().edit.savedModels;
    const s = this.store.get();
    if (!saved || saved.preset !== s.activePreset.value) return null;
    const id = saved.ids[slot];
    if (!id || !lookupFxModel(id)?.known) return null;
    return id === (s.fxModels.value[slot]?.id ?? null) ? null : id;
  }

  /** The block's saved parameters, when known for the preset shown. */
  private savedParamsOf(slot: FxSlot): { type: number; values: number[] } | null {
    const saved = this.store.get().edit.savedParams;
    return saved && saved.preset === this.store.get().activePreset.value ? (saved.slots[slot] ?? null) : null;
  }

  /** The block differs from the preset as saved: another model, or (open in the editor) other parameter values. */
  fxChanged(slot: FxSlot): boolean {
    if (this.savedModelChanged(slot)) return true;
    const base = this.savedParamsOf(slot);
    const fx = this.store.get().edit.fx;
    if (!base || fx?.slot !== slot || !fx.values || fx.type !== base.type) return false;
    return base.values.some((v, i) => Math.abs(v - (fx.values![i] ?? v)) > 1e-4);
  }

  /**
   * Discard the block's edits: the saved model back in the slot, then its saved parameter values (when the block was
   * read on its saved model), then a read so the editor shows what the pedal has. Other blocks keep their edits.
   */
  async discardFx(slot: FxSlot): Promise<void> {
    this.assertEdit();
    const id = this.savedModelChanged(slot);
    if (id) await this.setFxModel(slot, fxModelType(id));
    const base = this.savedParamsOf(slot);
    if (!base || this.slotType(slot) !== base.type || !this.slotOn(slot)) return;
    // A slider write still queued for this block would land after these.
    for (const key of Array.from(this.queued.keys())) if (key.startsWith(`fx:${slot}:`)) this.queued.delete(key);
    const fx = this.store.get().edit.fx;
    const now = fx?.slot === slot && fx.type === base.type ? fx.values : null;
    if (fx?.slot === slot) this.patchEdit({ fx: { ...fx, type: base.type, values: base.values.slice() } });
    const def = fxDef(base.type);
    for (let i = 0; i < base.values.length; i++) {
      // Every value after a model change (the pedal may load its defaults); only the changed ones otherwise.
      if (!id && now && Math.abs((now[i] ?? -1) - base.values[i]!) <= 1e-4) continue;
      await this.send(fxParamFrame(slot, i, base.values[i]!), `FX ${slot} ${def?.params[i]?.name ?? i} → ${base.values[i]!.toFixed(4)} (discard)`);
    }
    if (this.store.get().edit.fx?.slot === slot) this.fxTick(true);
  }

  /**
   * A state read: a preset seen for the first time since it loaded has its saved models in place (the pedal drops
   * unsaved edits on a preset load).
   */
  noteModels(preset: number | null, models: FxModelsBySlot): void {
    if (preset === null || this.store.get().edit.savedModels?.preset === preset) return;
    this.rememberSavedModels(preset, models);
  }

  private rememberSavedModels(preset: number, models: FxModelsBySlot): void {
    const ids = {} as SavedModels['ids'];
    for (const slot of FX_SLOTS) ids[slot] = models[slot]?.id ?? null;
    // Parameters are known only for blocks read since: the open one's values now, the others at their next read.
    const slots: SavedParams['slots'] = {};
    const fx = this.store.get().edit.fx;
    if (fx?.values && fx.status === 'ready' && fx.preset === preset && fx.type === fxModelType(ids[fx.slot])) slots[fx.slot] = { type: fx.type, values: fx.values.slice() };
    this.patchEdit({ savedModels: { preset, ids }, savedParams: { preset, slots } });
  }

  /** One parameter, live while a slider moves; the editor shows the value at once. */
  setFxParam(slot: FxSlot, param: number, normalized: number): void {
    this.assertEdit();
    if (!this.slotOn(slot)) throw new Error('Turn the block on to edit it');
    const def = fxDef(this.slotType(slot));
    if (!def || param >= def.params.length) throw new Error('Unknown parameter');
    const fx = this.store.get().edit.fx;
    if (fx?.slot === slot && fx.values) {
      const values = fx.values.slice();
      values[param] = Math.min(1, Math.max(0, normalized));
      this.patchEdit({ fx: { ...fx, values } });
    }
    this.sendLatest(`fx:${slot}:${param}`, fxParamFrame(slot, param, normalized), `FX ${slot} ${def.params[param]!.name} → ${normalized.toFixed(4)}`);
  }

  // -------------------------------------------------------------------------
  // Capture: volume, on / off, slots
  // -------------------------------------------------------------------------

  setCaptureVolume(raw: number): void {
    this.assertEdit();
    const v = Math.round(Math.min(255, Math.max(0, raw)));
    this.writtenAt.captureVolume = Date.now();
    this.store.setField('captureVolume', v, 'optimistic');
    this.sendLatest('capture-volume', captureVolumeFrame(v), `Capture volume → ${v}`);
    this.host.confirm(600);
  }

  setGateThreshold(raw: number): void {
    this.assertEdit();
    const v = Math.round(Math.min(255, Math.max(0, raw)));
    this.writtenAt.gateThreshold = Date.now();
    this.store.setField('gateThreshold', v, 'optimistic');
    this.sendLatest('gate-threshold', gateThresholdFrame(v), `Gate threshold → ${v}`);
    this.host.confirm(600);
  }

  /**
   * A slot to load into or turn on: the capture's own while it sits in one, else the slot this preset last played,
   * else the preset's saved capture among the slots, else 1 (also for the preset's own capture, slot 6).
   */
  captureSlotForEdit(): number {
    const s = this.store.get();
    const cur = s.captureSlot.value ?? 0;
    if (s.captureOn.value && cur >= 1 && cur <= CAPTURE_SELECT_SLOTS) return cur;
    if (this.lastCapture && this.lastCapture.preset === s.activePreset.value) return this.lastCapture.slot;
    const md = this.host.metadata();
    const preset = s.activePreset.value;
    const saved = preset !== null ? md?.presets[preset]?.captureName.trim().toLowerCase() : '';
    if (md && saved) {
      const i = md.captures.slice(0, CAPTURE_SELECT_SLOTS).findIndex((c) => c.name.trim().toLowerCase() === saved);
      if (i >= 0) return i + 1;
    }
    return 1;
  }

  /** Selector 1: slot 1..5, 6 = the preset's own capture, 0 = off. Shown at once with the cached name. */
  async selectCaptureSlot(slot: number): Promise<void> {
    this.assertEdit();
    const frame = captureSlotSelectFrame(slot);
    this.writtenAt.capture = Date.now();
    const md = this.host.metadata();
    if (slot) {
      this.store.setField('captureOn', true, 'optimistic');
      this.store.setField('captureSlot', slot, 'optimistic');
      const name = slot <= CAPTURE_SELECT_SLOTS ? md?.captures[slot - 1]?.name : md?.presets[this.activePreset() ?? -1]?.captureName;
      if (name) this.store.setField('captureName', name, 'optimistic');
    } else {
      this.store.setField('captureOn', false, 'optimistic');
    }
    await this.send(frame, slot ? `Capture slot ${slot}${slot === CAPTURE_OWN_SLOT ? " (the preset's own)" : ''}` : 'Capture off');
    this.host.confirm();
  }

  async setCaptureOn(on: boolean): Promise<void> {
    if (on === (this.store.get().captureOn.value === true)) return;
    await this.selectCaptureSlot(on ? this.captureSlotForEdit() : 0);
  }

  /** The slots 1..5, wrapping; from the preset's own capture (6) or off, the ends. */
  async stepCapture(delta: number): Promise<void> {
    const s = this.store.get();
    const count = CAPTURE_SELECT_SLOTS;
    const cur = s.captureOn.value ? (s.captureSlot.value ?? 0) : this.captureSlotForEdit();
    const next = cur >= 1 && cur <= count ? ((cur - 1 + (delta > 0 ? 1 : count - 1)) % count) + 1 : delta > 0 ? 1 : count;
    await this.selectCaptureSlot(next);
  }

  // -------------------------------------------------------------------------
  // IR: on / off, the pedal's IR list, settings
  // -------------------------------------------------------------------------

  /** Where "on" goes: the slot this preset last played, else the preset's saved IR on the pedal's list, else 1. */
  irSlotForOn(): number {
    const s = this.store.get();
    // The slot it last played, 6 (the preset's own IR) included: that restores the preset's own.
    if (this.lastIr && this.lastIr.preset === s.activePreset.value) return this.lastIr.slot;
    const md = this.host.metadata();
    const preset = s.activePreset.value;
    const saved = preset !== null ? md?.presets[preset]?.irShortName.trim().toLowerCase() : '';
    if (md && saved) {
      const i = md.irs.slice(0, CAB_SLOT_COUNT).findIndex((r) => (r.shortName || r.fullName).trim().toLowerCase() === saved);
      if (i >= 0) return i + 1;
    }
    return 1;
  }

  /** Selector 3: slot 1..5, 0 = off. Shown at once with the cached name. */
  async selectIrSlot(slot: number): Promise<void> {
    this.assertEdit();
    const frame = cabSelectFrame(slot);
    this.writtenAt.ir = Date.now();
    if (slot) {
      const ir = this.host.metadata()?.irs[slot - 1];
      this.store.setField('cabOn', true, 'optimistic');
      this.store.setField('cabSlot', slot, 'optimistic');
      if (ir && (ir.shortName || ir.fullName)) this.store.setField('irName', ir.shortName || ir.fullName, 'optimistic');
    } else {
      this.store.setField('cabOn', false, 'optimistic');
    }
    await this.send(frame, slot ? `IR slot ${slot}` : 'IR off');
    this.host.confirm();
  }

  async setIrOn(on: boolean): Promise<void> {
    if (on === (this.store.get().cabOn.value === true)) return;
    await this.selectIrSlot(on ? this.irSlotForOn() : 0);
  }

  /** The pedal's IR list, wrapping like its encoder; from the preset's own IR (6) or off, the list's ends. */
  async stepIr(delta: number): Promise<void> {
    const s = this.store.get();
    const md = this.host.metadata();
    const count = Math.min(CAB_SLOT_COUNT, md?.irs.length || CAB_SLOT_COUNT);
    const cur = s.cabOn.value ? (s.cabSlot.value ?? 0) : this.irSlotForOn();
    const next = cur >= 1 && cur <= count ? ((cur - 1 + (delta > 0 ? 1 : count - 1)) % count) + 1 : delta > 0 ? 1 : count;
    await this.selectIrSlot(next);
  }

  private irKey(): string {
    const s = this.store.get();
    return `${s.activePreset.value}|${s.cabOn.value ? `on:${s.cabSlot.value ?? 1}` : 'off'}`;
  }

  openIr(): void {
    this.irAsked = null;
    this.patchEdit({ ir: { preset: this.activePreset(), slot: this.store.get().cabSlot.value, settings: null, status: 'loading' } });
    this.irTick();
  }

  closeIr(): void {
    this.patchEdit({ ir: null });
    this.irAsked = null;
  }

  retryIr(): void {
    this.irTick(true);
  }

  private irTick(force = false): void {
    const ir = this.store.get().edit.ir;
    if (!ir) return;
    const key = this.irKey();
    if (!force && key === this.irAsked) return;
    this.irAsked = key;
    const s = this.store.get();
    const preset = this.activePreset();
    // An IR that is off has no settings to read.
    if (!s.cabOn.value) {
      this.patchEdit({ ir: { preset, slot: null, settings: null, status: 'off' } });
      return;
    }
    const slot = s.cabSlot.value ?? 1;
    const same = ir.preset === preset && ir.slot === slot;
    this.patchEdit({ ir: { preset, slot, settings: same ? ir.settings : null, status: 'loading' } });
    if (this.host.transport.status !== 'connected') return;
    this.irReads.push({ preset, key, at: Date.now() });
    if (this.irReads.length > 4) this.irReads.shift();
    if (this.irTimer) clearTimeout(this.irTimer);
    this.irTimer = setTimeout(() => {
      this.irTimer = null;
      const cur = this.store.get().edit.ir;
      if (cur?.status === 'loading') {
        this.host.log('warn', 'IR settings unanswered');
        this.patchEdit({ ir: { ...cur, status: 'error' } });
        this.irAsked = null;
      }
    }, READ_TIMEOUT_MS);
    void this.send(cabSettingsRequest(slot), `IR settings read · slot ${slot}`).catch((err) => this.host.log('warn', `IR read failed: ${(err as Error).message}`));
  }

  private onCabSettings(payload: Uint8Array, hex: string): void {
    const read = this.irReads.shift();
    const cs = decodeCabSettings(payload);
    this.host.log(cs ? 'info' : 'warn', cs ? `IR settings: "${cs.irName}" (${cs.factory ? 'factory' : 'user'}), mic "${cs.mic}" position ${cs.position + 1}, phase ${cs.phaseInverted ? 'inverted' : 'normal'}` : 'IR settings without an IR', hex);
    const ir = this.store.get().edit.ir;
    if (!ir || !read || this.irReads.length > 0) return;
    if (read.key !== this.irKey()) return;
    if (this.irTimer) clearTimeout(this.irTimer);
    this.irTimer = null;
    this.patchEdit({ ir: { ...ir, settings: cs, status: cs ? 'ready' : 'error' } });
  }

  private irWritable(): IrEditState {
    this.assertEdit();
    if (!this.store.get().cabOn.value) throw new Error('Turn the IR on to edit it');
    const ir = this.store.get().edit.ir;
    if (!ir) throw new Error('IR panel closed');
    return ir;
  }

  /** Level / high pass / low pass, live while a slider moves. */
  setIrParam(param: CabParam, normalized: number): void {
    const ir = this.irWritable();
    const n = Math.min(1, Math.max(0, normalized));
    if (ir.settings) this.patchEdit({ ir: { ...ir, settings: { ...ir.settings, [param]: n } } });
    this.sendLatest(`ir:${param}`, cabSettingFrame(param, n), `IR ${param} → ${n.toFixed(4)}`);
  }

  async setIrPhase(inverted: boolean): Promise<void> {
    const ir = this.irWritable();
    if (ir.settings) this.patchEdit({ ir: { ...ir, settings: { ...ir.settings, phaseInverted: inverted } } });
    await this.send(cabPhaseFrame(inverted), `IR phase → ${inverted ? 'inverted' : 'normal'}`);
    this.irTick(true);
  }

  /**
   * A factory IR's microphone / position: the pedal loads that IR by name, so only while the answer describes the
   * IR shown now (another preset's IR would be loaded otherwise); a read confirms what it took.
   */
  async setIrMic(position: number, mic: string): Promise<void> {
    const ir = this.irWritable();
    const cs = ir.settings;
    if (!cs?.factory || ir.status !== 'ready' || ir.preset !== this.activePreset()) throw new Error('Wait for the IR settings to load');
    this.patchEdit({ ir: { ...ir, settings: { ...cs, position, mic } } });
    await this.send(cabMicFrame(cs.kind, cs.irName, position, mic), `IR "${cs.irName}" mic "${mic}" position ${position + 1}`);
    this.irTick(true);
  }

  // -------------------------------------------------------------------------
  // Library
  // -------------------------------------------------------------------------

  /** Read the pedal's captures or IRs (cached for the session; read again on every open). */
  async loadLibrary(kind: LibraryKind): Promise<void> {
    if (this.host.transport.status !== 'connected') throw new Error('Not connected');
    await this.requestLibrary([kind]);
  }

  private async requestLibrary(what: LibraryKind[]): Promise<void> {
    const lib = this.store.get().edit.library;
    this.libraryAsked = what;
    this.patchEdit({ library: { ...lib, loading: what.length === 1 ? what[0]! : 'captures', error: null } });
    if (this.libraryTimer) clearTimeout(this.libraryTimer);
    this.libraryTimer = setTimeout(() => {
      this.libraryTimer = null;
      if (!this.libraryAsked) return;
      this.libraryAsked = null;
      this.patchEdit({ library: { ...this.store.get().edit.library, loading: null, error: 'No answer from the pedal' } });
    }, LIBRARY_TIMEOUT_MS);
    await this.send(libraryRequest(what), `Library request · ${what.join(' + ')}`);
  }

  private onLibrary(payload: Uint8Array): void {
    const asked = this.libraryAsked;
    const lib = decodeLibrary(payload);
    this.host.log('info', `Library: ${lib.captures?.length ?? 0} captures, ${lib.irs?.length ?? 0} IRs (${payload.length} B)`);
    const cur = this.store.get().edit.library;
    const next = { ...cur, captures: lib.captures ?? cur.captures, irs: lib.irs ?? cur.irs };
    // Asked for one kind and the reply lacks it: ask for everything once (the firmware's fallback).
    if (asked && asked.length === 1 && !lib[asked[0]!]) {
      this.store.patch({ edit: { ...this.store.get().edit, library: next } });
      void this.requestLibrary(['captures', 'irs']).catch((err) => this.host.log('warn', `Library request failed: ${(err as Error).message}`));
      return;
    }
    this.libraryAsked = null;
    if (this.libraryTimer) clearTimeout(this.libraryTimer);
    this.libraryTimer = null;
    this.patchEdit({ library: { ...next, loading: null, error: null } });
  }

  /**
   * A library capture goes the way of Cortex Cloud's "Use": into the slot the preset plays (`captureSlotForEdit`),
   * then that slot is selected (on the pedal's 0x51), which marks the preset edited. Every preset on that slot hears
   * the new capture. An IR loads into the preset itself (an edit, kept when the preset is saved).
   */
  async pickFromLibrary(item: LibraryItem, kind: LibraryKind): Promise<void> {
    this.assertEdit();
    if (kind === 'irs') {
      this.writtenAt.ir = Date.now();
      this.store.setField('cabOn', true, 'optimistic');
      this.store.setField('irName', item.name, 'optimistic');
      await this.send(cabLoadFrame(item.list, item.index, item.name), `Load ${item.list} IR ${item.index + 1} "${item.name}"`);
      this.host.confirm();
      if (this.store.get().edit.ir) this.irTick(true);
      return;
    }
    const slot = this.captureSlotForEdit();
    this.loadingCaptureSlot = slot;
    this.writtenAt.capture = Date.now();
    this.store.setField('captureOn', true, 'optimistic');
    this.store.setField('captureName', item.name, 'optimistic');
    await this.send(captureSlotLoadFrame(slot - 1, item), `Load ${item.list} capture ${item.index + 1} "${item.name}" into slot ${slot}`);
    const md = this.host.metadata();
    if (md && md.captures[slot - 1]) {
      const captures = md.captures.slice();
      captures[slot - 1] = { ...captures[slot - 1]!, name: item.name };
      this.host.metadataChanged({ ...md, captures });
    }
    this.host.confirm(1500); // in case the 0x51 never comes
  }

  private onCaptureLoaded(ok: boolean, hex: string): void {
    const slot = this.loadingCaptureSlot;
    this.loadingCaptureSlot = null;
    this.host.log(ok ? 'info' : 'warn', `Capture load ${ok ? 'acknowledged' : 'refused'}`, hex);
    if (!ok || slot === null) {
      this.host.confirm();
      return;
    }
    void this.selectCaptureSlot(slot).catch((err) => this.host.log('warn', `Capture select failed: ${(err as Error).message}`));
  }

  // -------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------

  /** The capture and IR the shown preset has saved (its metadata record): the library marks them. */
  savedNames(): { capture: string; ir: string } {
    const preset = this.activePreset();
    const rec = preset !== null ? this.host.metadata()?.presets[preset] : undefined;
    return { capture: rec?.captureName ?? '', ir: rec?.irShortName ?? '' };
  }

  /** Why a name cannot be written, null when it can. */
  nameProblem(index: number, name: string): string | null {
    return presetNameProblem(name, index, this.store.get().presetNames.value);
  }

  private presetBusy(kind: 'rename' | 'create' | 'delete', index: number, name: string): void {
    if (this.store.get().edit.preset.busy) throw new Error('Waiting for the pedal');
    const preset = this.store.get().edit.preset;
    this.patchEdit({ preset: { ...preset, busy: { kind, index, name }, result: null } });
    if (this.presetTimer) clearTimeout(this.presetTimer);
    this.presetTimer = setTimeout(() => {
      this.presetTimer = null;
      const late = this.store.get().edit.preset.busy;
      if (!late) return;
      this.presetAnswer(false, 'No answer from the pedal');
      this.lateOp = late;
    }, PRESET_REPLY_TIMEOUT_MS);
  }

  /** Send a preset write that `presetBusy` registered; a failed send answers at once. */
  private async sendPreset(frame: Uint8Array, label: string): Promise<void> {
    try {
      await this.send(frame, label);
    } catch (err) {
      this.presetAnswer(false, 'Not connected to the pedal');
      throw err;
    }
  }

  private presetAnswer(ok: boolean, message: string, op = this.store.get().edit.preset.busy): void {
    const p = this.store.get().edit.preset;
    const busy = op;
    if (this.presetTimer) clearTimeout(this.presetTimer);
    this.presetTimer = null;
    this.lateOp = null;
    if (!busy) return;
    this.patchEdit({ preset: { ...p, busy: null, result: { kind: busy.kind, index: busy.index, ok, message, at: Date.now() } } });
    // A refused delete: the cached list may be stale (the slot already empty on the pedal); read it again.
    if (!ok && busy.kind === 'delete' && message !== 'No answer from the pedal' && message !== 'Not connected to the pedal' && message !== 'Connection to the pedal lost') this.host.refreshNames();
    if (!ok) return;
    const md = this.host.metadata();
    const names = this.store.get().presetNames.value.slice();
    if (busy.kind === 'delete') {
      // The pedal lists a deleted preset with no name, capture or IR (Cortex Cloud snoop, 2026-10-10).
      names[busy.index] = '';
      if (md) {
        const presets = md.presets.slice();
        presets[busy.index] = { name: '', captureName: '', captureId: '', irShortName: '', irFullName: '' };
        this.host.metadataChanged({ ...md, presets });
      } else {
        this.store.setField('presetNames', names, 'metadata');
      }
      this.host.refreshNames();
      return;
    }
    names[busy.index] = busy.name;
    if (md) {
      const presets = md.presets.slice();
      const rec = { ...(presets[busy.index] ?? { name: '', captureName: '', captureId: '', irShortName: '', irFullName: '' }), name: busy.name };
      // A create stores the shown preset: its capture and IR are the saved ones now.
      const s = this.store.get();
      if (busy.kind === 'create' && s.activePreset.value === busy.index) {
        rec.captureName = s.captureName.value ?? '';
        rec.irShortName = s.irName.value ?? '';
      }
      presets[busy.index] = rec;
      this.host.metadataChanged({ ...md, presets });
    } else {
      this.store.setField('presetNames', names, 'metadata');
    }
    // Stored over the shown preset (Save): what it shows is what it has saved now. A read confirms the light.
    const shown = this.store.get();
    if (busy.kind === 'create' && shown.activePreset.value === busy.index) {
      this.rememberSavedModels(busy.index, shown.fxModels.value);
      this.host.confirm(400);
    }
  }

  /**
   * Save, as the pedal's save button: SavePreset (DrD85's name for the create frame) over the shown preset, under
   * its own name. A preset with no name is asked for one first (the pedal refuses renames of an unnamed preset).
   */
  async savePreset(): Promise<void> {
    this.assertEdit();
    const s = this.store.get();
    const index = s.activePreset.value;
    if (index === null) throw new Error('No preset shown');
    const name = (s.presetNames.value[index] ?? '').trim();
    if (!name) {
      this.patchEdit({ preset: { ...s.edit.preset, nameNew: index } });
      return;
    }
    const frame = presetCreateFrame(index, name);
    this.presetBusy('create', index, name);
    await this.sendPreset(frame, `Save preset ${index + 1} "${name}"`);
  }

  /** Rename: stored on the pedal at once, answered by type 0x70. */
  async renamePreset(index: number, name: string): Promise<void> {
    this.assertEdit();
    const problem = this.nameProblem(index, name);
    if (problem) throw new Error(problem);
    const frame = presetRenameFrame(index, name);
    this.presetBusy('rename', index, name);
    await this.sendPreset(frame, `Rename preset ${index + 1} → "${name}"`);
  }

  /** Cortex Cloud's "create preset": the shown preset stored as `index` under `name` (an empty slot named). */
  async createPreset(index: number, name: string): Promise<void> {
    this.assertEdit();
    const problem = this.nameProblem(index, name);
    if (problem) throw new Error(problem);
    const frame = presetCreateFrame(index, name);
    this.presetBusy('create', index, name);
    const p = this.store.get().edit.preset;
    if (p.nameNew === index) this.patchEdit({ preset: { ...p, nameNew: null } });
    await this.sendPreset(frame, `Create preset ${index + 1} "${name}"`);
  }

  async deletePreset(index: number): Promise<void> {
    this.assertEdit();
    const frame = presetDeleteFrame(index);
    this.presetBusy('delete', index, this.store.get().presetNames.value[index] ?? '');
    await this.sendPreset(frame, `Delete preset ${index + 1}`);
  }

  /** Put a preset on one of the pedal's footswitches; the pedal answers like a select and the dump shows it. */
  async assignFootswitch(index: number, footswitch: Footswitch): Promise<void> {
    this.assertEdit();
    await this.send(footswitchAssignFrame(index, footswitch), `Preset ${index + 1} → footswitch ${footswitch.toUpperCase()}`);
    this.host.confirm(400);
  }

  dismissNameNew(): void {
    const p = this.store.get().edit.preset;
    if (p.nameNew !== null) this.patchEdit({ preset: { ...p, nameNew: null } });
  }

  private onPresetReply(msgType: number, payload: Uint8Array, hex: string): void {
    const reply = decodePresetReply(payload);
    const kind = msgType === EDIT_MSG.RENAME_REPLY ? 'rename' : msgType === EDIT_MSG.PRESET_CREATED ? 'create' : 'delete';
    this.host.log(reply?.ok ? 'info' : 'warn', `Preset ${kind}${reply ? ` ${reply.preset + 1}` : ''}: ${reply?.ok ? 'ok' : 'refused'}`, hex);
    const busy = this.store.get().edit.preset.busy;
    const mine = (op: typeof busy) => !!op && !!reply && op.index === reply.preset && op.kind === kind;
    const op = mine(busy) ? busy : mine(this.lateOp) ? this.lateOp : null;
    if (!reply || !op) return; // not ours
    this.presetAnswer(reply.ok, reply.ok ? 'Done' : kind === 'delete' ? 'The pedal did not delete it' : 'The pedal did not accept this name', op);
  }

  /**
   * The pedal's save button: the preset's record takes the capture and IR it saved. A preset with no name stays
   * unnamed after a save (the pedal refuses renames of it, board 2026-10-10): like Cortex Cloud, ask for one (a create).
   */
  private onPresetSaved(hex: string): void {
    const s = this.store.get();
    const preset = s.activePreset.value;
    this.host.log('info', `Preset ${preset === null ? '?' : preset + 1} saved on the pedal`, hex);
    this.host.confirm(150);
    if (preset !== null) this.rememberSavedModels(preset, s.fxModels.value);
    const md = this.host.metadata();
    if (preset === null || !md) return;
    const presets = md.presets.slice();
    const rec = presets[preset];
    if (!rec) return;
    presets[preset] = { ...rec, captureName: s.captureName.value ?? rec.captureName, irShortName: s.irName.value ?? rec.irShortName };
    this.host.metadataChanged({ ...md, presets });
    if (!rec.name.trim()) this.patchEdit({ preset: { ...this.store.get().edit.preset, nameNew: preset } });
  }
}
