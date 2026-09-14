/**
 * Observable gig-view store. Every device-derived field is wrapped in a
 * `Field<T>` that carries `provisional: true` and the source it came from, so
 * the UI can never mistake decoded BLE data for confirmed device truth.
 */
import { DEFAULT_LABEL_STYLE, DEFAULT_PRESETS_PER_BANK, PRESET_COUNT, type FxSlot, type PresetLabelStyle } from '../protocol/frames';
import type { LogLine, TransportStatus } from '../transport/types';
import type { FxModelsBySlot } from '../protocol/models';

export type FieldSource = 'none' | 'dump' | 'metadata' | 'event' | 'inferred' | 'optimistic';

export interface Field<T> {
  value: T;
  provisional: true;
  source: FieldSource;
  updatedAt: number | null;
}

export type SyncPhase = 'idle' | 'metadata' | 'state' | 'ready' | 'error';

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
  /** PWA: the browser offered an install prompt and the app is not installed yet. */
  installable: boolean;
  /** PWA: a newer build's service worker is installed and waiting for a reload. */
  updateReady: boolean;

  presetNames: Field<string[]>;
  activePreset: Field<number | null>;
  fxOn: Field<Record<FxSlot, boolean | null>>;
  /** Model loaded in each FX slot (name/category from the catalogue), null = empty slot. */
  fxModels: Field<FxModelsBySlot>;
  gateOn: Field<boolean | null>;
  cabOn: Field<boolean | null>;
  captureName: Field<string | null>;
  captureOn: Field<boolean | null>;
  /** Whether the current capture maps to one of the pedal's 25 slots (needed to re-enable it). null = not known yet. */
  captureSlotKnown: Field<boolean | null>;
  irName: Field<string | null>;
  /** Whether the current IR maps to one of the pedal's IR slots (needed to re-enable the cab). null = not known yet. */
  cabSlotKnown: Field<boolean | null>;
  firmware: Field<string | null>;

  lastStateSyncAt: number | null;
  lastMetadataAt: number | null;
  lastEventAt: number | null;
  log: LogLine[];
}

export const LOG_CAP = 400;

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
    installable: false,
    updateReady: false,
    presetNames: field(Array.from({ length: PRESET_COUNT }, () => '')),
    activePreset: field<number | null>(null),
    fxOn: field<Record<FxSlot, boolean | null>>({ pre1: null, pre2: null, post1: null, post2: null, post3: null }),
    fxModels: field<FxModelsBySlot>({ pre1: null, pre2: null, post1: null, post2: null, post3: null }),
    gateOn: field<boolean | null>(null),
    cabOn: field<boolean | null>(null),
    captureName: field<string | null>(null),
    captureOn: field<boolean | null>(null),
    captureSlotKnown: field<boolean | null>(null),
    irName: field<string | null>(null),
    cabSlotKnown: field<boolean | null>(null),
    firmware: field<string | null>(null),
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
      gateOn: s.gateOn,
      cabOn: s.cabOn,
      captureName: s.captureName,
      captureOn: s.captureOn,
      captureSlotKnown: s.captureSlotKnown,
      irName: s.irName,
      cabSlotKnown: s.cabSlotKnown,
      syncPhase: 'idle',
    };
    this.notify();
  }

  private notify() {
    for (const fn of Array.from(this.listeners)) fn(this.state);
  }
}
