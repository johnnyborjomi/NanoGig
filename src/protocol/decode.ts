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
    activePreset: (() => {
      const v = firstVarint(f, 13);
      return v !== null && v < PRESET_COUNT ? v : null;
    })(),
    footswitchAssignments: (() => {
      const ia = firstVarint(f, 14);
      const ib = firstVarint(f, 15);
      const iia = firstVarint(f, 38);
      const iib = firstVarint(f, 39);
      return ia !== null && ib !== null && iia !== null && iib !== null ? { ia, ib, iia, iib } : null;
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
  | { kind: 'unknown'; msgType: number | null; hex: string; provisional: typeof PROVISIONAL };

const CONTROL_TYPES = new Set<number>([MSG.KNOB, MSG.ENCODER, MSG.EXPRESSION]);

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
      const preset = firstVarint(f, 4);
      if (preset !== null && preset < PRESET_COUNT) {
        const ia = firstVarint(f, 5);
        const ib = firstVarint(f, 6);
        const iia = firstVarint(f, 7);
        const iib = firstVarint(f, 8);
        const assignments = ia !== null && ib !== null && iia !== null && iib !== null ? { ia, ib, iia, iib } : undefined;
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
