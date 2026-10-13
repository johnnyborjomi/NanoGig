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
  CAB_OWN_SLOT,
  CAPTURE_BANKS,
  CAPTURE_SELECT_SLOTS,
  EDIT_MSG,
  cabMicFrame,
  cabPhaseFrame,
  cabSelectFrame,
  cabSlotLoadFrame,
  capturePreviewFrame,
  capturePreviewStopFrame,
  irPreviewFrame,
  irPreviewStopFrame,
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
  type CabSettings,
  type Footswitch,
  type LibraryItem,
  type LibraryKind,
} from '../protocol/edit';
import { CAB_SLOT_COUNT, FX_SLOTS, captureSelectFrame, type FxSlot } from '../protocol/frames';
import { fromHex, toHex } from '../protocol/hex';
import { frameSingle } from '../protocol/reassembly';
import { lookupFxModel, type FxModelsBySlot } from '../protocol/models';
import type { CapturePreview, EditState, FxEditState, IrEditState, SavedModels, SavedParams, SavedSource, Store } from '../state/store';
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
  /** Load the shown preset again (as the pedal's EXIT): what it has saved plays, the save light off. */
  reloadPreset(): Promise<void>;
}

const PRESET_REPLY_TIMEOUT_MS = 3000;
/** How long a capture turned on for a library load may take to show on in a state read. */
const CAPTURE_ON_WAIT_MS = 2500;
/** How long a preview stop waits for the pedal's 0x95 before the next frame goes anyway. */
const PREVIEW_STOP_WAIT_MS = 1200;
/** How long an IR slot load waits for the pedal's 0x4F before its select goes anyway. */
const IR_LOAD_WAIT_MS = 1500;
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
  /** Resolves the IR slot load in flight on the pedal's 0x4F. */
  private irSlotLoaded: (() => void) | null = null;
  /** A preview was playing when a capture went into a slot: stopped once that slot is selected. */
  private stopAfterLoad: string | null = null;
  /** Resolves the preview stop in flight on the pedal's 0x95. */
  private previewStopped: (() => void) | null = null;
  /** A preview saved into the preset: once it is stopped and the preset loaded again, the next state read is what it has saved. */
  private resnapAfterStop: { preset: number; answered: boolean } | null = null;
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

  /**
   * The Log sheet's "send a frame" (protocol work on the pedal): `hex` is a frame's body (`... <type> 00 00 00`),
   * or a whole frame as the log prints it (`<len> C0 ...`, header stripped and made again, so a copied line can be
   * edited). The pedal's answer shows in the log. Edit mode only.
   */
  async sendFrameHex(hex: string): Promise<void> {
    this.assertEdit();
    let body = fromHex(hex);
    if (body.length >= 2 && body[1] === 0xc0) body = body.subarray(2);
    if (body.length < 4) throw new Error('A frame body ends with the type and 00 00 00');
    await this.send(frameSingle(body), `Frame (by hand)`);
    this.host.confirm(600);
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
      state.captureBank = s.captureBank.value ?? state.captureBank;
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
      case EDIT_MSG.CAPTURE_PREVIEW_STOPPED: {
        const done = this.previewStopped;
        this.previewStopped = null;
        this.host.log(decodeOk(payload) ? 'info' : 'warn', `Library capture preview stop ${decodeOk(payload) ? 'acknowledged' : 'refused'}`, hex);
        done?.();
        return true;
      }
      case EDIT_MSG.CAB_SLOT_LOADED: {
        const done = this.irSlotLoaded;
        this.irSlotLoaded = null;
        this.host.log(decodeOk(payload) ? 'info' : 'warn', `Library IR slot load ${decodeOk(payload) ? 'acknowledged' : 'refused'}`, hex);
        done?.();
        return true;
      }
      case EDIT_MSG.IR_PREVIEWED:
      case EDIT_MSG.CAPTURE_PREVIEWED:
        this.host.log(decodeOk(payload) ? 'info' : 'warn', `Library ${msgType === EDIT_MSG.IR_PREVIEWED ? 'IR preview' : 'capture preview'} ${decodeOk(payload) ? 'acknowledged' : 'refused'}`, hex);
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

  /**
   * A block with a model: readable and editable on or off. Cortex Cloud reads and edits a bypassed block (the
   * values are kept for when it is turned on, and saved), and the desktop editor rixrix/deskop-nano-cortex reads
   * every slot on each preset load. DrD85 once saw a crash reading a bypassed one; not seen since by those two.
   */
  private slotEditable(slot: FxSlot): boolean {
    return !!this.store.get().fxModels.value[slot];
  }

  /** What a read describes: the preset, the slot and its model. A change of any of them reads again (on / off does not change the values). */
  private fxKey(slot: FxSlot): string {
    return `${this.activePreset()}|${slot}|${this.slotType(slot)}`;
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
    if (!base || this.slotType(slot) !== base.type || !this.slotEditable(slot)) return;
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
   * A state read (once the store has it): a preset seen for the first time since it loaded has its saved models,
   * capture, IR and gate in place (the pedal drops unsaved edits on a preset load).
   */
  noteSaved(preset: number | null): void {
    const resnap = this.resnapAfterStop;
    if (resnap && resnap.answered && resnap.preset === preset) {
      // The slot it plays may have moved with the save (into the preset's own): take it as saved.
      this.resnapAfterStop = null;
      this.rememberSavedSource(preset);
      return;
    }
    if (preset === null || this.store.get().edit.savedModels?.preset === preset) return;
    this.rememberSavedModels(preset, this.store.get().fxModels.value);
  }

  private rememberSavedModels(preset: number, models: FxModelsBySlot): void {
    this.rememberSavedSource(preset);
    const ids = {} as SavedModels['ids'];
    for (const slot of FX_SLOTS) ids[slot] = models[slot]?.id ?? null;
    // Parameters are known only for blocks read since: the open one's values now, the others at their next read.
    const slots: SavedParams['slots'] = {};
    const fx = this.store.get().edit.fx;
    if (fx?.values && fx.status === 'ready' && fx.preset === preset && fx.type === fxModelType(ids[fx.slot])) slots[fx.slot] = { type: fx.type, values: fx.values.slice() };
    this.patchEdit({ savedModels: { preset, ids }, savedParams: { preset, slots } });
  }

  /** The capture, IR and gate shown now, as saved (a load or a save); the IR's settings if read on this IR. */
  private rememberSavedSource(preset: number): void {
    const s = this.store.get();
    const ir = s.edit.ir;
    this.patchEdit({
      savedSource: {
        preset,
        captureSlot: s.captureOn.value === false ? 0 : s.captureSlot.value,
        captureBank: s.captureBank.value,
        captureVolume: s.captureVolume.value,
        cabSlot: s.cabOn.value ? s.cabSlot.value : null,
        irName: s.irName.value,
        gateThreshold: s.gateThreshold.value,
        ir: ir?.status === 'ready' && ir.preset === preset && ir.settings ? { ...ir.settings } : null,
      },
      capturePreview: null, // a load or a save: what plays is the preset's
    });
  }

  /** The library capture heard over the shown preset's own (`previewCapture`), none once it is saved or put back. */
  capturePreview(): CapturePreview | null {
    const p = this.store.get().edit.capturePreview;
    return p && p.preset === this.store.get().activePreset.value ? p : null;
  }

  /** The preview playing goes into the preset's own: Save keeps it (the app shows Save; the pedal's light stays off). */
  keepCapturePreview(): void {
    const p = this.capturePreview();
    if (p && !p.kept) this.patchEdit({ capturePreview: { ...p, kept: true } });
  }

  /** The library closes: a preview only listened to stops (one kept for the preset's own stays). */
  async endAudition(): Promise<void> {
    const p = this.capturePreview();
    if (p && !p.kept) await this.stopCapturePreview();
    if (this.irPreview()) await this.stopIrPreview();
  }

  /** The library IR playing from the library (`previewIr`), none once stopped, loaded or the preset changed. */
  irPreview(): { preset: number; name: string } | null {
    const p = this.store.get().edit.irPreview;
    return p && p.preset === this.store.get().activePreset.value ? p : null;
  }

  /** Forget an IR preview without sending anything (a preset load ends it). */
  clearIrPreview(): void {
    if (this.store.get().edit.irPreview) this.patchEdit({ irPreview: null });
  }

  /**
   * Hear a library IR, as Cortex Cloud's tap on one (0x9E; snoop 2026-10-11): until another, a load or the stop.
   * Only onto an IR that is on (the library is closed while it is off; a capture preview onto an off capture hung
   * the pedal).
   */
  async previewIr(item: LibraryItem): Promise<void> {
    this.assertEdit();
    if (this.store.get().cabOn.value !== true) throw new Error('Turn the IR on first');
    const running = this.irPreview();
    if (running) {
      this.clearIrPreview();
      await this.sendPreviewStop(`Stop the IR preview "${running.name}" (another follows)`, 'ir');
    }
    this.writtenAt.ir = Date.now();
    this.store.setField('irName', item.name, 'optimistic');
    const preset = this.activePreset();
    await this.send(irPreviewFrame(item), `Preview ${item.list} IR ${item.index + 1} "${item.name}"`);
    if (preset !== null) this.patchEdit({ irPreview: { preset, name: item.name } });
    this.host.confirm(600);
  }

  /** Stop an IR preview (Cortex Cloud's stop with field 4): what the preset plays is heard again. */
  async stopIrPreview(): Promise<void> {
    this.assertEdit();
    const p = this.irPreview();
    if (!p) return;
    this.clearIrPreview();
    await this.sendPreviewStop(`Stop the IR preview "${p.name}"`, 'ir');
    this.host.confirm();
  }

  /** Forget a preview without sending anything (the preset is being loaded again, which puts its own capture back). */
  clearCapturePreview(): void {
    if (this.store.get().edit.capturePreview) this.patchEdit({ capturePreview: null });
  }

  /**
   * Stop a preview, as Cortex Cloud's stop button does (HCI snoop 2026-10-11): the pedal plays the saved capture
   * again and answers 0x95. Neither a reselect of the preset's own capture (the preview sits in that position) nor a
   * load of the shown preset ended one (board, 2026-10-11).
   */
  async stopCapturePreview(): Promise<void> {
    this.assertEdit();
    const p = this.capturePreview();
    if (!p) return;
    this.clearCapturePreview();
    const own = this.ownCaptureName();
    if (own) this.store.setField('captureName', own, 'optimistic');
    await this.sendPreviewStop(`Stop the capture preview "${p.name}"`);
    this.host.confirm();
  }

  /** The stop frame (a capture's, or an IR's), resolved on the pedal's 0x95 (or after a while: the next frame goes anyway). */
  private async sendPreviewStop(label: string, kind: 'capture' | 'ir' = 'capture'): Promise<void> {
    this.writtenAt[kind] = Date.now();
    const answered = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.previewStopped === done) this.previewStopped = null;
        resolve();
      }, PREVIEW_STOP_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.previewStopped = done;
    });
    await this.send(kind === 'ir' ? irPreviewStopFrame() : capturePreviewStopFrame(), label);
    await answered;
  }

  private savedSourceNow(): SavedSource | null {
    const saved = this.store.get().edit.savedSource;
    return saved && saved.preset === this.store.get().activePreset.value ? saved : null;
  }

  /** The capture differs from the preset as saved: a library capture previewed over it, its slot (while on) or its volume. */
  captureChanged(): boolean {
    if (this.capturePreview()) return true;
    const b = this.savedSourceNow();
    const s = this.store.get();
    if (!b) return false;
    if (b.captureVolume !== null && s.captureVolume.value !== null && s.captureVolume.value !== b.captureVolume) return true;
    return this.captureMoved(b);
  }

  /** Another capture than saved while on: another slot, or (for slots 1..5) another bank. */
  private captureMoved(b: SavedSource): boolean {
    const s = this.store.get();
    if (!b.captureSlot || s.captureOn.value !== true) return false;
    if (s.captureSlot.value !== b.captureSlot) return true;
    return b.captureSlot !== CAPTURE_OWN_SLOT && b.captureBank !== null && s.captureBank.value !== null && s.captureBank.value !== b.captureBank;
  }

  /** Discard the capture's edits: a preview stopped, its saved slot (6: the preset's own) and volume. On / off stays as it is. */
  async discardCapture(): Promise<void> {
    this.assertEdit();
    await this.stopCapturePreview();
    const b = this.savedSourceNow();
    const s = this.store.get();
    if (!b) return;
    if (b.captureSlot && this.captureMoved(b)) {
      if (b.captureSlot === CAPTURE_OWN_SLOT || b.captureBank === null) await this.selectCaptureSlot(b.captureSlot);
      else await this.selectCapture(b.captureBank, b.captureSlot);
    }
    if (b.captureVolume !== null && s.captureVolume.value !== b.captureVolume) this.setCaptureVolume(b.captureVolume);
  }

  /** The gate's threshold differs from the preset as saved. */
  gateChanged(): boolean {
    const b = this.savedSourceNow();
    const v = this.store.get().gateThreshold.value;
    return !!b && b.gateThreshold !== null && v !== null && v !== b.gateThreshold;
  }

  /** Discard the gate's edit: its saved threshold. On / off stays as it is. */
  discardGate(): void {
    this.assertEdit();
    const b = this.savedSourceNow();
    if (b && b.gateThreshold !== null && this.gateChanged()) this.setGateThreshold(b.gateThreshold);
  }

  /** What of the IR differs from the preset as saved: the IR itself (slot or a library IR), or its settings. */
  private irDiff(): { ir: boolean; settings: (keyof CabSettings)[] } {
    const b = this.savedSourceNow();
    const s = this.store.get();
    const settings: (keyof CabSettings)[] = [];
    if (!b) return { ir: false, settings };
    const ir = !!b.cabSlot && s.cabOn.value === true && (s.cabSlot.value !== b.cabSlot || (s.irName.value ?? '') !== (b.irName ?? ''));
    const cur = s.edit.ir;
    if (!ir && b.ir && cur?.status === 'ready' && cur.settings && cur.preset === b.preset && cur.settings.irName === b.ir.irName) {
      for (const k of ['level', 'highPass', 'lowPass'] as const) if (Math.abs(cur.settings[k] - b.ir[k]) > 1e-4) settings.push(k);
      if (cur.settings.phaseInverted !== b.ir.phaseInverted) settings.push('phaseInverted');
      if (b.ir.factory && (cur.settings.mic !== b.ir.mic || cur.settings.position !== b.ir.position)) settings.push('mic');
    }
    return { ir, settings };
  }

  irChanged(): boolean {
    const d = this.irDiff();
    return d.ir || d.settings.length > 0;
  }

  /**
   * Discard the IR's edits: the saved IR back (its slot; 6 brings the preset's own back, a library IR included),
   * then its saved settings, then a read so the panel shows what the pedal has. On / off stays as it is.
   */
  async discardIr(): Promise<void> {
    this.assertEdit();
    const b = this.savedSourceNow();
    if (!b) return;
    const d = this.irDiff();
    if (d.ir && b.cabSlot) await this.selectIrSlot(b.cabSlot);
    const base = b.ir;
    if (base) {
      for (const key of Array.from(this.queued.keys())) if (key.startsWith('ir:')) this.queued.delete(key);
      // After the IR came back every setting goes (the pedal may load its own); otherwise only the changed ones.
      const all = d.ir;
      for (const k of ['level', 'highPass', 'lowPass'] as const) {
        if (all || d.settings.includes(k)) await this.send(cabSettingFrame(k, base[k]), `IR ${k} → ${base[k].toFixed(4)} (discard)`);
      }
      if (all || d.settings.includes('phaseInverted')) await this.send(cabPhaseFrame(base.phaseInverted), `IR phase → ${base.phaseInverted ? 'inverted' : 'normal'} (discard)`);
      if (base.factory && (all || d.settings.includes('mic'))) {
        await this.send(cabMicFrame(base.kind, base.irName, base.position, base.mic), `IR "${base.irName}" mic "${base.mic}" position ${base.position + 1} (discard)`);
      }
      const ir = this.store.get().edit.ir;
      if (ir?.settings) this.patchEdit({ ir: { ...ir, settings: { ...ir.settings, ...base, mics: ir.settings.mics } } });
    }
    if (this.store.get().edit.ir) this.irTick(true);
  }

  /** The first read of the saved IR since the preset loaded or was saved: its saved settings. */
  private noteSavedIr(cs: CabSettings): void {
    const b = this.savedSourceNow();
    const s = this.store.get();
    if (!b || b.ir || !b.cabSlot) return;
    // The saved IR: its slot, and its name (a library IR may sit in the preset).
    if (this.irPanelSlot() !== b.cabSlot || (s.irName.value ?? '') !== (b.irName ?? '')) return;
    this.patchEdit({ savedSource: { ...b, ir: { ...cs } } });
  }

  /** One parameter, live while a slider moves; the editor shows the value at once. */
  setFxParam(slot: FxSlot, param: number, normalized: number): void {
    this.assertEdit();
    if (!this.slotEditable(slot)) throw new Error('No model in this slot');
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
  /** The name of the capture the shown preset has saved in itself (slot 6), from the metadata. */
  ownCaptureName(): string {
    return this.host.metadata()?.presets[this.activePreset() ?? -1]?.captureName ?? '';
  }

  /** The name of the IR the shown preset has saved in itself (IR slot 6), from the metadata. */
  ownIrName(): string {
    return this.host.metadata()?.presets[this.activePreset() ?? -1]?.irShortName ?? '';
  }

  /** Where the active capture bank starts among the pedal's 25 slots (bank 1 → 0). */
  private captureBankOffset(): number {
    return ((this.store.get().captureBank.value ?? 1) - 1) * CAPTURE_SELECT_SLOTS;
  }

  captureSlotForEdit(): number {
    const s = this.store.get();
    const cur = s.captureSlot.value ?? 0;
    if (s.captureOn.value && cur >= 1 && cur <= CAPTURE_SELECT_SLOTS) return cur;
    if (this.lastCapture && this.lastCapture.preset === s.activePreset.value) return this.lastCapture.slot;
    const md = this.host.metadata();
    const preset = s.activePreset.value;
    const saved = preset !== null ? md?.presets[preset]?.captureName.trim().toLowerCase() : '';
    if (md && saved) {
      const from = this.captureBankOffset();
      const i = md.captures.slice(from, from + CAPTURE_SELECT_SLOTS).findIndex((c) => c.name.trim().toLowerCase() === saved);
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
      const name = slot <= CAPTURE_SELECT_SLOTS ? md?.captures[this.captureBankOffset() + slot - 1]?.name : md?.presets[this.activePreset() ?? -1]?.captureName;
      if (name) this.store.setField('captureName', name, 'optimistic');
    } else {
      this.store.setField('captureOn', false, 'optimistic');
    }
    const preview = this.capturePreview();
    this.clearCapturePreview(); // a slot plays now (6: the preset's own, as saved)
    await this.send(frame, slot ? `Capture slot ${slot}${slot === CAPTURE_OWN_SLOT ? " (the preset's own)" : ''}` : 'Capture off');
    await this.endPreviewAfterSelect(preview);
    this.host.confirm();
  }

  /** A slot selected while a preview played: the stop follows (Cortex Cloud's order after its "Use"). */
  private async endPreviewAfterSelect(preview: CapturePreview | null): Promise<void> {
    if (preview) await this.sendPreviewStop(`Stop the capture preview "${preview.name}" (a slot was selected)`);
  }

  /**
   * A capture slot in any bank (1..5 each): in the active bank by its position (selector 1, as the pedal's own
   * encoder), in another by bank and capture (selector 4, slot 0..24, as Cortex Cloud and DrD85 select them).
   */
  async selectCapture(bank: number, position: number): Promise<void> {
    this.assertEdit();
    if (!Number.isInteger(bank) || bank < 1 || bank > 5 || !Number.isInteger(position) || position < 1 || position > CAPTURE_SELECT_SLOTS) throw new RangeError(`bad capture ${bank}/${position}`);
    if (bank === (this.store.get().captureBank.value ?? 1)) return this.selectCaptureSlot(position);
    const abs = (bank - 1) * CAPTURE_SELECT_SLOTS + position;
    this.writtenAt.capture = Date.now();
    this.store.setField('captureOn', true, 'optimistic');
    this.store.setField('captureBank', bank, 'optimistic');
    this.store.setField('captureSlot', position, 'optimistic');
    const name = this.host.metadata()?.captures[abs - 1]?.name;
    if (name) this.store.setField('captureName', name, 'optimistic');
    const preview = this.capturePreview();
    this.clearCapturePreview();
    await this.send(captureSelectFrame(abs), `Capture bank ${bank} slot ${position}`);
    await this.endPreviewAfterSelect(preview);
    this.host.confirm();
  }

  async setCaptureOn(on: boolean): Promise<void> {
    if (on === (this.store.get().captureOn.value === true)) return;
    await this.selectCaptureSlot(on ? this.captureSlotForEdit() : 0);
  }

  /**
   * The previous / next of all 25 slots, over the banks (bank 1 slot 5 → bank 2 slot 1, wrapping). From the preset's
   * own capture (6) or off: next is slot 1 of the bank playing, previous the slot before it.
   */
  async stepCapture(delta: number): Promise<void> {
    const s = this.store.get();
    const per = CAPTURE_SELECT_SLOTS;
    const total = CAPTURE_BANKS * per;
    const bank = s.captureBank.value ?? 1;
    const cur = s.captureOn.value ? (s.captureSlot.value ?? 0) : this.captureSlotForEdit();
    const at = cur >= 1 && cur <= per ? (bank - 1) * per + cur : (bank - 1) * per + (delta > 0 ? 0 : 1);
    const next = ((((at - 1 + (delta > 0 ? 1 : -1)) % total) + total) % total) + 1;
    await this.selectCapture(Math.floor((next - 1) / per) + 1, ((next - 1) % per) + 1);
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
    const preview = this.irPreview();
    this.clearIrPreview();
    await this.send(frame, slot ? `IR slot ${slot}` : 'IR off');
    if (preview) await this.sendPreviewStop(`Stop the IR preview "${preview.name}" (a slot was selected)`, 'ir');
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

  /** The IR slot the panel describes: the one playing, or (off) the one "on" goes to. */
  private irPanelSlot(): number {
    const s = this.store.get();
    return s.cabOn.value ? (s.cabSlot.value ?? 1) : this.irSlotForOn();
  }

  /** What a read describes: the preset, the IR, and on / off (turning it on reads it again; off is never asked). */
  private irKey(): string {
    const s = this.store.get();
    return `${s.activePreset.value}|${this.irPanelSlot()}|${s.irName.value ?? ''}|${s.cabOn.value ? 'on' : 'off'}`;
  }

  /** The last settings read per preset and IR slot: what an IR that is off shows (the pedal does not answer for it). */
  private readonly irSeen = new Map<string, CabSettings>();

  openIr(): void {
    this.irAsked = null;
    this.patchEdit({ ir: { preset: this.activePreset(), slot: this.store.get().cabSlot.value, settings: null, status: 'loading' } });
    this.irTick();
  }

  closeIr(): void {
    // Its values as last shown (edits included): what it shows again while off.
    const ir = this.store.get().edit.ir;
    if (ir?.status === 'ready' && ir.settings && ir.slot !== null) this.irSeen.set(`${ir.preset}|${ir.slot}`, ir.settings);
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
    const preset = this.activePreset();
    const slot = this.irPanelSlot();
    const same = ir.preset === preset && ir.slot === slot;
    if (!this.store.get().cabOn.value) {
      // Off: the pedal leaves a read unanswered (board, 2026-10-11). Shown from what was read of it (the panel's own
      // values when it was just turned off, else the last read, else its saved settings), still editable.
      if (this.irTimer) clearTimeout(this.irTimer);
      this.irTimer = null;
      const saved = this.savedSourceNow();
      const known = (same && ir.settings) || this.irSeen.get(`${preset}|${slot}`) || (saved?.cabSlot === slot ? saved.ir : null) || null;
      this.patchEdit({ ir: { preset, slot, settings: known, status: known ? 'ready' : 'off' } });
      return;
    }
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
    // Kept even when the picture moved on (the IR turned off meanwhile): an IR that is off shows it.
    const seen = read?.key.split('|').slice(0, 2).join('|');
    if (cs && seen) this.irSeen.set(seen, cs);
    if (ir?.status === 'off' && cs && seen === `${ir.preset}|${ir.slot}`) {
      this.patchEdit({ ir: { ...ir, settings: cs, status: 'ready' } });
      return;
    }
    if (!ir || !read || this.irReads.length > 0) return;
    if (read.key !== this.irKey()) return;
    if (this.irTimer) clearTimeout(this.irTimer);
    this.irTimer = null;
    this.patchEdit({ ir: { ...ir, settings: cs, status: cs ? 'ready' : 'error' } });
    if (cs) this.noteSavedIr(cs);
  }

  private irWritable(): IrEditState {
    this.assertEdit();
    const ir = this.store.get().edit.ir;
    if (!ir) throw new Error('IR panel closed');
    if (ir.status === 'off') throw new Error('Turn the IR on once to read its settings');
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
   * A library capture goes the way of Cortex Cloud's "Use" (and the firmware's capture list): into the slot the
   * preset plays (`captureSlotForEdit`), then that slot is selected (on the pedal's 0x51), which marks the preset
   * edited: the save light comes on, Save keeps it, Discard puts the saved one back. A saved preset keeps its own
   * copy of a capture, so the others on that slot keep theirs. An IR goes the same way, into an IR slot
   * (`loadIrIntoSlot`): the pedal has no load into the preset itself.
   */
  async pickFromLibrary(item: LibraryItem, kind: LibraryKind): Promise<void> {
    this.assertEdit();
    if (kind === 'irs') return this.loadIrIntoSlot(item);
    const slot = this.captureSlotForEdit();
    // Listened to first (the library's tap): Cortex Cloud stops the preview after its "Use" (snoop 2026-10-11).
    this.stopAfterLoad = this.capturePreview()?.name ?? null;
    this.clearCapturePreview();
    this.loadingCaptureSlot = slot;
    this.writtenAt.capture = Date.now();
    this.store.setField('captureOn', true, 'optimistic');
    this.store.setField('captureName', item.name, 'optimistic');
    // The pedal's slots are 0..24 over the five banks: the active bank's.
    const abs = this.captureBankOffset() + slot - 1;
    await this.send(captureSlotLoadFrame(abs, item), `Load ${item.list} capture ${item.index + 1} "${item.name}" into bank ${Math.floor(abs / CAPTURE_SELECT_SLOTS) + 1} slot ${slot}`);
    const md = this.host.metadata();
    if (md && md.captures[abs]) {
      const captures = md.captures.slice();
      captures[abs] = { ...captures[abs]!, name: item.name };
      this.host.metadataChanged({ ...md, captures });
    }
    this.host.confirm(1500); // in case the 0x51 never comes
  }

  /**
   * Hear a library capture over the preset's own, no slot of the pedal's touched: Cortex Cloud's preview (its play
   * button on a library capture). The pedal plays it until `stopCapturePreview` (Cortex Cloud's stop) or a slot
   * select, and does NOT mark the preset edited (no save light: board 2026-10-11). The pedal has no command that
   * writes a capture into the preset itself; the load it counts as an edit is `pickFromLibrary` (Cortex Cloud's and
   * the firmware's way: a slot write, then its select). The app keeps the books of the preview (`capturePreview`).
   *
   * Only onto a capture that is on: a preview sent while the capture was off hung the pedal (board, 2026-10-11).
   * An off capture is first turned on as the preset's own (slot 6), and the preview goes only once a state read
   * shows it on; otherwise nothing is sent.
   */
  async previewCapture(item: LibraryItem): Promise<void> {
    this.assertEdit();
    if (this.store.get().captureOn.value !== true || this.store.get().captureOn.source !== 'dump') {
      if (this.store.get().captureOn.value !== true) await this.selectCaptureSlot(CAPTURE_OWN_SLOT);
      const on = await this.waitForState(() => {
        const c = this.store.get().captureOn;
        return c.value === true && c.source === 'dump';
      }, CAPTURE_ON_WAIT_MS);
      if (!on) throw new Error('The capture did not turn on: nothing loaded');
    }
    // One preview at a time: Cortex Cloud stops each before the next (snoop 2026-10-11).
    const running = this.capturePreview();
    if (running) {
      this.clearCapturePreview();
      await this.sendPreviewStop(`Stop the capture preview "${running.name}" (another follows)`);
    }
    this.writtenAt.capture = Date.now();
    this.store.setField('captureName', item.name, 'optimistic');
    const preset = this.activePreset();
    await this.send(capturePreviewFrame(item), `Load ${item.list} capture ${item.index + 1} "${item.name}" into the preset's own (a preview: Save keeps it)`);
    if (preset !== null) this.patchEdit({ capturePreview: { preset, name: item.name, kept: false } });
    this.host.confirm(600);
  }

  /** Resolves true once `ok` holds after a store change (state reads are asked meanwhile), false after `ms`. */
  private waitForState(ok: () => boolean, ms: number): Promise<boolean> {
    if (ok()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      off = this.store.subscribe(() => {
        if (!ok()) return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
      this.host.confirm();
    });
  }

  /** The IR slot a library IR goes into: the one playing (1..5), else the one "on" goes to, else 1. */
  irLoadSlot(): number {
    const s = this.store.get();
    const cur = s.cabOn.value ? (s.cabSlot.value ?? 0) : 0;
    if (cur >= 1 && cur <= CAB_SLOT_COUNT) return cur;
    const on = this.irSlotForOn();
    return on >= 1 && on <= CAB_SLOT_COUNT ? on : 1;
  }

  /**
   * A library IR into one of the pedal's 5 IR slots (saved presets on it keep theirs), or into the preset's own IR
   * slot (6), then that slot selected: Cortex Cloud's IR load (type 0x4E → 0x4F, the slot select after the ack;
   * the own slot is index 5, snoop 2026-10-11). A preview playing is stopped first, as Cortex Cloud does.
   */
  async loadIrIntoSlot(item: LibraryItem, slot = this.irLoadSlot()): Promise<void> {
    this.assertEdit();
    const preview = this.irPreview();
    if (preview) {
      this.clearIrPreview();
      await this.sendPreviewStop(`Stop the IR preview "${preview.name}" (one is loaded)`, 'ir');
    }
    const own = slot === CAB_OWN_SLOT;
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.irSlotLoaded === done) this.irSlotLoaded = null;
        resolve();
      }, IR_LOAD_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.irSlotLoaded = done;
    });
    await this.send(cabSlotLoadFrame(slot - 1, item), `Load ${item.list} IR ${item.index + 1} "${item.name}" into ${own ? "the preset's own IR slot" : `IR slot ${slot}`}`);
    const md = this.host.metadata();
    if (!own && md && md.irs[slot - 1]) {
      const irs = md.irs.slice();
      irs[slot - 1] = { ...irs[slot - 1]!, shortName: item.name, fullName: item.name };
      this.host.metadataChanged({ ...md, irs });
    }
    await loaded;
    await this.selectIrSlot(slot);
    if (own) this.store.setField('irName', item.name, 'optimistic');
  }

  /** Into the preset's own IR slot: this preset alone (an edit Save keeps; no slot of the pedal's written). */
  loadIrIntoOwn(item: LibraryItem): Promise<void> {
    return this.loadIrIntoSlot(item, CAB_OWN_SLOT);
  }

  private onCaptureLoaded(ok: boolean, hex: string): void {
    const slot = this.loadingCaptureSlot;
    this.loadingCaptureSlot = null;
    this.host.log(ok ? 'info' : 'warn', `Capture load ${ok ? 'acknowledged' : 'refused'}`, hex);
    const preview = this.stopAfterLoad;
    this.stopAfterLoad = null;
    const stop = () => (preview ? this.sendPreviewStop(`Stop the capture preview "${preview}" (a slot was loaded)`).then(() => this.host.confirm()) : Promise.resolve());
    if (!ok || slot === null) {
      void stop().catch((err) => this.host.log('warn', `Preview stop failed: ${(err as Error).message}`));
      this.host.confirm();
      return;
    }
    void this.selectCaptureSlot(slot)
      .then(stop)
      .catch((err) => this.host.log('warn', `Capture select failed: ${(err as Error).message}`));
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
      // A create stores the shown preset: its capture and IR are the saved ones now (a preview's capture included).
      const s = this.store.get();
      if (busy.kind === 'create' && s.activePreset.value === busy.index) {
        rec.captureName = this.capturePreview()?.name ?? s.captureName.value ?? '';
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
      const preview = this.capturePreview();
      this.rememberSavedModels(busy.index, shown.fxModels.value);
      if (preview) {
        // Saved with a preview playing: the preset keeps that capture as its own (slot 6; board, 2026-10-13), but
        // the pedal stays in its preview (later previews went unheard) and still plays the slot it had: a stop alone
        // put the bank capture back with the save light on (board, 2026-10-13). So: the stop, then the preset loaded
        // again, which plays what it has saved (its own, the previewed capture) with the light off. The state read
        // after that load is what the preset has saved.
        this.resnapAfterStop = { preset: busy.index, answered: false };
        this.store.setField('captureName', preview.name, 'optimistic');
        void this.sendPreviewStop(`Stop the preview "${preview.name}" (saved into the preset)`)
          .then(() => this.host.reloadPreset())
          .then(() => {
            if (this.resnapAfterStop) this.resnapAfterStop.answered = true;
            this.host.confirm();
          })
          .catch((err) => this.host.log('warn', `After saving the preview: ${(err as Error).message}`));
        return;
      }
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
