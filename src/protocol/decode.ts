/**
 * Decoders: metadata dump, current-state dump, and live device events.
 *
 * Field maps are adapted from choldy/nano-cortex-web-editor (MIT) — see
 * `parseStructuredFE`, `parsePresetRecord`, `parseBufferedCurrentState` — and
 * rixrix/deskop-nano-cortex `ble_schema.rs` / `protocolLabDecoder.ts`
 * (Apache-2.0; spec doc `110-backend-midi-ble/spec.md`).
 *
 * EVERYTHING here is provisional: firmware-specific, reverse-engineered, and
 * may change silently. Decoders never throw on unknown payloads.
 */
import { toHex } from './hex';
import {
  decodePrintable,
  fieldsNumbered,
  firstBytes,
  firstField,
  firstFixed32Float,
  firstString,
  firstVarint,
  parseFields,
  readVarint,
  type ProtoField,
} from './proto';
import { FX_SLOTS, PRESET_COUNT, PRESET_NAME_MAX_LENGTH, type FxSlot } from './frames';
import { MSG, parseFrameHeader, splitTrailer } from './reassembly';

export const PROVISIONAL = true as const;

// ---------------------------------------------------------------------------
// Metadata dump (field 17 = captures[], 18 = presets[64], 19 = IRs[])
// ---------------------------------------------------------------------------

export interface PresetRecord {
  name: string;
  captureName: string;
  captureId: string;
  irShortName: string;
  irFullName: string;
}

export interface CaptureRecord {
  id: string;
  name: string;
}

export interface IrRecord {
  shortName: string;
  fullName: string;
}

export interface Metadata {
  presets: PresetRecord[]; // always padded / truncated to 64 slots
  captures: CaptureRecord[];
  irs: IrRecord[];
  /** Number of preset records actually present in the payload (before padding). */
  presetRecordCount: number;
  provisional: typeof PROVISIONAL;
}

/** ≥12 hex chars (dashes ignored): an internal identifier, not a display name. */
export function isInternalIdentifier(value: string): boolean {
  const compact = value.replace(/-/g, '');
  return compact.length >= 12 && /^[0-9a-fA-F]+$/.test(compact);
}

/**
 * Trim, blank non-printable / identifier-like names, cap absurd lengths.
 * Real preset names are ≤ PRESET_NAME_MAX_LENGTH (20) characters; the cap here
 * stays loose (120) so capture / IR names, which can be longer, pass through.
 */
export function sanitizeName(value: string | null): string {
  if (value === null) return '';
  const trimmed = value.trim();
  void PRESET_NAME_MAX_LENGTH;
  if (trimmed.length === 0 || trimmed.length > 120 || isInternalIdentifier(trimmed)) return '';
  return trimmed;
}

const EMPTY_PRESET: PresetRecord = { name: '', captureName: '', captureId: '', irShortName: '', irFullName: '' };

function parsePresetRecord(payload: Uint8Array): PresetRecord {
  const f = parseFields(payload);
  return {
    name: sanitizeName(firstString(f, 1)),
    captureName: sanitizeName(firstString(f, 7)),
    captureId: firstString(f, 8),
    irShortName: sanitizeName(firstString(f, 9)),
    irFullName: firstString(f, 10).trim(),
  };
}

function parseCaptureRecord(payload: Uint8Array): CaptureRecord {
  const f = parseFields(payload);
  return { id: firstString(f, 1), name: sanitizeName(firstString(f, 2)) };
}

function parseIrRecord(payload: Uint8Array): IrRecord {
  const f = parseFields(payload);
  return { shortName: sanitizeName(firstString(f, 1)), fullName: firstString(f, 3).trim() };
}

function metadataFromTopLevel(top: ProtoField[]): Metadata {
  const presetEntries = fieldsNumbered(top, 18).filter((e) => e.wire === 2);
  const presets = presetEntries.map((e) => parsePresetRecord(e.raw)).slice(0, PRESET_COUNT);
  const presetRecordCount = presets.length;
  while (presets.length < PRESET_COUNT) presets.push({ ...EMPTY_PRESET });
  const captures = fieldsNumbered(top, 17)
    .filter((e) => e.wire === 2)
    .map((e) => parseCaptureRecord(e.raw));
  const irs = fieldsNumbered(top, 19)
    .filter((e) => e.wire === 2)
    .map((e) => parseIrRecord(e.raw))
    .filter((r) => r.shortName || r.fullName);
  return { presets, captures, irs, presetRecordCount, provisional: PROVISIONAL };
}

/**
 * Decode a reassembled metadata message. Parses top-level records only (nested
 * records are never mistaken for presets). If the buffer starts with partial /
 * non-protobuf bytes so that no preset records are found, retries from later
 * offsets (rixrix FR-18 "scan past partial prefix bytes").
 */
export function decodeMetadata(bytes: Uint8Array): Metadata {
  const direct = metadataFromTopLevel(parseFields(bytes));
  if (direct.presetRecordCount > 0) return direct;
  const limit = Math.min(bytes.length, 64);
  for (let start = 1; start < limit; start++) {
    const attempt = metadataFromTopLevel(parseFields(bytes.subarray(start)));
    if (attempt.presetRecordCount > 0) return attempt;
  }
  return direct;
}

// ---------------------------------------------------------------------------
// Current-state dump
// ---------------------------------------------------------------------------

export interface AmpKnobs {
  gain: number | null;
  level: number | null;
  bass: number | null;
  mid: number | null;
  treble: number | null;
}

export interface CaptureState {
  enabled: boolean | null;
  name: string;
  id: string;
}

export interface IrState {
  enabled: boolean | null;
  shortName: string;
  fullName: string;
}

export interface FootswitchAssignments {
  ia: number;
  ib: number;
  iia: number;
  iib: number;
}

export interface CurrentState {
  /** ON state per slot [pre1, pre2, post1, post2, post3]; null when field 31 absent. */
  fxOn: Record<FxSlot, boolean> | null;
  /** Raw 5-byte bypass array from field 31 (0x00 = on). */
  bypassRaw: number[] | null;
  gateOn: boolean | null;
  cabOn: boolean | null;
  capture: CaptureState | null;
  ir: IrState | null;
  amp: AmpKnobs;
  captureSlot: number | null;
  captureVolumeRaw: number | null;
  /** Preset tempo in BPM: field 56 (fixed32 float). Confirmed on hardware 2026-09-14 (follows tap tempo live). */
  tempoBpm: number | null;
  /** Tuner reference pitch in Hz: field 46 (fixed32 float, 440.0 on the user's pedal). */
  tunerReferenceHz: number | null;
  /**
   * Field 60 = 1 while the pedal is in its tap tempo mode (screen firmware 2026-09-26: a
   * reconnect during the mode carried it; dumps outside the mode do not). Absent = false.
   */
  tapTempoMode: boolean;
  /** FX model IDs (uppercase hex, no spaces) from fields 48-52; null per slot when absent. */
  fxModelIds: Record<FxSlot, string | null>;
  firmware: string | null;
  footswitchAssignments: FootswitchAssignments | null;
  /**
   * Active preset index 0..63 from field 13. Hardware-observed 2026-09-12: read 14
   * ("Fender Prnc Clean") before a footswitch press and 3 ("5150") after, both
   * matching the capture names and the preset-changed event. Provisional.
   */
  activePreset: number | null;
  provisional: typeof PROVISIONAL;
}

function subMessage(fields: ProtoField[], n: number): ProtoField[] | null {
  const raw = firstBytes(fields, n);
  return raw ? parseFields(raw) : null;
}

function modelIdHex(fields: ProtoField[], n: number): string | null {
  const f = firstField(fields, n);
  if (!f) return null;
  // Both encodings have been observed: varint (raw value bytes) and length-delimited bytes.
  if (f.wire === 0 || f.wire === 2) return toHex(f.raw, '');
  return null;
}

/**
 * Decode the body of a current-state dump (2-byte packet header already
 * stripped). Returns null when nothing recognisable is present so callers can
 * discard stray stream payloads.
 */
export function decodeCurrentState(bytes: Uint8Array): CurrentState | null {
  const f = parseFields(bytes);
  if (f.length === 0) return null;

  const bypass = firstBytes(f, 31);
  const bypassRaw = bypass ? Array.from(bypass.subarray(0, 5)) : null;
  let fxOn: Record<FxSlot, boolean> | null = null;
  if (bypassRaw && bypassRaw.length >= 5) {
    fxOn = {} as Record<FxSlot, boolean>;
    FX_SLOTS.forEach((slot, i) => {
      fxOn![slot] = bypassRaw[i] === 0;
    });
  }

  const cap = subMessage(f, 32);
  const ir = subMessage(f, 33);
  const gateField = firstVarint(f, 54);
  const cabField = firstField(f, 12);

  const state: CurrentState = {
    fxOn,
    bypassRaw,
    // Field 54 is an inverted bypass flag; absent in an otherwise valid dump = gate on.
    gateOn: gateField === null ? (f.length > 0 ? true : null) : gateField === 0,
    cabOn: cabField ? (cabField.wire === 0 ? cabField.value !== 0 : cabField.raw.length > 0) : false,
    capture: cap
      ? {
          enabled: firstVarint(cap, 1) === null ? null : firstVarint(cap, 1) !== 0,
          name: sanitizeName(firstString(cap, 2)),
          id: firstString(cap, 3),
        }
      : null,
    ir: ir
      ? {
          enabled: firstVarint(ir, 1) === null ? null : firstVarint(ir, 1) !== 0,
          shortName: sanitizeName(firstString(ir, 2)),
          fullName: firstString(ir, 3).trim(),
        }
      : null,
    amp: {
      gain: firstVarint(f, 3),
      level: firstVarint(f, 4),
      bass: firstVarint(f, 5),
      mid: firstVarint(f, 6),
      treble: firstVarint(f, 7),
    },
    captureSlot: firstVarint(f, 11),
    captureVolumeRaw: firstVarint(f, 44),
    tempoBpm: (() => {
      const v = firstFixed32Float(f, 56);
      return v !== null && Number.isFinite(v) && v >= 20 && v <= 400 ? v : null;
    })(),
    tunerReferenceHz: (() => {
      const v = firstFixed32Float(f, 46);
      return v !== null && Number.isFinite(v) && v >= 400 && v <= 480 ? v : null;
    })(),
    tapTempoMode: firstVarint(f, 60) === 1,
    fxModelIds: {
      pre1: modelIdHex(f, 48),
      pre2: modelIdHex(f, 49),
      post1: modelIdHex(f, 50),
      post2: modelIdHex(f, 51),
      post3: modelIdHex(f, 52),
    },
    firmware: (() => {
      const raw = firstBytes(f, 24);
      return raw ? decodePrintable(raw) : null;
    })(),
    // Zero-valued varints are omitted by the pedal (proto3 defaults, captured 2026-09-26): a
    // dump on preset 1 has no field 13, and a footswitch assigned to preset 1 has no field either.
    activePreset: (() => {
      const v = firstVarint(f, 13) ?? 0;
      return v < PRESET_COUNT ? v : null;
    })(),
    footswitchAssignments: (() => {
      const ia = firstVarint(f, 14) ?? 0;
      const ib = firstVarint(f, 15) ?? 0;
      const iia = firstVarint(f, 38) ?? 0;
      const iib = firstVarint(f, 39) ?? 0;
      return { ia, ib, iia, iib };
    })(),
    provisional: PROVISIONAL,
  };

  const recognised =
    state.fxOn !== null ||
    state.capture !== null ||
    state.ir !== null ||
    Object.values(state.amp).some((v) => v !== null);
  return recognised ? state : null;
}

// ---------------------------------------------------------------------------
// Live events (unsolicited c305 messages)
// ---------------------------------------------------------------------------

export type DeviceEvent =
  | {
      kind: 'program-change';
      /** Zero-based preset index 0..63. */
      preset: number;
      /** Which packet shape produced it. */
      shape: 'midi-2byte' | 'preset-changed' | 'footswitch-select';
      assignments?: FootswitchAssignments;
      provisional: typeof PROVISIONAL;
    }
  /** FX block / gate bypass changed on the device (no slot detail in the event). */
  | { kind: 'bypass-changed'; provisional: typeof PROVISIONAL }
  /** Knob, encoder or expression telemetry — nothing the gig view displays. */
  | { kind: 'control'; msgType: number; hex: string; provisional: typeof PROVISIONAL }
  /** Reply to the device-settings request (type 0x42). */
  | { kind: 'settings'; settings: DeviceSettings; hex: string; provisional: typeof PROVISIONAL }
  /** Ack to an outputs-mute write (type 0x44). */
  | { kind: 'outputs-mute-ack'; hex: string; provisional: typeof PROVISIONAL }
  /** Ack to a c304 preset select (type 0x1E, `08 C0 08 01 20 01 1E 00 00 00`; 2026-09-19). */
  | { kind: 'preset-select-ack'; hex: string; provisional: typeof PROVISIONAL }
  /** The pedal's reply to a tuner on/off write (type 0x7F back): field 4 = on, field 5 = reference Hz. */
  | { kind: 'tuner-ack'; on: boolean; referenceHz: number | null; hex: string; provisional: typeof PROVISIONAL }
  /** Expression pedal position 0–254 (type 0x40), ~20/s while it moves. */
  | { kind: 'expression'; position: number; hex: string; provisional: typeof PROVISIONAL }
  /** Values the expression produced for its assigned slots (type 0xAA), sent with every position. */
  | { kind: 'expression-values'; values: ExpressionValues; hex: string; provisional: typeof PROVISIONAL }
  /** A preset's expression assignments (type 0x3D reply to our 0x3C request). */
  | { kind: 'expression-assignments'; assignments: ExpressionAssignments; hex: string; provisional: typeof PROVISIONAL }
  /** Ack to an assignment write (type 0x3F). */
  | { kind: 'expression-assign-ack'; hex: string; provisional: typeof PROVISIONAL }
  /** Tuner pitch reading (type 0x80), ~30/s while the tuner is on and a note is detected. */
  | { kind: 'tuner'; reading: TunerReading; hex: string; provisional: typeof PROVISIONAL }
  /**
   * Tap tempo (type 0x91, 2026-09-26): one per tap with the current tempo while the pedal's tap
   * tempo mode is on (`active`), and one more with `active` false and the final tempo on exit.
   */
  | { kind: 'tap-tempo'; active: boolean; bpm: number; hex: string; provisional: typeof PROVISIONAL }
  | { kind: 'unknown'; msgType: number | null; hex: string; provisional: typeof PROVISIONAL };

// ---------------------------------------------------------------------------
// Device settings (type 0x42 reply to `06 C0 08 03 41 00 00 00`)
// ---------------------------------------------------------------------------

export interface DeviceSettings {
  /** Field 5, "Neural DSP Nano Cortex" on 2.2.1 (the pedal's Bluetooth name). */
  deviceName: string;
  /**
   * Outputs 1/2 muted: field 16 is `1` while muted and absent while the outputs are on. The
   * field mirrors the last `68 <v>` write exactly (before/after pair in NanoGig's log
   * 2026-09-15); which way is silent was settled by ear.
   */
  outputsMuted: boolean;
  /**
   * Every top-level field as `number → value` (varint number, fixed32 float, printable string,
   * or hex for anything else). Kept raw because most fields are not understood yet; the log
   * prints them so future before/after pairs can identify more.
   */
  fields: Record<number, number | string>;
  provisional: typeof PROVISIONAL;
}

/** Decode the settings reply payload (trailer already split off). Null when it does not parse. */
export function decodeDeviceSettings(payload: Uint8Array): DeviceSettings | null {
  const f = parseFields(payload);
  if (!f.length) return null;
  const fields: Record<number, number | string> = {};
  for (const x of f) {
    if (x.field in fields) continue;
    if (x.wire === 0) fields[x.field] = x.value ?? 0;
    else if (x.wire === 5) fields[x.field] = new DataView(x.raw.buffer, x.raw.byteOffset, 4).getFloat32(0, true);
    else fields[x.field] = decodePrintable(x.raw) ?? toHex(x.raw);
  }
  return { deviceName: firstString(f, 5), outputsMuted: firstVarint(f, 16) === 1, fields, provisional: PROVISIONAL };
}

/** `f1=1 f5="Neural DSP Nano Cortex" f17=-6` style summary for the hex log. */
export function describeDeviceSettings(s: DeviceSettings): string {
  return Object.entries(s.fields)
    .map(([n, v]) => `f${n}=${typeof v === 'string' ? JSON.stringify(v) : Math.round(v * 1000) / 1000}`)
    .join(' ');
}

const CONTROL_TYPES = new Set<number>([MSG.KNOB, MSG.ENCODER]);

// ---------------------------------------------------------------------------
// Expression pedal (captured 2026-09-19 from Cortex Cloud's Expression Pedal page)
// ---------------------------------------------------------------------------

/** One target's expression range on the pedal's 0–255 scale (Cortex Cloud shows it as 0–100 %). */
export interface ExpressionRange {
  min: number;
  max: number;
  /** Sub-message field 1; 0 in every capture. */
  flag: number;
}
/** A bypass assignment: the sub-message key is the mode (2 = heel-toe, flips at mid-travel; 1 and 3 carry a delay and need the toe switch). */
export interface ExpressionBypass {
  mode: number;
  delayMs: number;
}
/** Range targets: amp knobs, FX amounts, and one more range Cortex Cloud lists right after post 3 (`range13`, unnamed). */
export type ExpRangeTarget = 'gain' | 'bass' | 'mid' | 'treble' | 'level' | FxSlot | 'range13';
/** Bypass targets: capture, IR, the FX slots, and one more listed third by Cortex Cloud (`bypass22`, probably the gate). */
export type ExpBypassTarget = 'capture' | 'ir' | FxSlot | 'bypass22';
export const EXP_RANGE_TARGETS: readonly ExpRangeTarget[] = ['gain', 'bass', 'mid', 'treble', 'level', ...FX_SLOTS, 'range13'];
export const EXP_BYPASS_TARGETS: readonly ExpBypassTarget[] = ['capture', 'ir', ...FX_SLOTS, 'bypass22'];

export interface ExpressionAssignments {
  ranges: Partial<Record<ExpRangeTarget, ExpressionRange>>;
  bypasses: Partial<Record<ExpBypassTarget, ExpressionBypass>>;
}
/** What the pedal produced for the assigned targets (0–255 for ranges, on/off for bypasses). */
export interface ExpressionValues {
  ranges: Partial<Record<ExpRangeTarget, number>>;
  bypasses: Partial<Record<ExpBypassTarget, boolean>>;
}
export const EMPTY_EXPRESSION_VALUES: ExpressionValues = { ranges: {}, bypasses: {} };

/**
 * Field numbers, from the 2026-09-19 captures. The write (0x3E, Cortex Cloud) is canonical; the
 * values event (0xAA) puts level at 8 and shifts the FX amounts up by one; the reply (0x3D) was
 * only ever seen with post 3, at 11 = write − 1, so the rest of its table is that rule applied.
 */
const WRITE_RANGE_FIELD: Record<ExpRangeTarget, number> = { gain: 4, bass: 5, mid: 6, treble: 7, pre1: 8, pre2: 9, post1: 10, post2: 11, post3: 12, range13: 13, level: 21 };
const WRITE_BYPASS_FIELD: Record<ExpBypassTarget, number> = { capture: 14, ir: 15, pre1: 16, pre2: 17, post1: 18, post2: 19, post3: 20, bypass22: 22 };
const VALUES_RANGE_FIELD: Record<ExpRangeTarget, number> = { gain: 4, bass: 5, mid: 6, treble: 7, level: 8, pre1: 9, pre2: 10, post1: 11, post2: 12, post3: 13, range13: 14 };
const VALUES_BYPASS_FIELD: Record<ExpBypassTarget, number> = { capture: 15, ir: 16, pre1: 17, pre2: 18, post1: 19, post2: 20, post3: 21, bypass22: 22 };
const REPLY_OFFSET = -1;

function decodeRange(sub: Uint8Array): ExpressionRange {
  const sf = parseFields(sub);
  return { min: firstVarint(sf, 2) ?? 0, max: firstVarint(sf, 3) ?? 255, flag: firstVarint(sf, 1) ?? 0 };
}
function decodeBypass(sub: Uint8Array): ExpressionBypass | null {
  const sf = parseFields(sub);
  const first = sf[0];
  if (!first || first.wire !== 2) return null;
  const inner = parseFields(first.raw);
  return { mode: first.field, delayMs: firstVarint(inner, 2) ?? firstVarint(inner, 1) ?? 0 };
}

/** Decode an assignment list; `offset` maps the write numbering onto the message at hand (reply = −1). */
export function decodeExpressionAssignments(payload: Uint8Array, offset = REPLY_OFFSET): ExpressionAssignments {
  const f = parseFields(payload);
  const out: ExpressionAssignments = { ranges: {}, bypasses: {} };
  for (const t of EXP_RANGE_TARGETS) {
    const sub = firstBytes(f, WRITE_RANGE_FIELD[t] + offset);
    if (sub) out.ranges[t] = decodeRange(sub);
  }
  for (const t of EXP_BYPASS_TARGETS) {
    const sub = firstBytes(f, WRITE_BYPASS_FIELD[t] + offset);
    if (!sub) continue;
    const b = decodeBypass(sub);
    if (b) out.bypasses[t] = b;
  }
  return out;
}

function decodeExpressionValues(payload: Uint8Array): ExpressionValues {
  const f = parseFields(payload);
  const out: ExpressionValues = { ranges: {}, bypasses: {} };
  for (const t of EXP_RANGE_TARGETS) {
    const v = firstVarint(f, VALUES_RANGE_FIELD[t]);
    if (v !== null) out.ranges[t] = v;
  }
  for (const t of EXP_BYPASS_TARGETS) {
    const v = firstVarint(f, VALUES_BYPASS_FIELD[t]);
    if (v !== null) out.bypasses[t] = v !== 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tuner pitch event (type 0x80, captured 2026-09-19 from Cortex Cloud's tuner page)
// ---------------------------------------------------------------------------

export interface TunerReading {
  /** Note name as the pedal spells it (`A`, `E`, …; only naturals seen so far). */
  note: string;
  /** Deviation from the note in cents, negative = flat. Seen from -1 to +14 on decaying strings. */
  cents: number;
  /** Field 7 = 1: the pedal's own "in tune" verdict (|cents| below about 2). */
  inTune: boolean;
}

/**
 * `10 C0 08 01 22 01 <note> 2D <f32 cents> 30 01 [38 01] 80 00 00 00`: field 4 = note name
 * (ASCII), field 5 = cents (fixed32 float), field 6 = 1, field 7 present only when in tune.
 */
function decodeTunerReading(payload: Uint8Array): TunerReading | null {
  const f = parseFields(payload);
  const note = firstString(f, 4);
  const cents = firstFixed32Float(f, 5);
  if (!note || cents === null || !Number.isFinite(cents)) return null;
  return { note, cents, inTune: firstVarint(f, 7) === 1 };
}

/** Locate the `C0 08 01` legacy event header at offset 0 or 1 (after a length byte). */
function findLegacyHeader(data: Uint8Array): number {
  for (const i of [0, 1]) {
    if (data[i] === 0xc0 && data[i + 1] === 0x08 && data[i + 2] === 0x01) return i;
  }
  return -1;
}

/**
 * Decode a single-packet live event.
 *  - `[0xCn, program]` (program < 64): direct MIDI Program Change shape
 *    (rixrix `NanoStateDecoder`, FR-9; not yet observed on hardware).
 *  - Framed message with trailer type 0x1D: PRESET CHANGED. Hardware-captured
 *    2026-09-12: `10 C0 08 01 20 03 28 03 30 05 38 14 40 0E 1D 00 00 00` →
 *    field 4 = preset 3, fields 5-8 = footswitch IA/IB/IIA/IIB.
 *  - Framed message with trailer type 0x1F: bypass changed.
 *  - Types 0x1A / 0x1C / 0x40: knob / encoder / expression telemetry.
 *  - Legacy header-less `C0 08 01 20 <preset> 28 …` shape (rixrix fixtures).
 */
export function decodeEvent(data: Uint8Array): DeviceEvent {
  const hex = toHex(data);
  if (data.length === 2 && (data[0]! & 0xf0) === 0xc0 && data[1]! < PRESET_COUNT) {
    return { kind: 'program-change', preset: data[1]!, shape: 'midi-2byte', provisional: PROVISIONAL };
  }

  const header = parseFrameHeader(data);
  if (header) {
    const { payload, msgType } = splitTrailer(data.subarray(2));
    if (msgType === MSG.PRESET_CHANGED) {
      const f = parseFields(payload);
      // Field 4 (and the assignment fields) are absent when zero: preset 1 / footswitch → preset 1.
      const preset = firstVarint(f, 4) ?? 0;
      if (preset < PRESET_COUNT) {
        const ia = firstVarint(f, 5) ?? 0;
        const ib = firstVarint(f, 6) ?? 0;
        const iia = firstVarint(f, 7) ?? 0;
        const iib = firstVarint(f, 8) ?? 0;
        const assignments = { ia, ib, iia, iib };
        return {
          kind: 'program-change',
          preset,
          shape: 'preset-changed',
          ...(assignments ? { assignments } : {}),
          provisional: PROVISIONAL,
        };
      }
      return { kind: 'unknown', msgType, hex, provisional: PROVISIONAL };
    }
    if (msgType === MSG.BYPASS_CHANGED) return { kind: 'bypass-changed', provisional: PROVISIONAL };
    if (msgType === MSG.SETTINGS) {
      const settings = decodeDeviceSettings(payload);
      if (settings) return { kind: 'settings', settings, hex, provisional: PROVISIONAL };
      return { kind: 'unknown', msgType, hex, provisional: PROVISIONAL };
    }
    if (msgType === MSG.OUTPUTS_MUTE_ACK) return { kind: 'outputs-mute-ack', hex, provisional: PROVISIONAL };
    if (msgType === MSG.PRESET_ACK_REQUEST) return { kind: 'preset-select-ack', hex, provisional: PROVISIONAL };
    if (msgType === MSG.EXPRESSION) {
      const f = parseFields(payload);
      const position = firstVarint(f, 4) ?? 0; // absent at heel
      return { kind: 'expression', position: Math.max(0, Math.min(255, position)), hex, provisional: PROVISIONAL };
    }
    if (msgType === MSG.EXPRESSION_VALUES) return { kind: 'expression-values', values: decodeExpressionValues(payload), hex, provisional: PROVISIONAL };
    if (msgType === MSG.EXP_ASSIGN_REPLY) return { kind: 'expression-assignments', assignments: decodeExpressionAssignments(payload, REPLY_OFFSET), hex, provisional: PROVISIONAL };
    if (msgType === MSG.EXP_ASSIGN_ACK) return { kind: 'expression-assign-ack', hex, provisional: PROVISIONAL };
    if (msgType === MSG.TUNER_REQUEST) {
      const f = parseFields(payload);
      const ref = firstFixed32Float(f, 5);
      return { kind: 'tuner-ack', on: firstVarint(f, 4) === 1, referenceHz: ref !== null && Number.isFinite(ref) ? ref : null, hex, provisional: PROVISIONAL };
    }
    if (msgType === MSG.TUNER_PITCH) {
      const reading = decodeTunerReading(payload);
      if (reading) return { kind: 'tuner', reading, hex, provisional: PROVISIONAL };
      return { kind: 'unknown', msgType, hex, provisional: PROVISIONAL };
    }
    if (msgType === MSG.TAP_TEMPO) {
      // `0D C0 08 01 18 01 2D <f32> 91 …` per tap (field 3 = 1); `0B C0 08 01 2D <f32> 91 …` on exit.
      const f = parseFields(payload);
      const bpm = firstFixed32Float(f, 5);
      if (bpm !== null && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400) {
        return { kind: 'tap-tempo', active: firstVarint(f, 3) === 1, bpm, hex, provisional: PROVISIONAL };
      }
      return { kind: 'unknown', msgType, hex, provisional: PROVISIONAL };
    }
    if (msgType !== null && CONTROL_TYPES.has(msgType)) return { kind: 'control', msgType, hex, provisional: PROVISIONAL };
    if (msgType !== null) return { kind: 'unknown', msgType, hex, provisional: PROVISIONAL };
  }

  // Legacy header-less shape: `C0 08 01 20 <preset> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB>`.
  const h = findLegacyHeader(data);
  if (h >= 0 && data[h + 3] === 0x20) {
    const preset = readVarint(data, h + 4);
    if (preset && preset.value < PRESET_COUNT) {
      const a = readAssignments(data, preset.next);
      if (a) {
        return { kind: 'program-change', preset: preset.value, shape: 'footswitch-select', assignments: a, provisional: PROVISIONAL };
      }
    }
  }
  return { kind: 'unknown', msgType: null, hex, provisional: PROVISIONAL };
}

function readAssignments(data: Uint8Array, index: number): FootswitchAssignments | null {
  if (data[index] !== 0x28) return null;
  const ia = readVarint(data, index + 1);
  if (!ia || data[ia.next] !== 0x30) return null;
  const ib = readVarint(data, ia.next + 1);
  if (!ib || data[ib.next] !== 0x38) return null;
  const iia = readVarint(data, ib.next + 1);
  if (!iia || data[iia.next] !== 0x40) return null;
  const iib = readVarint(data, iia.next + 1);
  if (!iib) return null;
  return { ia: ia.value, ib: ib.value, iia: iia.value, iib: iib.value };
}

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Fallback for dumps without field 13: infer the preset by matching the dump's
 * capture + IR names against the metadata preset records. Returns the index
 * only when exactly one preset matches; otherwise null.
 */
export function inferActivePreset(metadata: Metadata, state: CurrentState): number | null {
  const capName = norm(state.capture?.name ?? '');
  const irName = norm(state.ir?.shortName ?? '');
  if (!capName && !irName) return null;
  const matches: number[] = [];
  metadata.presets.forEach((p, i) => {
    if (!p.name && !p.captureName) return;
    const capOk = capName ? norm(p.captureName) === capName : true;
    const irOk = irName && p.irShortName ? norm(p.irShortName) === irName : true;
    if (capOk && irOk) matches.push(i);
  });
  return matches.length === 1 ? matches[0]! : null;
}
