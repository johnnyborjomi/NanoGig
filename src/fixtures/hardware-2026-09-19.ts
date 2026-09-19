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

// ---------------------------------------------------------------------------
// Expression pedal (third capture the same day: Cortex Cloud's Expression Pedal page,
// pedal rocked via an Mvave Chocolate over MIDI, post 3 assigned 17–130 on preset 58,
// then on preset 2: cleared, post 3 back on, range dragged to 0–255, post 2 added)
// ---------------------------------------------------------------------------

/** Position events (type 0x40), ~20/s while the pedal moves: field 3 = 2, field 4 = 0–254 (absent at heel). */
export const HW_EXP_POSITION_138 = fromHex('0B C0 08 01 18 02 20 8A 01 40 00 00 00');
export const HW_EXP_POSITION_HEEL = fromHex('08 C0 08 01 18 02 40 00 00 00');
export const HW_EXP_POSITION_TOE = fromHex('0B C0 08 01 18 02 20 FE 01 40 00 00 00');

/**
 * Mapped values (type 0xAA), sent with every position: one field per assigned slot holding the
 * parameter value after the range is applied (0–255). Field 12 = post 2, field 13 = post 3.
 */
export const HW_EXP_VALUES_POST3 = fromHex('08 C0 08 01 68 4E AA 00 00 00'); // post 3 = 78
export const HW_EXP_VALUES_POST2_POST3 = fromHex('0C C0 08 01 60 E0 01 68 E0 01 AA 00 00 00'); // both 224
export const HW_EXP_VALUES_NONE = fromHex('06 C0 08 01 AA 00 00 00'); // sent on preset load, nothing assigned

/** Cortex Cloud reads a preset's assignments: `08 C0 08 03 18 <preset> 3C 00 00 00` (preset 58 here). */
export const HW_EXP_ASSIGN_REQUEST_58 = fromHex('08 C0 08 03 18 3A 3C 00 00 00');
/** Reply (type 0x3D): one sub-message per assigned slot `{2: min, 3: max}`; field 11 = post 3 (17–130). */
export const HW_EXP_ASSIGN_REPLY_58 = fromHex('0D C0 08 01 5A 05 10 11 18 82 01 3D 00 00 00');
/** Same for preset 2 before the user's edits: post 3, 15–127. */
export const HW_EXP_ASSIGN_REPLY_2 = fromHex('0C C0 08 01 5A 04 10 0F 18 7F 3D 00 00 00');
/**
 * Cortex Cloud's write (type 0x3E) after "post 2 and post 3, both 0–100 %": field 3 = preset,
 * field 11 = post 2 `{1:0, 2:0, 3:255}`, field 12 = post 3. Note the reply numbers slots one lower.
 */
export const HW_EXP_ASSIGN_WRITE_2 = fromHex('18 C0 18 02 5A 07 08 00 10 00 18 FF 01 62 07 08 00 10 00 18 FF 01 3E 00 00 00');
/** Ack to the write (type 0x3F). */
export const HW_EXP_ASSIGN_ACK = fromHex('08 C0 08 01 18 01 3F 00 00 00');

/**
 * Fourth capture: everything assignable assigned on preset 6, in Cortex Cloud's list order.
 * Cortex Cloud rewrites the whole list on each change; this is the final write (0x3E): ranges
 * `{1:0, 2:0, 3:255}` at fields 4–7 (gain, bass, mid, treble), 8–12 (pre 1 … post 3), 13 (?),
 * 21 (level); bypasses at 14 (capture), 15 (IR), 16–20 (pre 1 … post 3), 22 (?), each
 * `{<mode>: {…}}`: mode 1 `{1:0, 2:600}` and mode 3 `{1:600}` never fired without a switch,
 * mode 2 `{1:0, 2:0}` flips at mid-travel (heel-toe).
 */
export const HW_EXP_ASSIGN_WRITE_ALL = fromHex(
  'B0 C0 18 06 22 07 08 00 10 00 18 FF 01 2A 07 08 00 10 00 18 FF 01 32 07 08 00 10 00 18 FF 01 3A 07 08 00 10 00 18 FF 01 42 07 08 00 10 00 18 FF 01 4A 07 08 00 10 00 18 FF 01 52 07 08 00 10 00 18 FF 01 5A 07 08 00 10 00 18 FF 01 62 07 08 00 10 00 18 FF 01 6A 07 08 00 10 00 18 FF 01 72 07 0A 05 08 00 10 D8 04 7A 05 1A 03 08 D8 04 82 01 06 12 04 08 00 10 00 8A 01 06 12 04 08 00 10 00 92 01 06 12 04 08 00 10 00 9A 01 06 12 04 08 00 10 00 A2 01 06 12 04 08 00 10 00 AA 01 07 08 00 10 00 18 FF 01 B2 01 06 12 04 08 00 10 00 3E 00 00 00',
);
/**
 * Values event with everything assigned, pedal at 96/254: ranges 4–7 (gain … treble), 8 (level),
 * 9–14 (pre 1 … post 3, ?), bypass flags 17–22 = 1 (the six heel-toe ones, past mid-travel);
 * 15 / 16 (capture, IR: switch / stop modes) absent here, 0 in other events.
 */
export const HW_EXP_VALUES_ALL_96 = fromHex(
  '2E C0 08 01 20 60 28 60 30 60 38 60 40 60 48 60 50 60 58 60 60 60 68 60 70 60 88 01 01 90 01 01 98 01 01 A0 01 01 A8 01 01 B0 01 01 AA 00 00 00',
);
