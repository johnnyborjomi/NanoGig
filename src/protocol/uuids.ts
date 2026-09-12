/**
 * GATT identifiers for the Nano Cortex BLE interface.
 *
 * Source: rixrix/deskop-nano-cortex `docs/specs/110-backend-midi-ble/spec.md`
 * ("Known BLE UUIDs") and choldy/nano-cortex-web-editor. All provisional and
 * firmware-specific (verified against NanOS ~2.2.x).
 */

export const BLE_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Expand a 16-bit shortened UUID (e.g. 0xc305) to the full 128-bit form. */
export function shortUuid(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}${BLE_BASE_SUFFIX}`;
}

/** Primary Nano Cortex service (Nordic-style shortened UUID). */
export const SERVICE_A002 = shortUuid(0xa002);
/** Secondary service the web editor also probes for C304/C305. */
export const SERVICE_A003 = shortUuid(0xa003);
/** Bluetooth-SIG BLE-MIDI service (standard fallback). */
export const SERVICE_BLE_MIDI = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
/** Vendor-specific service observed as a fallback in the reference code. */
export const SERVICE_VENDOR = '00cb7a5b-bf06-470a-b9b8-1c5d2c7e7b00';

/** Every service we may need to touch; passed as `optionalServices`. */
export const ALL_SERVICE_UUIDS: readonly string[] = [
  SERVICE_A002,
  SERVICE_A003,
  SERVICE_BLE_MIDI,
  SERVICE_VENDOR,
];

/** MIDI bytes (PC/CC). write (with response). */
export const CHAR_C302 = shortUuid(0xc302);
/** MIDI bytes, write-without-response variant (the rixrix preset probe prefers this one). */
export const CHAR_C303 = shortUuid(0xc303);
/** Command/editor frames (dump requests, toggles). write. */
export const CHAR_C304 = shortUuid(0xc304);
/** Replies + device events. notify (primary). */
export const CHAR_C305 = shortUuid(0xc305);
/** Duplicate of c305. indicate. Subscribe and dedupe. */
export const CHAR_C306 = shortUuid(0xc306);

export type CharKey = 'c302' | 'c303' | 'c304' | 'c305' | 'c306';

export const CHAR_BY_KEY: Record<CharKey, string> = {
  c302: CHAR_C302,
  c303: CHAR_C303,
  c304: CHAR_C304,
  c305: CHAR_C305,
  c306: CHAR_C306,
};

/** Map a full characteristic UUID back to its short key, if it is one we know. */
export function charKeyOf(uuid: string): CharKey | null {
  const lower = uuid.toLowerCase();
  for (const [key, full] of Object.entries(CHAR_BY_KEY) as [CharKey, string][]) {
    if (full === lower) return key;
  }
  return null;
}

/** Device-name fragments used to recognise the Nano Cortex in a scan. */
export const NAME_FRAGMENTS = ['nano', 'cortex', 'neural'] as const;

export function looksLikeNano(name: string | null | undefined): boolean {
  const lower = (name ?? '').toLowerCase();
  return NAME_FRAGMENTS.some((f) => lower.includes(f));
}
