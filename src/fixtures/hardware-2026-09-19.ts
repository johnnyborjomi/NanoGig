/**
 * Packets captured 2026-09-19 from a Bluetooth HCI snoop log of Cortex Cloud
 * (Android) selecting presets 1..10 from its preset list on NanOS 2.2.1.
 * Byte-exact; see docs/PROTOCOL.md "Preset switching".
 */
import { fromHex } from '../protocol/hex';

/**
 * Preset select written to c304 (with response) for preset index 0. Same message type as the
 * pedal's own preset-changed event (0x1D): field 4 = preset, fields 5–8 = IA/IB/IIA/IIB set
 * to -1 (10-byte varint) = leave unchanged, field 9 = 4 (see PROTOCOL.md).
 */
export const HW_PRESET_SELECT_0 = fromHex(
  '36 C0 18 00 20 00 28 FF FF FF FF FF FF FF FF FF 01 30 FF FF FF FF FF FF FF FF FF 01 38 FF FF FF FF FF FF FF FF FF 01 40 FF FF FF FF FF FF FF FF FF 01 48 04 1D 00 00 00',
);

/** Same, preset index 9 (the tenth click in the capture). */
export const HW_PRESET_SELECT_9 = fromHex(
  '36 C0 18 00 20 09 28 FF FF FF FF FF FF FF FF FF 01 30 FF FF FF FF FF FF FF FF FF 01 38 FF FF FF FF FF FF FF FF FF 01 40 FF FF FF FF FF FF FF FF FF 01 48 04 1D 00 00 00',
);

/**
 * The pedal's reply to every select, within ~100 ms of the write response: a bypass-changed
 * notice (`… 1F …`, already known) followed by this type-0x1E ack. Cortex Cloud then requests
 * the current state, whose field 13 carries the new index.
 */
export const HW_PRESET_SELECT_ACK = fromHex('08 C0 08 01 20 01 1E 00 00 00');

// ---------------------------------------------------------------------------
// Tuner (second capture the same day: Cortex Cloud's tuner page, all six strings
// plucked, the mute switch toggled, the reference slider dragged 440 → 462 → 440)
// ---------------------------------------------------------------------------

/**
 * Tuner ON, written to c304 when the tuner page opens (type 0x7F): field 4 = 1,
 * field 5 = reference pitch (fixed32 float, 440.0), field 6 = 1, field 7 = mute (0 here).
 */
export const HW_TUNER_ON_440 = fromHex('0F C0 20 01 2D 00 00 DC 43 30 01 38 00 7F 00 00 00');
/** Same with the tuner's mute switch on (field 7 = 1). Sent again on every toggle. */
export const HW_TUNER_ON_440_MUTED = fromHex('0F C0 20 01 2D 00 00 DC 43 30 01 38 01 7F 00 00 00');
/** Same with the reference slider at 462 Hz (0x43E70000); sent on every slider step. */
export const HW_TUNER_ON_462 = fromHex('0F C0 20 01 2D 00 00 E7 43 30 01 38 00 7F 00 00 00');
/**
 * The pedal's reply to tuner-on (NanoGig hex log 2026-09-19, ~1.6 s after the write): type 0x7F
 * back with field 4 = 1 and field 5 = the reference it took (440.0). No state change follows.
 */
export const HW_TUNER_ON_ACK = fromHex('0D C0 08 01 20 01 2D 00 00 DC 43 7F 00 00 00');
/** Tuner OFF, written when the tuner page closes: field 4 = 0. */
export const HW_TUNER_OFF = fromHex('06 C0 20 00 7F 00 00 00');

/**
 * Pitch events (type 0x80) streamed ~30/s while a note is detected, nothing in silence:
 * field 4 = note name (ASCII, one letter here), field 5 = cents off (fixed32 float),
 * field 6 = 1, field 7 = 1 only when in tune (|cents| below ~2).
 */
export const HW_TUNER_PITCH_A_PLUS_14 = fromHex('10 C0 08 01 22 01 41 2D B5 5B 64 41 30 01 80 00 00 00'); // A, +14.27 ct
export const HW_TUNER_PITCH_D_MINUS_0_5 = fromHex('12 C0 08 01 22 01 44 2D 52 9A 0A BF 30 01 38 01 80 00 00 00'); // D, -0.54 ct, in tune
export const HW_TUNER_PITCH_G_PLUS_2_3 = fromHex('10 C0 08 01 22 01 47 2D 61 D3 15 40 30 01 80 00 00 00'); // G, +2.34 ct, not in tune
