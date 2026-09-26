/**
 * Captured and synthetic payloads used by the mock transport and the tests.
 *
 * REAL_STATE_DUMP_HEX is a genuine `c305` current-state dump captured from a
 * Nano Cortex on firmware 2.2.1, reproduced from rixrix/deskop-nano-cortex
 * `backend/src/infrastructure/midi/ble_schema.rs` (Apache-2.0). Known decode
 * (from that project's unit test):
 *   gain 127, level 144, bass 129, mid 127, treble 113, capture slot 2,
 *   capture volume 127, gate ON, cab/IR OFF, firmware "2.2.1",
 *   capture "NoMatch Chief 1", IR "110 US PRN C10R",
 *   bypass [1,1,0,0,0] (pre1/pre2 bypassed, post1..3 on),
 *   model ids D18C01 / 1B / F336 / FA2E / CB3E, footswitch IA=3 IB=7 IIA=10 IIB=16.
 *
 * The metadata dump in this file is SYNTHETIC (no public capture exists) but
 * follows the documented record shapes exactly.
 */
import { fromHex } from '../protocol/hex';
import { bytesField, stringField, varintField, fixed32FloatField, varintFieldOpt } from '../protocol/proto';
import { FX_SLOTS, type FxSlot } from '../protocol/frames';
import { MSG, encodeFrameHeader, frameSingle } from '../protocol/reassembly';

export const REAL_STATE_DUMP_HEX =
  'E6 C1 08 01 18 7F 20 90 01 28 81 01 30 7F 38 71 40 7A 48 02 50 03 58 02 68 07 70 03 78 07 ' +
  'C2 01 05 32 2E 32 2E 31 CA 01 08 30 35 63 33 36 36 32 31 D0 01 19 D8 01 0A E0 01 01 F0 01 01 ' +
  'FA 01 05 01 01 00 00 00 82 02 55 08 01 12 0F 4E 6F 4D 61 74 63 68 20 43 68 69 65 66 20 31 ' +
  '1A 40 64 34 38 62 34 33 31 36 64 62 63 63 37 36 34 62 34 62 34 62 33 66 36 33 34 64 38 38 37 ' +
  '38 61 62 36 36 63 39 36 36 38 38 33 64 34 38 30 66 39 32 36 34 38 38 32 35 66 39 63 61 33 61 ' +
  '30 30 33 30 8A 02 31 08 01 12 0F 31 31 30 20 55 53 20 50 52 4E 20 43 31 30 52 1A 1C 31 31 30 ' +
  '20 55 53 20 50 52 4E 20 43 31 30 52 2F 52 69 62 62 6F 6E 20 31 36 30 2F 32 92 02 9C 01 0A 40 ' +
  '64 34 38 62 34 33 31 36 64 62 63 63 37 36 34 62 34 62 34 62 33 66 36 33 34 64 38 38 37 38 61 ' +
  '62 36 36 63 39 36 36 38 38 33 64 34 38 30 66 39 32 36 34 38 38 32 35 66 39 63 61 33 61 30 30 ' +
  '33 30 12 0F 4E 6F 4D 61 74 63 68 20 43 68 69 65 66 20 31 22 16 0A 09 4E 65 75 72 61 6C 44 53 ' +
  '50 12 09 4E 65 75 72 61 6C 44 53 50 32 08 61 6D 70 5F 68 65 61 64 3A 09 4D 61 74 63 68 6C 65 ' +
  '73 73 3A 09 43 68 69 65 66 74 61 69 6E 40 06 52 06 67 75 69 74 61 72 58 01 62 01 31 68 00 9A ' +
  '02 31 0A 0F 31 31 30 20 55 53 20 50 52 4E 20 43 31 30 52 12 00 1A 1C 31 31 30 20 55 53 20 50 ' +
  '52 4E 20 43 31 30 52 2F 52 69 62 62 6F 6E 20 31 36 30 2F 32 A8 02 01 B0 02 0A B8 02 10 C0 02 ' +
  '01 C8 02 01 D0 02 90 01 E0 02 7F F5 02 00 00 DC 43 80 03 D1 8C 01 88 03 1B 90 03 F3 36 98 03 ' +
  'FA 2E A0 03 CB 3E AD 03 CD CC CC 3D C5 03 00 00 F0 42 F8 03 01 02 00 00 00';

/** The full 488-byte notification packet: header `E6 C1` (486 + START + END) + protobuf body + `02 00 00 00` trailer. */
export const REAL_STATE_DUMP_PACKET: Uint8Array = fromHex(REAL_STATE_DUMP_HEX);

/** Real hardware-captured live events (rixrix protocolLabDecoder fixtures). */
export const REAL_EVENTS = {
  /** Expression pedal heel / center / toe. */
  expressionHeel: fromHex('08 C0 08 01 18 02 40 00 00 00'),
  expressionCenter: fromHex('0B C0 08 01 18 02 20 80 01 40 00 00 00'),
  expressionToe: fromHex('0B C0 08 01 18 02 20 FF 01 40 00 00 00'),
  /** Amp gain knob = 143. */
  gainKnob: fromHex('0B C0 08 01 20 8F 01 30 01 1A 00 00 00'),
  /** Footswitch I encoder click. */
  encoderI: fromHex('0A C0 08 01 18 01 20 03 1C 00 00 00'),
  /** Footswitch preset select: preset 0 with assignments IA=0 IB=1 IIA=2 IIB=3. */
  footswitchSelectPreset0: fromHex('C0 08 01 20 00 28 00 30 01 38 02 40 03'),
};

// ---------------------------------------------------------------------------
// Synthetic builders
// ---------------------------------------------------------------------------

export interface MockPreset {
  name: string;
  captureName: string;
  irShortName: string;
  irFullName?: string;
}

export const DEMO_PRESETS: MockPreset[] = [
  { name: 'Fuzz Face Melter', captureName: 'Brit 1959 Crunch', irShortName: '412 UK GRN V30' },
  { name: 'Edge of Breakup', captureName: 'NoMatch Chief 1', irShortName: '212 UK GRN V30' },
  { name: 'Plexi Crunch', captureName: 'Brit 1959 Crunch', irShortName: '412 UK GRN V30' },
  { name: 'Lead Boost', captureName: 'Brit 1959 Crunch', irShortName: '412 UK GRN V30' },
  { name: 'Rectified', captureName: 'Cali Recto Modern', irShortName: '412 US OS V30' },
  { name: 'Ambient Swell', captureName: 'Jazz 120 Clean', irShortName: '212 US JAZ' },
  { name: 'Slapback Twang', captureName: 'Tweed 57 Deluxe', irShortName: '112 US TWD P12Q' },
  { name: 'Clean Chief', captureName: 'NoMatch Chief 1', irShortName: '110 US PRN C10R' },
  { name: 'B1 Worship Clean', captureName: 'Jazz 120 Clean', irShortName: '212 US JAZ' },
  { name: '', captureName: '', irShortName: '' },
  { name: 'Djent 8 String', captureName: 'Cali Recto Modern', irShortName: '412 US OS V30' },
];

export interface MockDeviceState {
  activePreset: number;
  fxOn: Record<FxSlot, boolean>;
  gateOn: boolean;
  cabOn: boolean;
  captureOn: boolean;
  amp: { gain: number; level: number; bass: number; mid: number; treble: number };
  captureSlot: number;
  captureVolumeRaw: number;
  firmware: string;
  /** Global "Mute Outputs 1/2" switch (not part of the state dump). */
  outputsMuted: boolean;
}

export function defaultMockDeviceState(): MockDeviceState {
  return {
    activePreset: 7, // matches field 13 of the real dump
    fxOn: { pre1: false, pre2: false, post1: true, post2: true, post3: true },
    gateOn: true,
    cabOn: false,
    captureOn: true,
    amp: { gain: 127, level: 144, bass: 129, mid: 127, treble: 113 },
    captureSlot: 2,
    captureVolumeRaw: 127,
    firmware: '2.2.1',
    outputsMuted: false,
  };
}

const MODEL_IDS: Record<FxSlot, number[]> = {
  pre1: [0xd1, 0x8c, 0x01],
  pre2: [0x1b],
  post1: [0xf3, 0x36],
  post2: [0xfa, 0x2e],
  post3: [0xcb, 0x3e],
};

/** Build a current-state dump BODY (no packet header) from a mock device state. */
export function buildCurrentStateBody(state: MockDeviceState, preset: MockPreset): Uint8Array {
  const body: number[] = [];
  body.push(...varintField(1, 1));
  body.push(...varintField(3, state.amp.gain));
  body.push(...varintField(4, state.amp.level));
  body.push(...varintField(5, state.amp.bass));
  body.push(...varintField(6, state.amp.mid));
  body.push(...varintField(7, state.amp.treble));
  body.push(...varintField(11, state.captureOn ? state.captureSlot : 0));
  if (state.cabOn) body.push(...varintField(12, 1));
  body.push(...varintFieldOpt(13, state.activePreset)); // absent on preset 1, like the pedal
  body.push(...varintField(14, 3), ...varintField(15, 7));
  body.push(...stringField(24, state.firmware));
  body.push(...bytesField(31, FX_SLOTS.map((s) => (state.fxOn[s] ? 0x00 : 0x01))));
  body.push(
    ...bytesField(32, [
      ...varintField(1, state.captureOn ? 1 : 0),
      ...stringField(2, preset.captureName || 'Capture 1'),
      ...stringField(3, 'd48b4316dbcc764b4b4b3f634d8878ab66c966883d480f92648825f9ca3a0030'),
    ]),
  );
  body.push(
    ...bytesField(33, [
      ...varintField(1, 1),
      ...stringField(2, preset.irShortName || 'IR 1'),
      ...stringField(3, preset.irFullName ?? `${preset.irShortName || 'IR 1'}/Ribbon 160/2`),
    ]),
  );
  body.push(...varintField(38, 10), ...varintField(39, 16));
  body.push(...varintField(44, state.captureVolumeRaw));
  for (const slot of FX_SLOTS) body.push(...bytesField(48 + FX_SLOTS.indexOf(slot), MODEL_IDS[slot]));
  body.push(...fixed32FloatField(53, (50 + 108) / 255));
  if (!state.gateOn) body.push(...varintField(54, 1));
  body.push(MSG.DUMP, 0x00, 0x00, 0x00); // trailer
  return Uint8Array.from(body);
}

/** Wrap a body as a single complete frame (START+END), e.g. `E6 C1 …`. */
export function wrapSinglePacket(body: Uint8Array): Uint8Array {
  return frameSingle(body);
}

/**
 * Split a body into a multi-packet message using the real framing: first
 * packet carries START, last carries END, headers encode each body length.
 */
export function segmentStream(body: Uint8Array, chunk = 510): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < body.length; i += chunk) {
    const part = body.subarray(i, i + chunk);
    const last = i + chunk >= body.length;
    out.push(Uint8Array.from([...encodeFrameHeader(part.length, i === 0, last), ...part]));
  }
  return out;
}

/** Build a synthetic metadata message body: field 17 captures, 18 presets, 19 IRs. */
export function buildMetadataBody(presets: MockPreset[], state?: MockDeviceState): Uint8Array {
  const body: number[] = [];
  if (state) {
    const st = buildCurrentStateBody(state, presets[state.activePreset] ?? { name: '', captureName: '', irShortName: '' });
    body.push(...st.subarray(0, st.length - 4)); // state fields without the trailer
  }
  const captures = [...new Set(presets.map((p) => p.captureName).filter(Boolean))];
  captures.forEach((name, i) => {
    body.push(...bytesField(17, [...stringField(1, `cap-${i.toString(16).padStart(12, '0')}`), ...stringField(2, name)]));
  });
  for (let i = 0; i < 64; i++) {
    const p = presets[i] ?? { name: '', captureName: '', irShortName: '' };
    body.push(
      ...bytesField(18, [
        ...stringField(1, p.name),
        ...stringField(7, p.captureName),
        ...stringField(8, p.captureName ? 'd48b4316dbcc764b4b4b3f634d8878ab' : ''),
        ...stringField(9, p.irShortName),
        ...stringField(10, p.irFullName ?? (p.irShortName ? `${p.irShortName}/Ribbon 160/2` : '')),
      ]),
    );
  }
  const irs = [...new Set(presets.map((p) => p.irShortName).filter(Boolean))].slice(0, 5);
  irs.forEach((name) => body.push(...bytesField(19, [...stringField(1, name), ...stringField(3, `${name}/Ribbon 160/2`)])));
  body.push(MSG.DUMP, 0x00, 0x00, 0x00);
  return Uint8Array.from(body);
}

/**
 * Tuner pitch event in the hardware-observed shape (2026-09-19):
 * `10 C0 08 01 22 01 <note> 2D <f32 cents> 30 01 [38 01] 80 00 00 00`.
 */
export function buildTunerPitchEvent(note: string, cents: number, inTune = Math.abs(cents) < 2): Uint8Array {
  const body = [
    ...varintField(1, 1),
    ...stringField(4, note),
    ...fixed32FloatField(5, cents),
    ...varintField(6, 1),
    ...(inTune ? varintField(7, 1) : []),
    MSG.TUNER_PITCH, 0x00, 0x00, 0x00,
  ];
  return wrapSinglePacket(Uint8Array.from(body));
}

/** Expression position event (2026-09-19): `0B C0 08 01 18 02 20 <pos> 40 00 00 00`, field 4 absent at heel. */
export function buildExpressionPositionEvent(position: number): Uint8Array {
  const body = [...varintField(1, 1), ...varintField(3, 2), ...(position > 0 ? varintField(4, position) : []), MSG.EXPRESSION, 0x00, 0x00, 0x00];
  return wrapSinglePacket(Uint8Array.from(body));
}

/** Expression values event (2026-09-19): FX amounts at fields 9–13 (pre 1 … post 3), confirmed by the "assign everything" capture. */
export function buildExpressionValuesEvent(values: Partial<Record<FxSlot, number>>): Uint8Array {
  const fieldOf: Record<FxSlot, number> = { pre1: 9, pre2: 10, post1: 11, post2: 12, post3: 13 };
  const body = [...varintField(1, 1)];
  for (const slot of FX_SLOTS) {
    const v = values[slot];
    if (v !== undefined) body.push(...varintField(fieldOf[slot], v));
  }
  body.push(MSG.EXPRESSION_VALUES, 0x00, 0x00, 0x00);
  return wrapSinglePacket(Uint8Array.from(body));
}

/** Preset-changed event in the hardware-observed shape: `10 C0 08 01 20 <p> 28 <IA> 30 <IB> 38 <IIA> 40 <IIB> 1D 00 00 00`. */
export function buildPresetChangedEvent(preset: number, a = { ia: 3, ib: 5, iia: 20, iib: 14 }): Uint8Array {
  const body = [
    ...varintField(1, 1),
    ...varintFieldOpt(4, preset), // absent for preset 1, like the pedal (zero-valued fields are omitted)
    ...varintFieldOpt(5, a.ia),
    ...varintFieldOpt(6, a.ib),
    ...varintFieldOpt(7, a.iia),
    ...varintFieldOpt(8, a.iib),
    MSG.PRESET_CHANGED, 0x00, 0x00, 0x00,
  ];
  return frameSingle(body);
}

/** Legacy header-less footswitch shape from the rixrix fixtures (kept for decoder compatibility). */
export function buildFootswitchSelectEvent(preset: number, a = { ia: 3, ib: 7, iia: 10, iib: 16 }): Uint8Array {
  return Uint8Array.from([0xc0, 0x08, 0x01, 0x20, preset, 0x28, a.ia, 0x30, a.ib, 0x38, a.iia, 0x40, a.iib]);
}
