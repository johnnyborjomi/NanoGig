/**
 * Packets captured 2026-09-15 from a Bluetooth HCI snoop log of Cortex Cloud
 * (Android) toggling the pedal's "Mute Outputs 1/2" setting five times on
 * NanOS 2.2.1. Byte-exact; see docs/PROTOCOL.md "Device settings".
 */
import { fromHex } from '../protocol/hex';

/** Cortex Cloud sends this at connect and again when its device-settings page opens. */
export const HW_DEVICE_SETTINGS_REQUEST = fromHex('06 C0 08 03 41 00 00 00');

/**
 * Reply to the settings request (type 0x42, 60 B) with outputs 1/2 ON: field 5 =
 * "Neural DSP Nano Cortex", fields 6/13 = 56/107, field 17 = fixed32 float -6.0, and
 * **field 16 = 1 (`80 01 01`) = outputs enabled**.
 */
export const HW_DEVICE_SETTINGS_REPLY = fromHex(
  '3A C0 08 01 18 01 2A 16 4E 65 75 72 61 6C 20 44 53 50 20 4E 61 6E 6F 20 43 6F 72 74 65 78 30 38 38 01 40 01 58 00 60 01 68 6B 70 01 80 01 01 8D 01 00 00 C0 C0 90 01 01 42 00 00 00',
);

/**
 * Same reply with outputs 1/2 MUTED (57 B): field 16 is simply absent. From NanoGig's own log
 * 2026-09-15, read back 300 ms after the mute write was acknowledged.
 */
export const HW_DEVICE_SETTINGS_REPLY_MUTED = fromHex(
  '37 C0 08 01 18 01 2A 16 4E 65 75 72 61 6C 20 44 53 50 20 4E 61 6E 6F 20 43 6F 72 74 65 78 30 38 38 01 40 01 58 00 60 01 68 6B 70 01 8D 01 00 00 C0 C0 90 01 01 42 00 00 00',
);

/**
 * The five writes Cortex Cloud sent while the switch was flipped, ~8 s apart, starting from
 * outputs on: value 0 = mute, 1 = outputs on (confirmed by ear in NanoGig 2026-09-15).
 */
export const HW_OUTPUTS_MUTE_WRITES = [
  fromHex('08 C0 08 01 68 00 43 00 00 00'),
  fromHex('08 C0 08 01 68 01 43 00 00 00'),
  fromHex('08 C0 08 01 68 00 43 00 00 00'),
  fromHex('08 C0 08 01 68 01 43 00 00 00'),
  fromHex('08 C0 08 01 68 00 43 00 00 00'),
];

/** The pedal's reply to every one of those writes, within ~100 ms. */
export const HW_OUTPUTS_MUTE_ACK = fromHex('08 C0 08 01 18 01 44 00 00 00');
