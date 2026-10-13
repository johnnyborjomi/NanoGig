/**
 * Observable gig-view store. Every device-derived field is wrapped in a
 * `Field<T>` that carries `provisional: true` and the source it came from, so
 * the UI can never mistake decoded BLE data for confirmed device truth.
 */
import { DEFAULT_LABEL_STYLE, DEFAULT_PRESETS_PER_BANK, PRESET_COUNT, TUNER_REFERENCE_DEFAULT_HZ, type FxSlot, type PresetLabelStyle } from '../protocol/frames';
import type { LogLine, TransportStatus } from '../transport/types';
import type { FxModelsBySlot } from '../protocol/models';
import type { CabSettings, LibraryItem, LibraryKind } from '../protocol/edit';
import { EMPTY_EXPRESSION_VALUES, type ExpressionAssignments, type ExpressionValues, type FootswitchAssignments, type TunerReading } from '../protocol/decode';

/** 'cache' = restored from the last session's metadata, pending a background refresh. */
export type FieldSource = 'none' | 'dump' | 'metadata' | 'cache' | 'event' | 'inferred' | 'optimistic';

export interface Field<T> {
  value: T;
  provisional: true;
  source: FieldSource;
  updatedAt: number | null;
}

export type SyncPhase = 'idle' | 'metadata' | 'state' | 'ready' | 'error';

/** Expression pedal as the pedal reports it (see docs/PROTOCOL.md "Expression pedal"). */
export interface ExpressionState {
  /** Last position 0–254 and when it moved; null until the pedal has moved on this link. */
  position: number | null;
  movedAt: number | null;
  /** What the pedal produced for the assigned targets (ranges 0–255, bypasses on/off), with their time. */
  values: ExpressionValues;
  valuesAt: number | null;
  /** Assignments of `assignmentsPreset` (read after every preset change); null until read. */
  assignments: ExpressionAssignments | null;
  assignmentsPreset: number | null;
}

/** The pedal's tuner as far as the app knows (protocol captured 2026-09-19; see docs/PROTOCOL.md "Tuner"). */
export interface TunerState {
  /**
   * The pedal's tuner is running: set by our tuner-on write, by the pedal's tuner report
   * (type 0x7F, also sent for its own footswitch tuner) or by an incoming pitch reading;
   * cleared by our tuner-off write or the pedal reporting off.
   */
  on: boolean;
  /** Reference pitch: from the last tuner-on write or the pedal's report; seeded from state field 46 when known. */
  referenceHz: number;
  /** The tuner's own mute switch (field 7 of the tuner-on write). */
  muted: boolean;
  /** Latest pitch reading and when it arrived; null in silence (the pedal sends nothing then). */
  reading: TunerReading | null;
  readingAt: number | null;
}

/** The FX editor's block: its parameters as the pedal last reported them (0..1 each, the model's order). */
export interface FxEditState {
  slot: FxSlot;
  /** Model type the values belong to (state field 48-52 as a varint). */
  type: number;
  preset: number | null;
  values: number[] | null;
  /** loading: a read is out (on or off alike: Cortex Cloud reads a bypassed block); unknown: no parameter table. */
  status: 'loading' | 'ready' | 'empty' | 'unknown' | 'error';
}

/** The IR panel: the settings of the IR the preset plays (type 0x60 reply). */
export interface IrEditState {
  preset: number | null;
  slot: number | null;
  settings: CabSettings | null;
  /** loading: a read is out; off: off and never read in this preset (the pedal does not answer for an IR that is off). */
  status: 'loading' | 'ready' | 'off' | 'error';
}

/** Every capture and IR on the pedal (type 0x4D reply), kept for the session. */
export interface LibraryState {
  captures: LibraryItem[] | null;
  irs: LibraryItem[] | null;
  loading: LibraryKind | null;
  error: string | null;
}

/** A preset write in flight (rename / create / delete) and the last answer. */
export interface PresetOpState {
  busy: { kind: 'rename' | 'create' | 'delete'; index: number; name: string } | null;
  result: { kind: 'rename' | 'create' | 'delete'; index: number; ok: boolean; message: string; at: number } | null;
  /** The pedal saved an unnamed preset (its own save button): Cortex Cloud asks for a name, so does the app. */
  nameNew: number | null;
}

/**
 * The FX models a preset has saved, as far as the app can tell (the pedal does not report it): the models it showed
 * when it loaded, and what it showed when the pedal's save button was pressed. Model ids by slot, null = empty.
 */
export interface SavedModels {
  preset: number;
  ids: Record<FxSlot, string | null>;
}

/**
 * Each block's parameters as the preset has them saved: the first read of a block on its saved model after the
 * preset loaded or was saved (the pedal's own controls do not reach FX parameters, so that read is the saved one).
 */
export interface SavedParams {
  preset: number;
  slots: Partial<Record<FxSlot, { type: number; values: number[] }>>;
}

/**
 * The capture, IR and gate as the preset has them saved, taken with the saved models: slots, capture volume, the
 * IR's name and the gate threshold from the state, the IR's settings from its first read on the saved IR.
 */
export interface SavedSource {
  preset: number;
  /** Field 11 as read: 1..5, 6 = the preset's own, 0 = off. */
  captureSlot: number | null;
  /** Field 9: the bank that slot counts in. */
  captureBank: number | null;
  captureVolume: number | null;
  /** Field 12 while on (6 = the preset's own IR), null = off. */
  cabSlot: number | null;
  irName: string | null;
  gateThreshold: number | null;
  ir: CabSettings | null;
}

/**
 * A library capture heard in the preset's own place: Cortex Cloud's preview, which the pedal plays until it is
 * stopped (`capturePreviewStopFrame`). The pedal shows no save light for it, but a Save keeps it as the preset's own
 * capture. `kept`: loaded into the preset's own (the app shows Save); else only listened to from the library (stopped
 * when the library closes).
 */
export interface CapturePreview {
  preset: number;
  name: string;
  kept: boolean;
}

export interface EditState {
  fx: FxEditState | null;
  ir: IrEditState | null;
  library: LibraryState;
  preset: PresetOpState;
  savedModels: SavedModels | null;
  savedParams: SavedParams | null;
  savedSource: SavedSource | null;
  capturePreview: CapturePreview | null;
  /** A library IR played from the library (Cortex Cloud's IR preview, 0x9E) until it is stopped or one is loaded. */
  irPreview: { preset: number; name: string } | null;
}

export function emptyEdit(): EditState {
  return {
    fx: null,
    ir: null,
    library: { captures: null, irs: null, loading: null, error: null },
    preset: { busy: null, result: null, nameNew: null },
    savedModels: null,
    savedParams: null,
    savedSource: null,
    capturePreview: null,
    irPreview: null,
  };
}

export interface GigState {
  connection: TransportStatus;
  transportName: string;
  deviceName: string | null;
  syncPhase: SyncPhase;
  lastError: string | null;
  writesEnabled: boolean;
  /** User setting: how many presets one bank of their MIDI controller spans (label only). */
  presetsPerBank: number;
  /** User setting: "number-letter" (1B, Mvave) or "letter-number" (A2, Nano). */
  labelStyle: PresetLabelStyle;
  /** User setting: show the pedal's absolute preset number (1–64) after the bank label. */
  showPresetNumber: boolean;
  /** User setting: show which of the Nano's own footswitches (IA, IB, IIA, IIB) a preset is assigned to. */
  showFootswitches: boolean;
  /** User setting: show the preset strip under the FX tiles (off = simpler view; control mode still works for tiles/labels). */
  showPresetStrip: boolean;
  /**
   * User setting: re-read the preset names once per connect after the pedal has been idle for a
   * while (cached names only). The ~6 s stream delays any footswitch press made during it.
   */
  autoRefreshNames: boolean;
  /**
   * User setting: show a compact note / flat / sharp indicator in the top bar whenever the
   * pedal's tuner is running (started on the pedal or from Menu → Tuner). Passive: it never
   * switches the pedal's tuner on; with it on, closing the full-screen tuner leaves the pedal
   * in tuner mode.
   */
  liveTuner: boolean;
  /**
   * User setting: show the expression pedal (position bar at the right edge, value tracks on the
   * FX blocks it controls). Always on screen while on, never while off; no fading (the screen
   * firmware's rule, 2026-09-27: a fade made the indicators feel laggy on stage).
   */
  expressionShow: boolean;
  /**
   * User setting (experimental, off by default): editing on top of control mode: hold an FX tile for its model and
   * parameters, tap the capture / IR line for their panel (volume, IR settings, the pedal's library), hold the preset
   * name to rename / manage it, the gate's threshold. Ported from the NanoGig Screen firmware; the frames are
   * Cortex Cloud's, but this app has not been tried on a pedal with them yet.
   */
  editing: boolean;
  /** A metadata (names) stream is in flight on a live link; footswitch events queue behind it. */
  namesRefreshing: boolean;
  /** PWA: the browser offered an install prompt and the app is not installed yet. */
  installable: boolean;
  /** PWA: a newer build's service worker is installed and waiting for a reload. */
  updateReady: boolean;

  presetNames: Field<string[]>;
  activePreset: Field<number | null>;
  fxOn: Field<Record<FxSlot, boolean | null>>;
  /** Model loaded in each FX slot (name/category from the catalogue), null = empty slot. */
  fxModels: Field<FxModelsBySlot>;
  /** The shown preset has unsaved changes (the pedal's save light): state field 41 and 0x73 notices. */
  presetDirty: Field<boolean | null>;
  gateOn: Field<boolean | null>;
  cabOn: Field<boolean | null>;
  captureName: Field<string | null>;
  captureOn: Field<boolean | null>;
  /** Whether the current capture maps to one of the pedal's 25 slots (needed to re-enable it). null = not known yet. */
  captureSlotKnown: Field<boolean | null>;
  /** Field 11 as sent: the capture slot 1..5, 6 = the preset's own capture, 0 = bypassed. */
  captureSlot: Field<number | null>;
  /** Field 9: the capture bank 1..5 the slot counts in. */
  captureBank: Field<number | null>;
  /** The pedal's 25 capture slots (5 banks of 5) by name, from the metadata; [] until read. */
  captureSlots: string[];
  /** The pedal's 5 IR slots by name (short name, else full), from the metadata; [] until read. */
  irSlots: string[];
  /** Capture volume, raw 0..255 (state field 44; captureVolumeDb for the readout). */
  captureVolume: Field<number | null>;
  /** Gate threshold, raw 0..255 (state field 53 × 255). */
  gateThreshold: Field<number | null>;
  /** Field 12 as sent: the IR slot 1..5 (6 = the preset's own IR), null = off / absent. */
  cabSlot: Field<number | null>;
  irName: Field<string | null>;
  /** Whether the current IR maps to one of the pedal's IR slots (needed to re-enable the cab). null = not known yet. */
  cabSlotKnown: Field<boolean | null>;
  firmware: Field<string | null>;
  /** Preset tempo in BPM (state field 56, provisional). */
  tempo: Field<number | null>;
  /** The pedal is in its tap tempo mode (event 0x91 with field 3, or state field 60). */
  tapTempo: boolean;
  /** Preset index assigned to each of the pedal's footswitches (state dump fields 14/15/38/39, event 0x1D). */
  footswitches: Field<FootswitchAssignments | null>;
  /**
   * Global "Mute Outputs 1/2" switch, read from the device-settings message (field 16) after
   * connect and after every change; 'optimistic' while a write is in flight, 'event' on the
   * pedal's ack, 'dump' once the settings re-read confirms it. null = not read yet.
   */
  outputsMuted: Field<boolean | null>;
  tuner: TunerState;
  expression: ExpressionState;
  edit: EditState;

  lastStateSyncAt: number | null;
  lastMetadataAt: number | null;
  lastEventAt: number | null;
  log: LogLine[];
}

export const LOG_CAP = 400;

export function emptyExpression(): ExpressionState {
  return {
    position: null,
    movedAt: null,
    values: EMPTY_EXPRESSION_VALUES,
    valuesAt: null,
    assignments: null,
    assignmentsPreset: null,
  };
}

function field<T>(value: T): Field<T> {
  return { value, provisional: true, source: 'none', updatedAt: null };
}

export function initialState(transportName = 'none'): GigState {
  return {
    connection: 'disconnected',
    transportName,
    deviceName: null,
    syncPhase: 'idle',
    lastError: null,
    writesEnabled: false,
    presetsPerBank: DEFAULT_PRESETS_PER_BANK,
    labelStyle: DEFAULT_LABEL_STYLE,
    showPresetNumber: false,
    showFootswitches: false,
    showPresetStrip: true,
    autoRefreshNames: true,
    liveTuner: true,
    expressionShow: true,
    editing: false,
    namesRefreshing: false,
    installable: false,
    updateReady: false,
    presetNames: field(Array.from({ length: PRESET_COUNT }, () => '')),
    activePreset: field<number | null>(null),
    fxOn: field<Record<FxSlot, boolean | null>>({ pre1: null, pre2: null, post1: null, post2: null, post3: null }),
    fxModels: field<FxModelsBySlot>({ pre1: null, pre2: null, post1: null, post2: null, post3: null }),
    presetDirty: field<boolean | null>(null),
    gateOn: field<boolean | null>(null),
    cabOn: field<boolean | null>(null),
    captureName: field<string | null>(null),
    captureOn: field<boolean | null>(null),
    captureSlotKnown: field<boolean | null>(null),
    captureSlot: field<number | null>(null),
    captureBank: field<number | null>(null),
    captureSlots: [],
    irSlots: [],
    captureVolume: field<number | null>(null),
    gateThreshold: field<number | null>(null),
    cabSlot: field<number | null>(null),
    irName: field<string | null>(null),
    cabSlotKnown: field<boolean | null>(null),
    firmware: field<string | null>(null),
    tempo: field<number | null>(null),
    tapTempo: false,
    footswitches: field<FootswitchAssignments | null>(null),
    outputsMuted: field<boolean | null>(null),
    tuner: { on: false, referenceHz: TUNER_REFERENCE_DEFAULT_HZ, muted: false, reading: null, readingAt: null },
    expression: emptyExpression(),
    edit: emptyEdit(),
    lastStateSyncAt: null,
    lastMetadataAt: null,
    lastEventAt: null,
    log: [],
  };
}

type FieldKeys = {
  [K in keyof GigState]: GigState[K] extends Field<unknown> ? K : never;
}[keyof GigState];

type FieldValue<K extends FieldKeys> = GigState[K] extends Field<infer V> ? V : never;

export class Store {
  private state: GigState;
  private listeners = new Set<(s: GigState) => void>();

  constructor(init?: Partial<GigState>) {
    this.state = { ...initialState(), ...(init ?? {}) };
  }

  get(): GigState {
    return this.state;
  }

  subscribe(fn: (s: GigState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  patch(partial: Partial<GigState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  setField<K extends FieldKeys>(key: K, value: FieldValue<K>, source: FieldSource, at = Date.now()): void {
    const next: Field<FieldValue<K>> = { value, provisional: true, source, updatedAt: at };
    this.state = { ...this.state, [key]: next };
    this.notify();
  }

  appendLog(line: LogLine): void {
    const log = this.state.log.length >= LOG_CAP ? this.state.log.slice(this.state.log.length - LOG_CAP + 1) : this.state.log.slice();
    log.push(line);
    this.state = { ...this.state, log };
    this.notify();
  }

  /** Reset device-derived fields (on disconnect) but keep names, since they rarely change. */
  clearDeviceState(): void {
    const s = initialState(this.state.transportName);
    this.state = {
      ...this.state,
      activePreset: s.activePreset,
      fxOn: s.fxOn,
      fxModels: s.fxModels,
      presetDirty: s.presetDirty,
      gateOn: s.gateOn,
      cabOn: s.cabOn,
      captureName: s.captureName,
      captureOn: s.captureOn,
      captureSlotKnown: s.captureSlotKnown,
      captureSlot: s.captureSlot,
      captureBank: s.captureBank,
      captureVolume: s.captureVolume,
      gateThreshold: s.gateThreshold,
      cabSlot: s.cabSlot,
      irName: s.irName,
      cabSlotKnown: s.cabSlotKnown,
      outputsMuted: s.outputsMuted,
      tuner: { ...this.state.tuner, on: false, reading: null, readingAt: null },
      tapTempo: false,
      expression: emptyExpression(),
      // The library is the pedal's, not the preset's: kept across a reconnect.
      edit: { ...emptyEdit(), library: { ...this.state.edit.library, loading: null } },
      namesRefreshing: false,
      syncPhase: 'idle',
    };
    this.notify();
  }

  private notify() {
    for (const fn of Array.from(this.listeners)) fn(this.state);
  }
}
