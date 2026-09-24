/**
 * Byte-exact command frames for the Nano Cortex `c304` command channel and
 * MIDI bytes for `c302`.
 *
 * Every frame here is copied verbatim from the reference material or from a
 * byte-exact capture of the official app talking to the pedal:
 *   - choldy/nano-cortex-web-editor (MIT) — original capture of the frames
 *   - rixrix/deskop-nano-cortex `docs/specs/110-backend-midi-ble/spec.md`
 *     ("State-dump request commands", "Write-command byte layouts")
 *   - Bluetooth HCI snoop logs of Cortex Cloud (`src/fixtures/hardware-*.ts`)
 *
 * Frame convention (per the spec): byte[0] = payload.length - 2, byte[1] = 0xC0,
 * then a protobuf-ish body, then a `<tag> 00 00 00` footer whose tag byte is
 * command-specific. DO NOT invent new frames here — if a frame was not seen on
 * the wire it does not belong in this file.
 *
 * All frames are PROVISIONAL: verified against NanOS ~2.2.1, may change silently.
 */
import { fromHex } from './hex';

/** Metadata dump request (preset / capture / IR name lists). Reply: FE stream on c305. */
export const METADATA_DUMP_REQUEST: Uint8Array = fromHex('06 C0 08 03 01 00 00 00');

/** Current-preset-state dump request. Reply: `C1` single packet or FE stream on c305. */
export const CURRENT_STATE_REQUEST: Uint8Array = fromHex('0C C0 08 03 18 01 20 01 28 01 01 00 00 00');

/** Sent after an app-initiated Program Change so the device acknowledges the switch. */
export const PRESET_CHANGE_ACK: Uint8Array = fromHex('06 C0 20 01 1E 00 00 00');

export const FX_SLOTS = ['pre1', 'pre2', 'post1', 'post2', 'post3'] as const;
export type FxSlot = (typeof FX_SLOTS)[number];

/** `18 <enableSlot>` selector used by the bypass frame: pre1=4 … post3=8. */
export const FX_ENABLE_SLOT: Record<FxSlot, number> = {
  pre1: 0x04,
  pre2: 0x05,
  post1: 0x06,
  post2: 0x07,
  post3: 0x08,
};

/** Gate uses the same bypass frame with selector 9. */
export const GATE_ENABLE_SLOT = 0x09;

/** Footer tag byte of the bypass frame. */
const BYPASS_TAG = 0x1f;

function bypassFrame(enableSlot: number, enabled: boolean): Uint8Array {
  // 0A C0 08 01 18 <slot> 20 <0=on / 1=off> 1F 00 00 00
  return new Uint8Array([
    0x0a, 0xc0, 0x08, 0x01, 0x18, enableSlot, 0x20, enabled ? 0x00 : 0x01, BYPASS_TAG, 0x00, 0x00, 0x00,
  ]);
}

/** Toggle an FX block: `0A C0 08 01 18 <slot> 20 <0=on/1=off> 1F 00 00 00`. */
export function fxBlockBypassFrame(slot: FxSlot, enabled: boolean): Uint8Array {
  return bypassFrame(FX_ENABLE_SLOT[slot], enabled);
}

/** Toggle the gate: `0A C0 08 01 18 09 20 <0=on/1=off> 1F 00 00 00`. */
export function gateBypassFrame(enabled: boolean): Uint8Array {
  return bypassFrame(GATE_ENABLE_SLOT, enabled);
}

/** Footer tag of the slot-select family (capture / cab-IR). */
const SLOT_SELECT_TAG = 0x1c;

/** Capture bypass: `08 C0 18 01 20 00 1C 00 00 00` (web editor `selectCaptureSlot(0)`). */
export function captureBypassFrame(): Uint8Array {
  return new Uint8Array([0x08, 0xc0, 0x18, 0x01, 0x20, 0x00, SLOT_SELECT_TAG, 0x00, 0x00, 0x00]);
}

export const CAPTURE_SLOT_COUNT = 25;

/**
 * Select (and thereby enable) a capture slot 1..25: `08 C0 18 04 20 <slot-1> 1C 00 00 00`
 * (web editor `setCapture`). The `18 01` selector must not be used for enabling — it leaves
 * slots >= 16 silent (rixrix spec, hardware-observed 2026-07-16).
 */
export function captureSelectFrame(slot: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 1 || slot > CAPTURE_SLOT_COUNT) throw new RangeError(`capture slot out of range: ${slot}`);
  return new Uint8Array([0x08, 0xc0, 0x18, 0x04, 0x20, slot - 1, SLOT_SELECT_TAG, 0x00, 0x00, 0x00]);
}

export const CAB_SLOT_COUNT = 5;

/** Cab/IR slot select: `08 C0 18 03 20 <slot> 1C 00 00 00`; slot 0 = bypass, 1..5 = enable that IR. */
export function cabIrSlotFrame(slot: number): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot > CAB_SLOT_COUNT) throw new RangeError(`cab/IR slot out of range: ${slot}`);
  return new Uint8Array([0x08, 0xc0, 0x18, 0x03, 0x20, slot, SLOT_SELECT_TAG, 0x00, 0x00, 0x00]);
}

/**
 * Device-settings request: `06 C0 08 03 41 00 00 00`. Cortex Cloud sends it at connect and
 * when its settings page opens; the pedal answers with a 60-byte type 0x42 message
 * (HCI snoop capture 2026-09-15, NanOS 2.2.1). Read-only.
 */
export const DEVICE_SETTINGS_REQUEST: Uint8Array = fromHex('06 C0 08 03 41 00 00 00');

/** Footer tag of the outputs-mute write; the pedal acks with `08 C0 08 01 18 01 44 00 00 00`. */
const OUTPUTS_MUTE_TAG = 0x43;

/**
 * Mute / unmute outputs 1/2 (the global "Mute Outputs 1/2" switch in Cortex Cloud, used when
 * monitoring through a DAW over USB): `08 C0 08 01 68 <1 mute / 0 outputs on> 43 00 00 00`.
 * Captured byte-for-byte from Cortex Cloud 2026-09-15. Polarity: sending 0 left the outputs
 * audible and 1 silenced them (checked by ear on the user's pedal, 2026-09-15). The settings
 * reply's field 16 mirrors the written value exactly, so it cannot settle the polarity alone.
 */
export function outputsMuteFrame(muted: boolean): Uint8Array {
  return new Uint8Array([0x08, 0xc0, 0x08, 0x01, 0x68, muted ? 0x01 : 0x00, OUTPUTS_MUTE_TAG, 0x00, 0x00, 0x00]);
}

export const PRESET_COUNT = 64;

/** Cortex Cloud's tuner reference slider range (Hz); 440 is the pedal's default (state field 46). */
export const TUNER_REFERENCE_MIN_HZ = 400;
export const TUNER_REFERENCE_MAX_HZ = 480;
export const TUNER_REFERENCE_DEFAULT_HZ = 440;

/**
 * Tuner on (type 0x7F), captured 2026-09-19 from Cortex Cloud opening its tuner page:
 * `0F C0 20 01 2D <f32 reference Hz> 30 01 38 <0 / 1 mute> 7F 00 00 00`. Cortex Cloud
 * re-sends it on every reference-slider step and every mute toggle. Field 6 = 1 always
 * (meaning unknown). While the tuner is on the pedal streams type-0x80 pitch events.
 * The mute polarity (1 = outputs silenced while tuning) is inferred from the capture
 * order: first write 0, then alternating from the user's first toggle.
 * Field 6 is a constant 1 in every capture. Sending 0 (tried 2026-09-24) changes nothing: the
 * pedal acks and streams the same and still shows its tuner screen.
 */
export function tunerOnFrame(referenceHz = TUNER_REFERENCE_DEFAULT_HZ, mute = false): Uint8Array {
  if (!Number.isFinite(referenceHz) || referenceHz < TUNER_REFERENCE_MIN_HZ || referenceHz > TUNER_REFERENCE_MAX_HZ) {
    throw new RangeError(`tuner reference out of range: ${referenceHz}`);
  }
  const f = new Uint8Array(4);
  new DataView(f.buffer).setFloat32(0, referenceHz, true);
  return new Uint8Array([0x0f, 0xc0, 0x20, 0x01, 0x2d, f[0]!, f[1]!, f[2]!, f[3]!, 0x30, 0x01, 0x38, mute ? 0x01 : 0x00, 0x7f, 0x00, 0x00, 0x00]);
}

/**
 * Read the expression-pedal assignments of a preset (type 0x3C, Cortex Cloud's request on its
 * Expression Pedal page, captured 2026-09-19): `08 C0 08 03 18 <preset> 3C 00 00 00`. The reply
 * (0x3D) carries one `{2: min, 3: max}` sub-message per assigned FX slot, min/max on 0–255.
 */
export function expressionAssignmentsRequest(presetIndex: number): Uint8Array {
  if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= PRESET_COUNT) {
    throw new RangeError(`preset index out of range: ${presetIndex}`);
  }
  return new Uint8Array([0x08, 0xc0, 0x08, 0x03, 0x18, presetIndex, 0x3c, 0x00, 0x00, 0x00]);
}

/** Tuner off (type 0x7F, field 4 = 0), captured 2026-09-19 when the tuner page closed. */
export const TUNER_OFF: Uint8Array = fromHex('06 C0 20 00 7F 00 00 00');

/** Preset names are at most 20 characters — confirmed in Cortex Cloud (2026-09-12). */
export const PRESET_NAME_MAX_LENGTH = 20;

/**
 * MIDI Program Change for `c302`: `[0xC0 | (channel-1), presetIndex]`.
 * `presetIndex` is zero-based (0..63); the UI's "preset 1" is index 0.
 */
export function programChange(presetIndex: number, channel = 1): Uint8Array {
  if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= PRESET_COUNT) {
    throw new RangeError(`preset index out of range: ${presetIndex}`);
  }
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    throw new RangeError(`MIDI channel out of range: ${channel}`);
  }
  return new Uint8Array([0xc0 | (channel - 1), presetIndex]);
}

/**
 * MIDI-over-BLE framing: `[0x80 | ts_hi, 0x80 | ts_lo, ...midi]`. The rixrix
 * preset probe sends a fixed `80 80` header (`ble_midi_program_change_bytes`);
 * kept byte-identical here rather than inventing a timestamp scheme.
 */
export function bleMidiFrame(midi: Uint8Array): Uint8Array {
  return Uint8Array.from([0x80, 0x80, ...midi]);
}

export type MidiChar = 'web-midi' | 'c302' | 'c303' | 'c304';
/**
 * `sequential` = one GATT write per MIDI byte (rixrix probe mode); `select` = not MIDI at
 * all but the pedal's own preset-select frame on c304 (see `presetSelectFrame`).
 */
export type MidiFraming = 'raw' | 'ble-midi' | 'sequential' | 'select';

/** Protobuf varint for -1 as Cortex Cloud writes it (sint-less int32/int64: ten bytes). */
const VARINT_MINUS_ONE = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01] as const;

/**
 * Preset select over Bluetooth, captured 2026-09-19 from Cortex Cloud (HCI snoop, NanOS
 * 2.2.1): a type-0x1D message — the same type as the pedal's preset-changed event — written to
 * c304 with response. Field 3 = 0, field 4 = preset index, fields 5–8 = footswitch IA/IB/IIA/IIB
 * assignments as -1 (leave unchanged), field 9 = 4 (Cortex Cloud sent 4 in 8 of 10 writes and
 * 0 / 1 once each; meaning unknown, the pedal switched every time). The pedal answers with
 * `06 C0 08 01 1F 00 00 00` then `08 C0 08 01 20 01 1E 00 00 00`; dump field 13 confirms.
 */
export function presetSelectFrame(presetIndex: number): Uint8Array {
  if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= PRESET_COUNT) {
    throw new RangeError(`preset index out of range: ${presetIndex}`);
  }
  return new Uint8Array([
    0x36, 0xc0,
    0x18, 0x00,
    0x20, presetIndex,
    0x28, ...VARINT_MINUS_ONE,
    0x30, ...VARINT_MINUS_ONE,
    0x38, ...VARINT_MINUS_ONE,
    0x40, ...VARINT_MINUS_ONE,
    0x48, 0x04,
    0x1d, 0x00, 0x00, 0x00,
  ]);
}

export interface MidiStrategy {
  id: string;
  char: MidiChar;
  framing: MidiFraming;
}

/**
 * The pedal's own preset-select frame on c304 (Cortex Cloud's path, captured 2026-09-19).
 * Tried first: it needs nothing but the Bluetooth link the display already uses.
 */
export const BLE_SELECT_STRATEGY: MidiStrategy = { id: 'c304-select', char: 'c304', framing: 'select' };

/** Web MIDI over the pedal's USB port: verified 2026-09-12, needs the cable. */
export const WEB_MIDI_STRATEGY: MidiStrategy = { id: 'web-midi', char: 'web-midi', framing: 'raw' };

/**
 * BLE ways to deliver a Program Change, all taken from rixrix
 * `nano_ble_preset_probe` (modes raw / ble-midi / sequential; chars c303 then
 * c302). Hardware 2026-09-12: c302 rejects every write ("GATT operation
 * failed"), c303 accepts them but the pedal does not switch. Kept as fallbacks
 * for other firmware; `BLE_SELECT_STRATEGY` and then `WEB_MIDI_STRATEGY` go first.
 */
export const BLE_MIDI_STRATEGIES: readonly MidiStrategy[] = [
  { id: 'c303-ble-midi', char: 'c303', framing: 'ble-midi' },
  { id: 'c302-ble-midi', char: 'c302', framing: 'ble-midi' },
  { id: 'c303-raw', char: 'c303', framing: 'raw' },
  { id: 'c303-sequential', char: 'c303', framing: 'sequential' },
  { id: 'c302-raw', char: 'c302', framing: 'raw' },
];

export const MIDI_STRATEGIES: readonly MidiStrategy[] = [BLE_SELECT_STRATEGY, WEB_MIDI_STRATEGY, ...BLE_MIDI_STRATEGIES];

export function midiStrategyById(id: string | null | undefined): MidiStrategy | null {
  return MIDI_STRATEGIES.find((s) => s.id === id) ?? null;
}

/** Mvave Chocolate style is the default: 4 presets per bank, shown as "1B" (bank number + preset letter). */
export const DEFAULT_PRESETS_PER_BANK = 4;
export const PRESETS_PER_BANK_CHOICES = [2, 3, 4, 5, 6, 8] as const;

/** "number-letter" = 1B (Mvave Chocolate); "letter-number" = A2 (Nano Cortex A–H). */
export type PresetLabelStyle = "number-letter" | "letter-number";
export const DEFAULT_LABEL_STYLE: PresetLabelStyle = "number-letter";

export interface PresetLabelOptions {
  presetsPerBank?: number;
  style?: PresetLabelStyle;
}

/** Bank letter(s): A…Z, then AA, AB… so any bank size 2..8 over 64 presets has a name. */
export function bankName(bank: number): string {
  let n = bank;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Human label for a zero-based preset index as bank + slot. The pedal has no
 * real banks; this mirrors the user's MIDI controller layout:
 *   index 9, 4 per bank, number-letter → "3B"  (Mvave Chocolate)
 *   index 9, 8 per bank, letter-number → "B2"  (Nano Cortex A–H)
 */
export interface PresetLabelParts {
  /** First figure: bank ("3" or "B"). */
  bank: string;
  /** Second figure: preset within the bank ("B" or "2"). */
  slot: string;
  /** Zero-based position within the bank; drives the slot colour. */
  slotIndex: number;
}

export function presetLabelParts(presetIndex: number, opts: PresetLabelOptions = {}): PresetLabelParts | null {
  if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= PRESET_COUNT) return null;
  const per = Math.min(Math.max(Math.floor(opts.presetsPerBank ?? DEFAULT_PRESETS_PER_BANK) || DEFAULT_PRESETS_PER_BANK, 1), PRESET_COUNT);
  const style = opts.style ?? DEFAULT_LABEL_STYLE;
  const bank = Math.floor(presetIndex / per);
  const slot = presetIndex % per;
  return style === "number-letter"
    ? { bank: String(bank + 1), slot: bankName(slot), slotIndex: slot }
    : { bank: bankName(bank), slot: String(slot + 1), slotIndex: slot };
}

export function presetLabel(presetIndex: number, opts: PresetLabelOptions = {}): string {
  const parts = presetLabelParts(presetIndex, opts);
  return parts ? `${parts.bank}${parts.slot}` : "—";
}
