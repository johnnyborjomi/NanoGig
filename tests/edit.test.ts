import { describe, expect, it } from 'vitest';
import {
  CAB_PARAMS,
  FX_DEFS,
  FX_SLOT_MODELS,
  cabLoadFrame,
  irPreviewFrame,
  irPreviewStopFrame,
  cabMicFrame,
  cabNormalized,
  cabPhaseFrame,
  cabSelectFrame,
  cabSettingFrame,
  cabSettingsRequest,
  cabSlotLoadFrame,
  cabValue,
  captureSlotLoadFrame,
  capturePreviewFrame,
  capturePreviewStopFrame,
  captureSlotSelectFrame,
  captureVolumeDb,
  captureVolumeFrame,
  ampKnobFrame,
  decodeFxParamEvent,
  outputLevelFrame,
  ampKnobText,
  captureVolumeRaw,
  captureVolumeText,
  decodeCabSettings,
  decodeFxParams,
  decodeLibrary,
  decodeOk,
  decodePresetReply,
  footswitchAssignFrame,
  fxDef,
  fxModelFrame,
  fxModelId,
  fxModelType,
  fxParamFrame,
  fxParamText,
  fxParamsInOrder,
  fxParamsRequest,
  fxSlotModels,
  gateThresholdFrame,
  isPresetSaved,
  libraryRequest,
  presetCreateFrame,
  presetDeleteFrame,
  presetNameProblem,
  presetRenameFrame,
} from '../src/protocol/edit';
import { FX_MODELS } from '../src/protocol/models';
import { fromHex } from '../src/protocol/hex';
import { bytesField, fixed32FloatField, stringField, varintField } from '../src/protocol/proto';

const bytes = (...xs: (number | string)[]) =>
  Uint8Array.from(xs.flatMap((x) => (typeof x === 'string' ? Array.from(x, (c) => c.charCodeAt(0)) : [x])));
const f32 = (b: ArrayLike<number>, at: number) => new DataView(Uint8Array.from(b).buffer).getFloat32(at, true);

// Vectors from the NanoGig Screen firmware's test_protocol.c (byte-exact against Cortex Cloud captures).
describe('FX editing frames', () => {
  it('model, read and parameter writes', () => {
    expect(fxModelFrame('post2', 6010)).toEqual(bytes(0x09, 0xc0, 0x18, 0x03, 0x20, 0xfa, 0x2e, 0x88, 0x00, 0x00, 0x00));
    expect(() => fxModelFrame('pre1', 0)).toThrow();
    expect(fxParamsRequest('pre2')).toEqual(bytes(0x08, 0xc0, 0x08, 0x03, 0x18, 0x01, 0x89, 0x00, 0x00, 0x00));
    expect(fxParamFrame('post3', 2, 0.5)).toEqual(bytes(0x0f, 0xc0, 0x08, 0x01, 0x18, 0x04, 0x20, 0x02, 0x2d, 0x00, 0x00, 0x00, 0x3f, 0x63, 0x00, 0x00, 0x00));
    const clamped = fxParamFrame('post3', 2, 7);
    expect(clamped[11]).toBe(0x80);
    expect(clamped[12]).toBe(0x3f);
  });

  it('decodes the parameters reply', () => {
    const reply = bytes(0x08, 0x06, 0x22, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0x3f, 0, 0, 0x80, 0x3f);
    expect(decodeFxParams(reply)).toEqual([0, 0.5, 1]);
    expect(decodeFxParams(reply.subarray(0, 2))).toEqual([]);
  });

  it('model types meet the catalogue', () => {
    expect(fxModelType('FA2E')).toBe(6010);
    expect(fxModelType('12')).toBe(18);
    expect(fxModelType('C6BB01')).toBe(24006);
    expect(fxModelId(6010)).toBe('FA2E');
    expect(fxModelId(24006)).toBe('C6BB01');
    for (const id of FX_MODELS.keys()) {
      const def = fxDef(fxModelType(id));
      expect(def, id).not.toBeNull();
      for (const i of def!.order ?? []) expect(i).toBeLessThan(def!.params.length);
    }
    for (const slot of FX_SLOT_MODELS) for (const type of slot) expect(FX_MODELS.has(fxModelId(type)), String(type)).toBe(true);
    // Transpose loads in Pre 1 only (Neural DSP's device list), not Pre 2 as the editor's export has it.
    expect(FX_SLOT_MODELS[0]).toContain(18001);
    expect(FX_SLOT_MODELS[1]).not.toContain(18001);
    expect(FX_DEFS.length).toBe(53);
    expect(fxSlotModels('post2').map((m) => m.name)).toContain('Analog Delay');
    expect(fxSlotModels('pre1').map((m) => m.name)).not.toContain('Analog Delay');
  });

  it('formats parameters as the editor shows them', () => {
    const delay = fxDef(6010)!;
    const order = fxParamsInOrder(delay).map((p) => p.index);
    expect(order).toEqual([0, 1, 2, 3, 4, 10, 11, 5, 6, 7, 8, 9]);
    const gain = fxDef(18)!.params[0]!;
    expect(fxParamText(gain, 0.45)).toBe('4.5');
    const pickup = fxDef(22)!.params[2]!;
    expect(fxParamText(pickup, 1)).toBe('Single');
    expect(fxParamText(pickup, 0)).toBe('HB');
  });
});

describe('parameter events from the pedal (0x63)', () => {
  // The pedal's own reports, Dual Delay in post 2 with Link FBack on (2026-10-17).
  const body = (hex: string) => fromHex(hex).subarray(2, -4);
  it('a linked feedback: slot, parameter and value', () => {
    const ev = decodeFxParamEvent(body('0F C0 08 01 18 03 20 02 2D CB A1 85 3E 63 00 00 00'))!;
    expect(ev.slot).toBe('post2');
    expect(ev.param).toBe(2);
    expect(ev.value).toBeCloseTo(0.261, 4);
    expect(decodeFxParamEvent(body('0F C0 08 01 18 03 20 05 2D 00 00 80 3E 63 00 00 00'))).toEqual({ slot: 'post2', param: 5, value: 0.25 });
  });
  it('zero fields left out: pre 1, parameter 0, value 0', () => {
    expect(decodeFxParamEvent(body('06 C0 08 01 63 00 00 00'))).toEqual({ slot: 'pre1', param: 0, value: 0 });
  });
});

describe('capture volume and gate threshold', () => {
  it('frames', () => {
    expect(gateThresholdFrame(0x71)).toEqual(bytes(0x0a, 0xc0, 0x18, 0x0b, 0x20, 0x71, 0x28, 0x00, 0x1a, 0x00, 0x00, 0x00));
    expect(captureVolumeFrame(100)).toEqual(bytes(0x0a, 0xc0, 0x18, 0x0a, 0x20, 100, 0x28, 0x00, 0x1a, 0x00, 0x00, 0x00));
    // Two-byte varint from 128 up: 0B C0.
    expect(Array.from(captureVolumeFrame(200).subarray(0, 7))).toEqual([0x0b, 0xc0, 0x18, 0x0a, 0x20, 0xc8, 0x01]);
  });

  it('amp knobs and outputs 1/2 volume: the same frame with selectors 0..4, read 0..10', () => {
    expect(ampKnobFrame('gain', 0x71)).toEqual(bytes(0x0a, 0xc0, 0x18, 0x00, 0x20, 0x71, 0x28, 0x00, 0x1a, 0x00, 0x00, 0x00));
    expect(Array.from(outputLevelFrame(5).subarray(2, 6))).toEqual([0x18, 0x01, 0x20, 5]);
    expect(Array.from(ampKnobFrame('bass', 5).subarray(2, 4))).toEqual([0x18, 0x02]);
    expect(Array.from(ampKnobFrame('mid', 5).subarray(2, 4))).toEqual([0x18, 0x03]);
    expect(Array.from(ampKnobFrame('treble', 255).subarray(0, 7))).toEqual([0x0b, 0xc0, 0x18, 0x04, 0x20, 0xff, 0x01]);
    expect(ampKnobText(0)).toBe('0.0');
    expect(ampKnobText(128)).toBe('5.0');
    expect(ampKnobText(255)).toBe('10.0');
  });

  it('dB scale fits Cortex Cloud readouts', () => {
    expect(captureVolumeDb(0)).toBeCloseTo(-24, 3);
    expect(captureVolumeDb(255)).toBeCloseTo(12, 3);
    expect(captureVolumeText(39)).toBe('-12.0 dB');
    expect(captureVolumeText(102)).toBe('-2.9 dB');
    expect(captureVolumeText(128)).toBe('0.0 dB');
    expect(captureVolumeText(101)).toBe('-3.0 dB');
    expect(captureVolumeText(110)).toBe('-2.0 dB');
    expect(captureVolumeRaw(0)).toBe(128);
    expect(captureVolumeRaw(-30)).toBe(0);
    expect(captureVolumeRaw(20)).toBe(255);
  });
});

describe('IR settings', () => {
  it('frames', () => {
    expect(cabSettingsRequest(0, 1)).toEqual(bytes(0x08, 0xc0, 0x18, 0x00, 0x20, 0x00, 0x5f, 0x00, 0x00, 0x00));
    // Cortex Cloud on preset 50 (HCI snoop 2026-10-16).
    expect(cabSettingsRequest(49, 3)).toEqual(bytes(0x08, 0xc0, 0x18, 0x31, 0x20, 0x02, 0x5f, 0x00, 0x00, 0x00));
    expect(cabSettingsRequest(0, 6)[5]).toBe(5);
    expect(() => cabSettingsRequest(0, 0)).toThrow();
    expect(() => cabSettingsRequest(64, 1)).toThrow();
    const lvl = bytes(0x09, 0xc0, 0x2d, 0xc3, 0xaf, 0x17, 0x3f, 0x5e, 0x00, 0x00, 0x00);
    expect(cabSettingFrame('level', f32(lvl, 3))).toEqual(lvl);
    expect(cabSettingFrame('highPass', 0.5)[2]).toBe(0x35);
    expect(Array.from(cabSettingFrame('lowPass', 2).subarray(2, 7))).toEqual([0x3d, 0x00, 0x00, 0x80, 0x3f]);
    expect(cabPhaseFrame(true)).toEqual(bytes(0x06, 0xc0, 0x40, 0x01, 0x5e, 0x00, 0x00, 0x00));
    expect(cabSelectFrame(2)).toEqual(bytes(0x08, 0xc0, 0x18, 0x03, 0x20, 0x02, 0x1c, 0x00, 0x00, 0x00));
    expect(cabSelectFrame(0)[5]).toBe(0);
    expect(cabLoadFrame('factory', 6, 'A')).toEqual(bytes(0x0b, 0xc0, 0x1a, 0x05, 0x08, 0x06, 0x12, 0x01, 'A', 0x5e, 0x00, 0x00, 0x00));
    const user = cabLoadFrame('user', 7, 'A');
    expect([user[2], user[5]]).toEqual([0x22, 7]);
    const mic = cabMicFrame(1, 'Name', 0, 'Mic');
    expect(Array.from(mic.subarray(2, 4))).toEqual([0x1a, 15]);
    expect(Array.from(mic.subarray(mic.length - 4))).toEqual([0x5e, 0, 0, 0]);
  });

  it('scales against Cortex Cloud readouts', () => {
    expect(Math.abs(cabValue('level', 0.66212219))).toBeLessThan(0.005);
    expect(cabValue('level', 0)).toBe(-96);
    expect(cabValue('level', 0.654951)).toBeCloseTo(-0.3, 1);
    expect(cabValue('highPass', 0.220842)).toBeCloseTo(83, 0);
    expect(Math.abs(cabValue('lowPass', 0.59537) - 9006)).toBeLessThan(1);
    expect(cabValue('lowPass', 1)).toBe(20000);
    for (const n of [0.001, 0.2, 0.5, 0.8, 0.999]) for (const p of CAB_PARAMS) expect(cabNormalized(p, cabValue(p, n))).toBeCloseTo(n, 4);
    expect(cabNormalized('level', -200)).toBe(0);
    expect(cabNormalized('lowPass', 30000)).toBe(1);
  });

  it('decodes the settings reply', () => {
    const payload = Uint8Array.from([
      ...varintField(1, 6),
      ...bytesField(5, [...varintField(1, 3), ...stringField(2, '4x12 V30'), ...varintField(3, 2), ...stringField(4, 'Dynamic 57')]),
      ...stringField(7, 'Dynamic 57'),
      ...stringField(7, 'Ribbon 160'),
      ...bytesField(8, [...fixed32FloatField(1, 0.5), ...fixed32FloatField(3, 0.25), ...varintField(4, 1)]),
    ]);
    const cs = decodeCabSettings(payload)!;
    expect(cs).toMatchObject({ factory: true, kind: 3, irName: '4x12 V30', position: 2, mic: 'Dynamic 57', mics: ['Dynamic 57', 'Ribbon 160'], phaseInverted: true, level: 0.5, highPass: 0, lowPass: 0.25 });
    expect(decodeCabSettings(Uint8Array.from(varintField(1, 6)))).toBeNull();
    expect(decodeCabSettings(bytes(0x22, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x41, 0x42))).toBeNull();
  });
});

describe('library', () => {
  it('requests', () => {
    expect(libraryRequest(['captures', 'irs'])).toEqual(bytes(0x0c, 0xc0, 0x18, 0x01, 0x20, 0x01, 0x28, 0x01, 0x30, 0x01, 0x4c, 0x00, 0x00, 0x00));
    expect(libraryRequest(['irs'])).toEqual(bytes(0x08, 0xc0, 0x20, 0x01, 0x30, 0x01, 0x4c, 0x00, 0x00, 0x00));
    expect(libraryRequest(['captures'])).toEqual(bytes(0x08, 0xc0, 0x18, 0x01, 0x28, 0x01, 0x4c, 0x00, 0x00, 0x00));
    expect(() => libraryRequest([])).toThrow();
  });

  it('decodes factory first, each list indexed on its own', () => {
    const lib = decodeLibrary(bytes(0x1a, 0x03, 0x12, 0x01, 'C', 0x32, 0x02, 'U', '0', 0x22, 0x02, 'F', '0', 0x32, 0x02, 'U', '1', 0x22, 0x00));
    expect(lib.irs).toEqual([
      { list: 'factory', index: 0, name: 'F0' },
      { list: 'factory', index: 1, name: '' },
      { list: 'user', index: 0, name: 'U0' },
      { list: 'user', index: 1, name: 'U1' },
    ]);
    expect(lib.captures).toEqual([{ list: 'factory', index: 0, name: 'C' }]);
    expect(decodeLibrary(bytes(0x1a, 0x03, 0x12, 0x01, 'C')).irs).toBeNull();
  });

  it('preview and use frames', () => {
    const item = { list: 'factory' as const, index: 5, name: 'Comet 60 6' };
    expect(capturePreviewFrame(item)).toEqual(bytes(0x16, 0xc0, 0x1a, 0x0e, 0x08, 0x05, 0x12, 0x0a, 'Comet 60 6', 0x40, 0x01, 0x96, 0x00, 0x00, 0x00));
    expect(capturePreviewFrame({ ...item, list: 'user' })[2]).toBe(0x22);
    // Cortex Cloud's stop, byte-exact (HCI snoop 2026-10-11 22:14:00.562 UTC).
    expect(capturePreviewStopFrame(1791756840562)).toEqual(bytes(0x0d, 0xc0, 0x10, 0xf2, 0xdc, 0x9e, 0xe8, 0x92, 0x34, 0x18, 0x00, 0x94, 0x00, 0x00, 0x00));
    expect(captureSlotLoadFrame(4, item)).toEqual(bytes(0x16, 0xc0, 0x18, 0x04, 0x22, 0x0e, 0x08, 0x05, 0x12, 0x0a, 'Comet 60 6', 0x50, 0x00, 0x00, 0x00));
    expect(() => captureSlotLoadFrame(25, item)).toThrow();
    expect(cabSlotLoadFrame(3, { list: 'user', index: 23, name: 'YA' })).toEqual(bytes(0x0e, 0xc0, 0x18, 0x03, 0x2a, 0x06, 0x08, 0x17, 0x12, 0x02, 'YA', 0x4e, 0x00, 0x00, 0x00));
    // Cortex Cloud's IR preview, its stop and a load into the preset's own IR slot (index 5), byte-exact (snoop 2026-10-11 10:54).
    expect(irPreviewFrame({ list: 'user', index: 2, name: 'Holy Grail C800 Pz1' })).toEqual(
      bytes(0x1f, 0xc0, 0x22, 0x17, 0x08, 0x02, 0x12, 0x13, 'Holy Grail C800 Pz1', 0x40, 0x01, 0x9e, 0x00, 0x00, 0x00),
    );
    expect(irPreviewStopFrame(1791629681621)).toEqual(bytes(0x0d, 0xc0, 0x10, 0xd5, 0xc7, 0xcd, 0xab, 0x92, 0x34, 0x20, 0x00, 0x94, 0x00, 0x00, 0x00));
    expect(cabSlotLoadFrame(5, { list: 'user', index: 37, name: 'YA VX30 212 BLU Mix BMAY' })).toEqual(
      bytes(0x24, 0xc0, 0x18, 0x05, 0x2a, 0x1c, 0x08, 0x25, 0x12, 0x18, 'YA VX30 212 BLU Mix BMAY', 0x4e, 0x00, 0x00, 0x00),
    );
    expect(() => cabSlotLoadFrame(6, { list: 'user', index: 1, name: 'YA' })).toThrow();
    expect(captureSlotSelectFrame(5)).toEqual(bytes(0x08, 0xc0, 0x18, 0x01, 0x20, 0x05, 0x1c, 0x00, 0x00, 0x00));
    expect(decodeOk(bytes(0x08, 0x06, 0x18, 0x01))).toBe(true);
    expect(decodeOk(bytes(0x08, 0x06))).toBe(false);
  });
});

describe('presets', () => {
  it('rename', () => {
    expect(presetRenameFrame(44, 'Gojira T')).toEqual(bytes(0x12, 0xc0, 0x08, 0x01, 0x18, 0x2c, 0x22, 0x08, 'Gojira T', 0x6f, 0x00, 0x00, 0x00));
    expect(() => presetRenameFrame(44, '')).toThrow();
    expect(() => presetRenameFrame(64, 'Name')).toThrow();
    expect(() => presetRenameFrame(0, '12345678901234567890123456789012')).toThrow();
    expect(presetRenameFrame(0, '1234567890123456789012345678901').length).toBe(43);
  });

  it('replies', () => {
    expect(decodePresetReply(bytes(0x08, 0x06, 0x18, 0x2c, 0x20, 0x01))).toEqual({ preset: 44, ok: true });
    expect(decodePresetReply(bytes(0x08, 0x06, 0x18, 0x2c))).toEqual({ preset: 44, ok: false });
    expect(decodePresetReply(bytes(0x08, 0x06, 0x20, 0x01))).toEqual({ preset: 0, ok: true });
    expect(decodePresetReply(bytes(0x08, 0x06, 0x18, 0xc8, 0x01, 0x20, 0x01))).toBeNull();
    expect(isPresetSaved(bytes(0x08, 0x01, 0x18, 0x02))).toBe(true);
    expect(isPresetSaved(bytes(0x08, 0x01))).toBe(false);
  });

  it('delete, create and footswitch', () => {
    expect(presetDeleteFrame(0x31)).toEqual(bytes(0x08, 0xc0, 0x08, 0x02, 0x18, 0x31, 0x32, 0x00, 0x00, 0x00));
    expect(presetCreateFrame(0x31, 'Hdhd')).toEqual(bytes(0x0e, 0xc0, 0x08, 0x01, 0x18, 0x31, 0x2a, 0x04, 'Hdhd', 0x03, 0x00, 0x00, 0x00));
    const m1 = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    expect(footswitchAssignFrame(0x31, 'iia')).toEqual(
      bytes(0x36, 0xc0, 0x18, 0x00, 0x20, ...m1, 0x28, ...m1, 0x30, ...m1, 0x38, 0x31, 0x40, ...m1, 0x48, 0x02, 0x1d, 0x00, 0x00, 0x00),
    );
  });

  it("keeps the name rules", () => {
    const names = ['Clean', 'Crunch', ''];
    expect(presetNameProblem('Lead', 2, names)).toBeNull();
    expect(presetNameProblem('abc', 2, names)).toMatch(/4/);
    expect(presetNameProblem('crunch', 2, names)).toMatch(/Preset 2/);
    expect(presetNameProblem('Crunch', 1, names)).toBeNull();
    expect(presetNameProblem(' Lead', 2, names)).toMatch(/spaces/);
    expect(presetNameProblem('x'.repeat(32), 2, names)).toMatch(/31/);
  });
});
