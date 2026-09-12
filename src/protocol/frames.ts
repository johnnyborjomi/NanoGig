/**
 * Byte-exact command frames for the Nano Cortex `c304` command channel and
 * MIDI bytes for `c302`.
 *
 * Every frame here is copied verbatim from the reference material:
 *   - choldy/nano-cortex-web-editor (MIT) — original capture of the frames
 *   - rixrix/deskop-nano-cortex `docs/specs/110-backend-midi-ble/spec.md`
 *     ("State-dump request commands", "Write-command byte layouts")
 *
 * Frame convention (per the spec): byte[0] = payload.length - 2, byte[1] = 0xC0,
 * then a protobuf-ish body, then a `<tag> 00 00 00` footer whose tag byte is
 * command-specific. DO NOT invent new frames here — if a frame is not in the
 * reference repos it does not belong in this file.
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

export const PRESET_COUNT = 64;

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

/** Human label for a zero-based preset index: banks A–H × slots 1–8, e.g. 9 → "B2". */
export function presetLabel(presetIndex: number): string {
  if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= PRESET_COUNT) return '—';
  return `${String.fromCharCode(65 + Math.floor(presetIndex / 8))}${(presetIndex % 8) + 1}`;
}
