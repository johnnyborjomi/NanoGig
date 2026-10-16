/**
 * Editing frames and replies: FX models and parameters, capture volume, gate threshold, the IR (cab) loader,
 * the pedal's capture / IR library, and preset rename / create / delete / footswitch assignment.
 *
 * Ported from the NanoGig Screen firmware (`components/nano_protocol/nano_build.c`, `nano_decode.c`,
 * `nano_scales.c`, 2026-10-10), where every frame is byte-exact against a Cortex Cloud capture (Android HCI
 * snoops 2026-10-07 … 10-10) or another open-source controller and was tried on the user's pedal. The
 * firmware's notes are kept with each builder. All writes are live edits: audible at once, the preset is not
 * saved (the pedal's own save button does that) unless the comment says otherwise.
 *
 * PROVISIONAL like everything else here: NanOS 2.2.1.
 */
import { CAB_SLOT_COUNT, CAPTURE_SLOT_COUNT, FX_SLOTS, PRESET_COUNT, type FxSlot } from './frames';
import { FX_DEFS, FX_SLOT_MODELS, type FxDef, type FxParam } from './fx-params';
import { FX_MODELS } from './models';
import { encodeVarint, firstBytes, firstFixed32Float, firstVarint, parseFields, tag, type ProtoField } from './proto';
import { encodeFrameHeader } from './reassembly';

export { FX_DEFS, FX_SLOT_MODELS, type FxDef, type FxParam };

/** Trailer types of the editing messages (NanOS 2.2.1, the firmware's `nano_frame.h`). */
export const EDIT_MSG = {
  PRESET_CREATE: 0x03,
  PRESET_CREATED: 0x04,
  KNOB: 0x1a,
  /** Field 3 = 2: the pedal saved the shown preset (its own save button, board 2026-10-10). */
  STORE: 0x1b,
  ENCODER: 0x1c,
  PRESET_CHANGED: 0x1d,
  PRESET_DELETE: 0x32,
  PRESET_DELETED: 0x33,
  LIBRARY_REQUEST: 0x4c,
  LIBRARY: 0x4d,
  CAB_SLOT_LOAD: 0x4e,
  CAB_SLOT_LOADED: 0x4f,
  CAPTURE_SLOT_LOAD: 0x50,
  CAPTURE_SLOT_LOADED: 0x51,
  CAB_SETTING: 0x5e,
  CAB_SETTINGS_REQUEST: 0x5f,
  CAB_SETTINGS: 0x60,
  FX_PARAM: 0x63,
  RENAME: 0x6f,
  RENAME_REPLY: 0x70,
  FX_MODEL: 0x88,
  FX_PARAMS_REQUEST: 0x89,
  FX_PARAMS: 0x8a,
  CAPTURE_PREVIEW_STOP: 0x94,
  CAPTURE_PREVIEW_STOPPED: 0x95,
  CAPTURE_PREVIEW: 0x96,
  CAPTURE_PREVIEWED: 0x97,
  IR_PREVIEW: 0x9e,
  IR_PREVIEWED: 0x9f,
} as const;

/** Field 1 of most writes: 1 = update, 2 = delete, 3 = read. */
const OP_UPDATE = 1;
const OP_DELETE = 2;
const OP_READ = 3;

// ---------------------------------------------------------------------------
// Writer: a single-packet frame `<header> <protobuf> <type> 00 00 00`
// ---------------------------------------------------------------------------

class Pb {
  readonly out: number[] = [];
  varint(field: number, value: number): this {
    this.out.push(...tag(field, 0), ...encodeVarint(value));
    return this;
  }
  /** -1 as the pedal expects it: ten bytes FF×9 01 (int64 two's complement). */
  minusOne(field: number): this {
    this.out.push(...tag(field, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01);
    return this;
  }
  f32(field: number, value: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    this.out.push(...tag(field, 5), ...b);
    return this;
  }
  bytes(field: number, data: ArrayLike<number>): this {
    this.out.push(...tag(field, 2), ...encodeVarint(data.length), ...Array.from(data));
    return this;
  }
  text(field: number, text: string): this {
    return this.bytes(field, new TextEncoder().encode(text));
  }
  sub(field: number, build: (pb: Pb) => void): this {
    const inner = new Pb();
    build(inner);
    return this.bytes(field, inner.out);
  }
  frame(msgType: number): Uint8Array {
    const body = [...this.out, msgType, 0x00, 0x00, 0x00];
    return Uint8Array.from([...encodeFrameHeader(body.length, true, true), ...body]);
  }
}

function checkIndex(name: string, v: number, max: number, min = 0): void {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} out of range: ${v}`);
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const slotIndex = (slot: FxSlot) => FX_SLOTS.indexOf(slot);

// ---------------------------------------------------------------------------
// FX blocks: model and parameters (param write verified 2026-10-08)
// ---------------------------------------------------------------------------

/** A model's type: the varint its state-dump ID spells (`FA2E` → 6010). 0 for an unparsable ID. */
export function fxModelType(idHex: string | null | undefined): number {
  if (!idHex || idHex.length % 2) return 0;
  let type = 0;
  for (let i = 0, shift = 0; i < idHex.length && shift < 28; i += 2, shift += 7) {
    const b = parseInt(idHex.slice(i, i + 2), 16);
    if (Number.isNaN(b)) return 0;
    type += (b & 0x7f) * 2 ** shift;
  }
  return type;
}

/** The catalogue ID (uppercase hex of the varint) for a type: 6010 → `FA2E`. */
export function fxModelId(type: number): string {
  return encodeVarint(type)
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join('');
}

export function fxDef(type: number): FxDef | null {
  return type ? (FX_DEFS.find((d) => d.type === type) ?? null) : null;
}

export interface FxModelChoice {
  type: number;
  id: string;
  name: string;
  category: string;
}

/** The models a slot takes, in the editor's order, with the catalogue's names and categories. */
export function fxSlotModels(slot: FxSlot): FxModelChoice[] {
  return (FX_SLOT_MODELS[slotIndex(slot)] ?? []).map((type) => {
    const id = fxModelId(type);
    const m = FX_MODELS.get(id);
    return { type, id, name: m?.name ?? fxDef(type)?.name ?? `Type ${type}`, category: m?.category ?? 'Utility' };
  });
}

/** Parameters in the editor's display order, each with its index on the wire. */
export function fxParamsInOrder(def: FxDef): { index: number; param: FxParam }[] {
  const order = def.order ?? def.params.map((_, i) => i);
  return order.filter((i) => i < def.params.length).map((index) => ({ index, param: def.params[index]! }));
}

/** A 0..1 value as the editor shows it: "4.5", "-3.0 dB", "120 ms", or an enum option. */
export function fxParamText(param: FxParam, n: number): string {
  const v = clamp01(n);
  if (param.kind === 'enum') return param.options[Math.round(v * (param.options.length - 1))] ?? '';
  const value = param.min + v * (param.max - param.min);
  const text = value.toFixed(Math.max(0, param.decimals));
  return param.unit ? `${text} ${param.unit}` : text;
}

/** The 0..1 of an enum option. */
export function fxEnumValue(param: FxParam & { kind: 'enum' }, option: number): number {
  const n = param.options.length - 1;
  return n > 0 ? Math.min(Math.max(option, 0), n) / n : 0;
}

/** Load model `type` into a slot (the pedal loads the model's defaults): `<len> C0 18 <slot> 20 <type> 88 00 00 00`. */
export function fxModelFrame(slot: FxSlot, type: number): Uint8Array {
  if (!Number.isInteger(type) || type <= 0) throw new RangeError(`bad FX type ${type}`);
  return new Pb().varint(3, slotIndex(slot)).varint(4, type).frame(EDIT_MSG.FX_MODEL);
}

/**
 * Read a block's parameters: `08 C0 08 03 18 <slot> 89 00 00 00` → type 0x8A. On or off alike: Cortex Cloud reads
 * a bypassed block (a crash on one was once reported; Cortex Cloud and rixrix/deskop-nano-cortex read them).
 */
export function fxParamsRequest(slot: FxSlot): Uint8Array {
  return new Pb().varint(1, OP_READ).varint(3, slotIndex(slot)).frame(EDIT_MSG.FX_PARAMS_REQUEST);
}

/** One parameter: `0F C0 08 01 18 <slot> 20 <param> 2D <f32 0..1> 63 00 00 00` (value clamped). */
export function fxParamFrame(slot: FxSlot, param: number, normalized: number): Uint8Array {
  checkIndex('FX parameter', param, 0x7f);
  return new Pb().varint(1, OP_UPDATE).varint(3, slotIndex(slot)).varint(4, param).f32(5, clamp01(normalized)).frame(EDIT_MSG.FX_PARAM);
}

/** FX parameters reply (0x8A): field 4 = every parameter's 0..1, packed little-endian f32, in the model's order. */
export function decodeFxParams(payload: Uint8Array): number[] {
  const raw = firstBytes(parseFields(payload), 4);
  if (!raw) return [];
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  for (let i = 0; i + 4 <= raw.length; i += 4) out.push(dv.getFloat32(i, true));
  return out;
}

/**
 * A parameter the pedal changed itself (0x63, the parameter write's own shape): `0F C0 08 01 18 <slot> 20 <param>
 * 2D <f32> 63 00 00 00`. Seen for the dual delays' Link FBack (2026-10-17): moving one feedback, the pedal reports
 * the other; loading the model or turning the link on, it reports the feedback it copied. Zero fields are left out.
 */
export function decodeFxParamEvent(payload: Uint8Array): { slot: FxSlot; param: number; value: number } | null {
  const f = parseFields(payload);
  const slot = FX_SLOTS[firstVarint(f, 3) ?? 0];
  const value = firstFixed32Float(f, 5) ?? (f.some((x) => x.field === 5) ? NaN : 0);
  if (!slot || !Number.isFinite(value)) return null;
  return { slot, param: firstVarint(f, 4) ?? 0, value };
}

// ---------------------------------------------------------------------------
// Capture volume and gate threshold (Cortex Cloud's sliders)
// ---------------------------------------------------------------------------

function knobFrame(selector: number, raw: number): Uint8Array {
  checkIndex('raw value', raw, 255);
  return new Pb().varint(3, selector).varint(4, raw).varint(5, 0).frame(EDIT_MSG.KNOB);
}

/** Capture volume, raw 0..255: `0A C0 18 0A 20 <raw> 28 00 1A 00 00 00` (2026-10-07). State field 44 carries it back. */
export function captureVolumeFrame(raw: number): Uint8Array {
  return knobFrame(10, raw);
}

/** Gate threshold, raw 0..255: the capture volume's frame with selector 11 (2026-10-10). State field 53 = raw / 255. */
export function gateThresholdFrame(raw: number): Uint8Array {
  return knobFrame(11, raw);
}

/** The capture's amp knobs, in the pedal's order (its knobs and Cortex Cloud's capture page). */
export const AMP_KNOBS = ['gain', 'bass', 'mid', 'treble'] as const;
export type AmpKnob = (typeof AMP_KNOBS)[number];
/** The knob frame's selector per amp knob; state fields 3, 5, 6, 7 carry them back. */
const AMP_KNOB_SELECTOR: Record<AmpKnob, number> = { gain: 0, bass: 2, mid: 3, treble: 4 };

/** An amp knob, raw 0..255: the capture volume's frame with selectors 0, 2, 3, 4 (tried on the pedal 2026-10-16). */
export function ampKnobFrame(knob: AmpKnob, raw: number): Uint8Array {
  return knobFrame(AMP_KNOB_SELECTOR[knob], raw);
}

/**
 * Outputs 1/2 volume, raw 0..255: selector 1, read back in state field 4. The pedal's LEVEL knob: the same on every
 * preset, saved or not, and not heard in the headphones (on the pedal, 2026-10-16). Not part of the preset.
 */
export function outputLevelFrame(raw: number): Uint8Array {
  return knobFrame(1, raw);
}

/** An amp knob's (and the output level's) readout, 0.0 .. 10.0 as the pedal's knobs are marked. */
export function ampKnobText(raw: number): string {
  return ((raw / 255) * 10).toFixed(1);
}

const CAP_VOL_MIN_DB = -24;
const CAP_VOL_SPAN_DB = 36;
const CAP_VOL_CURVE = 1.708;

/**
 * Capture volume raw 0..255 = -24..+12 dB on a curve fitted to five Cortex Cloud readouts (2026-10-07: 0 = -24,
 * 39 = -12.0, 102 = -2.9, 128 = 0.0, 255 = +12): raw = 255 * ((dB + 24) / 36)^1.708.
 */
export function captureVolumeDb(raw: number): number {
  return CAP_VOL_SPAN_DB * Math.pow(Math.min(255, Math.max(0, raw)) / 255, 1 / CAP_VOL_CURVE) + CAP_VOL_MIN_DB;
}

export function captureVolumeRaw(db: number): number {
  const x = (db - CAP_VOL_MIN_DB) / CAP_VOL_SPAN_DB;
  if (x <= 0) return 0;
  if (x >= 1) return 255;
  return Math.round(255 * Math.pow(x, CAP_VOL_CURVE));
}

/** Cortex Cloud's readout: the value cut toward zero in tenths (with 0.01 dB of slack), "-3.0 dB". */
export function captureVolumeText(raw: number): string {
  const t = captureVolumeDb(raw) * 10;
  const tenths = Math.trunc(t < 0 ? t - 0.1 : t + 0.1);
  return `${tenths > 0 ? '+' : ''}${(tenths / 10).toFixed(1)} dB`;
}

/** 0.0 dB (the screen's double tap resets to it). */
export const CAPTURE_VOLUME_DEFAULT_RAW = 128;

// ---------------------------------------------------------------------------
// IR (cab): select, settings read / write, microphone, library load
// ---------------------------------------------------------------------------

export type CabParam = 'level' | 'highPass' | 'lowPass';
export const CAB_PARAMS: readonly CabParam[] = ['level', 'highPass', 'lowPass'];

/** Each IR parameter: value = min + span * n^exponent (fitted to Cortex Cloud's readouts, 2026-10-08/09). */
const CAB_SCALES: Record<CabParam, { min: number; max: number; exp: number; unit: string; decimals: number }> = {
  level: { min: -96, max: 12, exp: 1 / 3.5, unit: 'dB', decimals: 1 },
  highPass: { min: 20, max: 800, exp: 5 / 3, unit: 'Hz', decimals: 0 },
  lowPass: { min: 1000, max: 20000, exp: 5 / 3, unit: 'Hz', decimals: 0 },
};

export const CAB_POSITIONS = 6;

export function cabValue(param: CabParam, n: number): number {
  const s = CAB_SCALES[param];
  return s.min + Math.pow(clamp01(n), s.exp) * (s.max - s.min);
}

export function cabNormalized(param: CabParam, value: number): number {
  const s = CAB_SCALES[param];
  const x = (value - s.min) / (s.max - s.min);
  return x > 0 ? Math.min(1, Math.pow(x, 1 / s.exp)) : 0;
}

export function cabValueText(param: CabParam, n: number): string {
  const s = CAB_SCALES[param];
  const v = cabValue(param, n);
  if (param === 'lowPass' && v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz`;
  return `${v.toFixed(s.decimals)} ${s.unit}`;
}

/**
 * IR slot select (selector 3): slot 1..5 on the pedal's IR list, 6 = the preset's own IR (state field 12 for most
 * presets), 0 = IR off: `08 C0 18 03 20 <slot> 1C 00 00 00`. Up to 0x7F like the firmware's builder.
 */
export function cabSelectFrame(slot: number): Uint8Array {
  checkIndex('IR slot', slot, 0x7f);
  return new Pb().varint(3, 3).varint(4, slot).frame(EDIT_MSG.ENCODER);
}

/**
 * Read the IR's settings: `08 C0 18 <preset> 20 <slot - 1> 5F 00 00 00` (preset 0..63, slot = state field 12) →
 * type 0x60. Field 3 is the preset: Cortex Cloud sent `18 31 20 02` on preset 50 (HCI snoop 2026-10-16). It read
 * as a constant 0 in the earlier snoops, all on preset 1; with 0 the pedal answers about preset 1's IR.
 */
export function cabSettingsRequest(preset: number, slot: number): Uint8Array {
  checkIndex('preset', preset, PRESET_COUNT - 1);
  checkIndex('IR slot', slot, 0x7f, 1);
  return new Pb().varint(3, preset).varint(4, slot - 1).frame(EDIT_MSG.CAB_SETTINGS_REQUEST);
}

/** Level / high pass / low pass: `09 C0 <field 5 / 6 / 7, f32 0..1> 5E 00 00 00` (clamped). */
export function cabSettingFrame(param: CabParam, normalized: number): Uint8Array {
  return new Pb().f32(5 + CAB_PARAMS.indexOf(param), clamp01(normalized)).frame(EDIT_MSG.CAB_SETTING);
}

/** Phase: `06 C0 40 <1 inverted / 0> 5E 00 00 00`. */
export function cabPhaseFrame(inverted: boolean): Uint8Array {
  return new Pb().varint(8, inverted ? 1 : 0).frame(EDIT_MSG.CAB_SETTING);
}

/**
 * A factory IR's microphone and position: `<len> C0 1A <n> { 08 <kind> 12 <IR name> 18 <position 0..5> 22 <mic> }
 * 5E 00 00 00`: the factory IR is picked by name, position and microphone (kind and name from the read).
 */
export function cabMicFrame(kind: number, irName: string, position: number, mic: string): Uint8Array {
  if (!irName || !mic) throw new RangeError('IR name and microphone required');
  checkIndex('microphone position', position, CAB_POSITIONS - 1);
  return new Pb()
    .sub(3, (pb) => pb.varint(1, kind).text(2, irName).varint(3, position).text(4, mic))
    .frame(EDIT_MSG.CAB_SETTING);
}

export type LibraryList = 'factory' | 'user';

/**
 * Load an IR from the library into the current preset (Cortex Cloud's IR loader):
 * `<len> C0 <1A factory / 22 user> <n> { 08 <index> 12 <name> } 5E 00 00 00`.
 */
export function cabLoadFrame(list: LibraryList, index: number, name: string): Uint8Array {
  if (!name) throw new RangeError('IR name required');
  return new Pb().sub(list === 'factory' ? 3 : 4, (pb) => pb.varint(1, index).text(2, name)).frame(EDIT_MSG.CAB_SETTING);
}

export interface CabSettings {
  /** The pedal's 0..1 per parameter. */
  level: number;
  highPass: number;
  lowPass: number;
  /** Field 5: a factory IR, whose microphone and position can be chosen. */
  factory: boolean;
  kind: number;
  irName: string;
  /** 0..5 (Cortex Cloud's 1..6, from the cone's centre to its edge). */
  position: number;
  mic: string;
  /** The microphones this IR offers. */
  mics: string[];
  phaseInverted: boolean;
}

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function text(fields: ProtoField[], n: number): string {
  const raw = firstBytes(fields, n);
  return raw ? utf8(raw) : '';
}

/**
 * IR settings reply (0x60):
 *   5 { 1: kind, 2: IR name, 3: position 0..5, 4: microphone }  a factory IR, or
 *   6 { 1: kind, 2: IR name }                                   one of the user's
 *   7: microphone (repeated)                                    the ones this IR offers
 *   8 { 1: level, 2: high pass, 3: low pass (f32, 0 left out), 4: phase inverted }
 * Null when it describes no IR.
 */
export function decodeCabSettings(payload: Uint8Array): CabSettings | null {
  const out: CabSettings = { level: 0, highPass: 0, lowPass: 0, factory: false, kind: 0, irName: '', position: 0, mic: '', mics: [], phaseInverted: false };
  let ir = false;
  for (const f of parseFields(payload)) {
    if (f.wire !== 2) continue;
    if ((f.field === 5 || f.field === 6) && !ir) {
      ir = true;
      const g = parseFields(f.raw);
      out.factory = f.field === 5;
      out.kind = firstVarint(g, 1) ?? 0;
      out.irName = text(g, 2);
      const pos = firstVarint(g, 3) ?? 0;
      out.position = pos < CAB_POSITIONS ? pos : 0;
      out.mic = text(g, 4);
    } else if (f.field === 7 && f.raw.length) {
      out.mics.push(utf8(f.raw));
    } else if (f.field === 8) {
      for (const g of parseFields(f.raw)) {
        if (g.wire === 5 && g.field >= 1 && g.field <= 3) {
          out[CAB_PARAMS[g.field - 1]!] = new DataView(g.raw.buffer, g.raw.byteOffset, 4).getFloat32(0, true);
        } else if (g.wire === 0 && g.field === 4) {
          out.phaseInverted = g.value !== 0;
        }
      }
    }
  }
  return ir ? out : null;
}

// ---------------------------------------------------------------------------
// Library: every capture and IR on the pedal, and loading one
// ---------------------------------------------------------------------------

export type LibraryKind = 'captures' | 'irs';

/**
 * Library request (Cortex Cloud's, 2026-10-09): `0C C0 18 01 20 01 28 01 30 01 4C 00 00 00` asks for factory
 * captures, factory IRs, user captures and user IRs (fields 3..6). The IR names alone are ~1.1 KB, the captures
 * ~10 KB (each with a 64-character hash).
 */
export function libraryRequest(what: readonly LibraryKind[]): Uint8Array {
  const caps = what.includes('captures');
  const irs = what.includes('irs');
  if (!caps && !irs) throw new RangeError('nothing to ask for');
  const pb = new Pb();
  if (caps) pb.varint(3, 1);
  if (irs) pb.varint(4, 1);
  if (caps) pb.varint(5, 1);
  if (irs) pb.varint(6, 1);
  return pb.frame(EDIT_MSG.LIBRARY_REQUEST);
}

export interface LibraryItem {
  list: LibraryList;
  /** Position in its list: what the loads address it by. */
  index: number;
  name: string;
}

export interface Library {
  captures: LibraryItem[] | null;
  irs: LibraryItem[] | null;
}

/**
 * Library reply (0x4D, multi-packet): fields 3 / 5 = a factory / user capture {1: hash, 2: name}, 4 / 6 = a factory /
 * user IR's name, each repeated in the pedal's order. A kind the reply does not carry is null.
 */
export function decodeLibrary(payload: Uint8Array): Library {
  const fields = parseFields(payload);
  const list = (field: number, kind: LibraryList, capture: boolean): LibraryItem[] => {
    const out: LibraryItem[] = [];
    for (const f of fields) {
      if (f.field !== field || f.wire !== 2) continue;
      const name = capture ? text(parseFields(f.raw), 2) : utf8(f.raw);
      out.push({ list: kind, index: out.length, name });
    }
    return out;
  };
  const caps = [...list(3, 'factory', true), ...list(5, 'user', true)];
  const irs = [...list(4, 'factory', false), ...list(6, 'user', false)];
  return { captures: caps.length ? caps : null, irs: irs.length ? irs : null };
}

/**
 * Preview a library capture (live, the preset is not marked edited):
 * `<len> C0 <1A factory / 22 user> <n> { 08 <index> 12 <name> } 40 01 96 00 00 00` → type 0x97.
 */
export function capturePreviewFrame(item: LibraryItem): Uint8Array {
  if (!item.name) throw new RangeError('capture name required');
  return new Pb()
    .sub(item.list === 'factory' ? 3 : 4, (pb) => pb.varint(1, item.index).text(2, item.name))
    .varint(8, 1)
    .frame(EDIT_MSG.CAPTURE_PREVIEW);
}

/**
 * Stop a capture preview (Cortex Cloud's stop button, HCI snoop 2026-10-11): `0D C0 10 <ms since 1970, varint> 18 00
 * 94 00 00 00` → type 0x95 `08 01 10 <the same ms> 18 01`. The saved capture plays again. A "Use" (slot load, then
 * its select) ends a preview without this frame.
 */
export function capturePreviewStopFrame(nowMs = Date.now()): Uint8Array {
  return new Pb().varint(2, nowMs).varint(3, 0).frame(EDIT_MSG.CAPTURE_PREVIEW_STOP);
}

/**
 * Preview a library IR, as Cortex Cloud's tap on one (HCI snoop 2026-10-11 10:54): the capture preview's shape with
 * type 0x9E, `<len> C0 <1A factory / 22 user> <n> { 08 <index> 12 <name> } 40 01 9E 00 00 00` → type 0x9F
 * `08 06 18 01 22 { 12 <name> }`. (The user list's field 4 is the one seen; factory as the captures'.)
 */
export function irPreviewFrame(item: LibraryItem): Uint8Array {
  if (!item.name) throw new RangeError('IR name required');
  return new Pb()
    .sub(item.list === 'factory' ? 3 : 4, (pb) => pb.varint(1, item.index).text(2, item.name))
    .varint(8, 1)
    .frame(EDIT_MSG.IR_PREVIEW);
}

/** Stop an IR preview (same snoop): the capture stop with field 4 = 0 for field 3, `0D C0 10 <ms> 20 00 94 00 00 00` → 0x95. */
export function irPreviewStopFrame(nowMs = Date.now()): Uint8Array {
  return new Pb().varint(2, nowMs).varint(4, 0).frame(EDIT_MSG.CAPTURE_PREVIEW_STOP);
}

/**
 * Cortex Cloud's "Use": write a library capture into bank slot 0..24 (every preset on that slot hears it):
 * `<len> C0 18 <slot> <22 factory / 2A user> <n> { 08 <index> 12 <name> } 50 00 00 00` → type 0x51 `08 06 18 01`;
 * then the slot is selected (`captureSlotSelectFrame`), which marks the preset edited.
 */
export function captureSlotLoadFrame(slot: number, item: LibraryItem): Uint8Array {
  checkIndex('capture slot', slot, CAPTURE_SLOT_COUNT - 1);
  if (!item.name) throw new RangeError('capture name required');
  return new Pb()
    .varint(3, slot)
    .sub(item.list === 'factory' ? 4 : 5, (pb) => pb.varint(1, item.index).text(2, item.name))
    .frame(EDIT_MSG.CAPTURE_SLOT_LOAD);
}

/**
 * The IR equivalent (type 0x4E → 0x4F): IR slot 0..4, or 5 = the preset's own IR slot (Cortex Cloud, HCI snoop
 * 2026-10-11 10:54: `24 C0 18 05 2A 1C {08 25 12 "YA VX30 212 BLU Mix BMAY"} 4E`, then `08 C0 18 03 20 06 1C`).
 */
export function cabSlotLoadFrame(slot: number, item: LibraryItem): Uint8Array {
  checkIndex('IR slot', slot, CAB_SLOT_COUNT);
  if (!item.name) throw new RangeError('IR name required');
  return new Pb()
    .varint(3, slot)
    .sub(item.list === 'factory' ? 4 : 5, (pb) => pb.varint(1, item.index).text(2, item.name))
    .frame(EDIT_MSG.CAB_SLOT_LOAD);
}

/** Slots selector 1 reaches (1..5, like the IR's); 6 = the preset's own capture. */
export const CAPTURE_SELECT_SLOTS = 5;
/** Capture banks (field 9, 1..5): 5 × 5 = the pedal's 25 capture slots. */
export const CAPTURE_BANKS = 5;
export const CAPTURE_OWN_SLOT = 6;
/** Field 12 / the IR select's 6: the IR saved in the preset itself (board 2026-10-10: selecting it restores it). */
export const CAB_OWN_SLOT = 6;

/**
 * The capture in slot 1..5 on (Cortex Cloud after a use: `08 C0 18 01 20 <slot> 1C 00 00 00`), 6 = back to the
 * preset's own capture (board 2026-10-10: the unsaved flag clears), 0 = bypassed.
 */
export function captureSlotSelectFrame(slot: number): Uint8Array {
  checkIndex('capture slot', slot, CAPTURE_OWN_SLOT);
  return new Pb().varint(3, 1).varint(4, slot).frame(EDIT_MSG.ENCODER);
}

// ---------------------------------------------------------------------------
// Presets: rename, create, delete, footswitch
// ---------------------------------------------------------------------------

/**
 * Longest name written: the pedal itself checks nothing (2026-10-08: it took "", 3 characters, duplicates, 32
 * characters, UTF-8), so the app keeps its own rules: 4 to 31 characters (the firmware's name cache), unique.
 */
export const PRESET_NAME_MIN = 4;
export const PRESET_NAME_WRITE_MAX = 31;

/** Why `name` cannot be written for `index`, or null when it can. */
export function presetNameProblem(name: string, index: number, names: readonly string[]): string | null {
  const n = name.trim();
  if (n !== name) return 'No spaces at the start or the end';
  if (n.length < PRESET_NAME_MIN) return `At least ${PRESET_NAME_MIN} characters`;
  if (new TextEncoder().encode(n).length > PRESET_NAME_WRITE_MAX) return `At most ${PRESET_NAME_WRITE_MAX} characters`;
  const lower = n.toLowerCase();
  const dup = names.findIndex((other, i) => i !== index && other.trim().toLowerCase() === lower);
  if (dup >= 0) return `Preset ${dup + 1} already has this name`;
  return null;
}

function nameBytes(name: string): Uint8Array {
  const b = new TextEncoder().encode(name);
  if (b.length === 0 || b.length > PRESET_NAME_WRITE_MAX) throw new RangeError(`bad preset name length ${b.length}`);
  return b;
}

/**
 * Rename (verified 2026-10-08): `<len> C0 08 01 18 <preset> 22 <n> <name> 6F 00 00 00`. The pedal
 * stores the name at once (no save needed) and answers type 0x70 `08 06 18 <preset> 20 <1 = ok>`.
 */
export function presetRenameFrame(index: number, name: string): Uint8Array {
  checkIndex('preset', index, PRESET_COUNT - 1);
  return new Pb().varint(1, OP_UPDATE).varint(3, index).bytes(4, nameBytes(name)).frame(EDIT_MSG.RENAME);
}

/**
 * Cortex Cloud's "create preset" on an empty slot (2026-10-10): the shown preset stored as `index` under `name`:
 * `<len> C0 08 01 18 <preset> 2A <n> <name> 03 00 00 00` → type 0x04 `08 06 18 <preset> 20 01`.
 */
export function presetCreateFrame(index: number, name: string): Uint8Array {
  checkIndex('preset', index, PRESET_COUNT - 1);
  return new Pb().varint(1, OP_UPDATE).varint(3, index).bytes(5, nameBytes(name)).frame(EDIT_MSG.PRESET_CREATE);
}

/** Delete (2026-10-10): `<len> C0 08 02 18 <preset> 32 00 00 00` → type 0x33; the preset is empty after. */
export function presetDeleteFrame(index: number): Uint8Array {
  checkIndex('preset', index, PRESET_COUNT - 1);
  return new Pb().varint(1, OP_DELETE).varint(3, index).frame(EDIT_MSG.PRESET_DELETE);
}

export const FOOTSWITCHES = ['ia', 'ib', 'iia', 'iib'] as const;
export type Footswitch = (typeof FOOTSWITCHES)[number];

/**
 * Put a preset on one of the pedal's footswitches (2026-10-10): the preset select's frame with field 4 = -1, the
 * footswitch's field (5 IA, 6 IB, 7 IIA, 8 IIB) = the preset, the others -1, field 9 = 2. Answered like a select.
 */
export function footswitchAssignFrame(index: number, footswitch: Footswitch): Uint8Array {
  checkIndex('preset', index, PRESET_COUNT - 1);
  const fs = FOOTSWITCHES.indexOf(footswitch);
  const pb = new Pb().varint(3, 0).minusOne(4);
  for (let i = 0; i < 4; i++) {
    if (i === fs) pb.varint(5 + i, index);
    else pb.minusOne(5 + i);
  }
  return pb.varint(9, 2).frame(EDIT_MSG.PRESET_CHANGED);
}

/** Replies `08 06 18 <preset> 20 <1 = ok>` to a rename (0x70), delete (0x33) or create (0x04); preset 1 has no field 3. */
export function decodePresetReply(payload: Uint8Array): { preset: number; ok: boolean } | null {
  const f = parseFields(payload);
  const preset = firstVarint(f, 3) ?? 0;
  if (preset >= PRESET_COUNT) return null;
  return { preset, ok: firstVarint(f, 4) === 1 };
}

/** `field 3 = 1` acks (capture slot load 0x51, preview 0x97, IR slot load 0x4F). */
export function decodeOk(payload: Uint8Array): boolean {
  return firstVarint(parseFields(payload), 3) === 1;
}

/** 0x1B with field 3 = 2: the pedal saved the shown preset. */
export function isPresetSaved(payload: Uint8Array): boolean {
  return firstVarint(parseFields(payload), 3) === 2;
}
