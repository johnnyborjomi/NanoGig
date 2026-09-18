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
