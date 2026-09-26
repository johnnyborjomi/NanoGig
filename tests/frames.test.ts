import { describe, expect, it } from 'vitest';
import {
  CURRENT_STATE_REQUEST,
  DEVICE_SETTINGS_REQUEST,
  FX_ENABLE_SLOT,
  GATE_ENABLE_SLOT,
  METADATA_DUMP_REQUEST,
  MIDI_STRATEGIES,
  PRESET_CHANGE_ACK,
  PRESET_NAME_MAX_LENGTH,
  bleMidiFrame,
  cabIrSlotFrame,
  captureBypassFrame,
  captureSelectFrame,
  presetLabelParts,
  fxBlockBypassFrame,
  midiStrategyById,
  gateBypassFrame,
  outputsMuteFrame,
  presetLabel,
  presetSelectFrame,
  programChange,
  tunerOnFrame,
  TUNER_OFF,
  tempoExitFrame,
  tempoSetFrame,
  expressionAssignmentsRequest,
} from '../src/protocol/frames';
import { toHex } from '../src/protocol/hex';
import { HW_DEVICE_SETTINGS_REQUEST, HW_OUTPUTS_MUTE_WRITES } from '../src/fixtures/hardware-2026-09-15';
import { HW_EXP_ASSIGN_REQUEST_58, HW_PRESET_SELECT_0, HW_PRESET_SELECT_9, HW_TUNER_OFF, HW_TUNER_ON_440, HW_TUNER_ON_440_MUTED, HW_TUNER_ON_462 } from '../src/fixtures/hardware-2026-09-19';
import { HW_TAP_TEMPO_EXIT_99, HW_TEMPO_SET_99 } from '../src/fixtures/hardware-2026-09-26';

describe('request frames (byte-exact against the reference tables)', () => {
  it('metadata dump request', () => {
    expect(toHex(METADATA_DUMP_REQUEST)).toBe('06 C0 08 03 01 00 00 00');
  });
  it('current-preset-state dump request', () => {
    expect(toHex(CURRENT_STATE_REQUEST)).toBe('0C C0 08 03 18 01 20 01 28 01 01 00 00 00');
  });
  it('preset-change acknowledgement', () => {
    expect(toHex(PRESET_CHANGE_ACK)).toBe('06 C0 20 01 1E 00 00 00');
  });
  it('device-settings request matches the Cortex Cloud capture', () => {
    expect(toHex(DEVICE_SETTINGS_REQUEST)).toBe('06 C0 08 03 41 00 00 00');
    expect(toHex(DEVICE_SETTINGS_REQUEST)).toBe(toHex(HW_DEVICE_SETTINGS_REQUEST));
  });
  it('frames follow the length-prefix convention byte[0] = length - 2', () => {
    for (const f of [METADATA_DUMP_REQUEST, CURRENT_STATE_REQUEST, PRESET_CHANGE_ACK, DEVICE_SETTINGS_REQUEST, outputsMuteFrame(true)]) {
      expect(f[0]).toBe(f.length - 2);
      expect(f[1]).toBe(0xc0);
    }
  });
});

describe('FX block bypass frames', () => {
  it('uses enable slots pre1=4 … post3=8 and gate=9', () => {
    expect(FX_ENABLE_SLOT).toEqual({ pre1: 4, pre2: 5, post1: 6, post2: 7, post3: 8 });
    expect(GATE_ENABLE_SLOT).toBe(9);
  });
  it('pre1 ON / OFF', () => {
    expect(toHex(fxBlockBypassFrame('pre1', true))).toBe('0A C0 08 01 18 04 20 00 1F 00 00 00');
    expect(toHex(fxBlockBypassFrame('pre1', false))).toBe('0A C0 08 01 18 04 20 01 1F 00 00 00');
  });
  it('post3 OFF', () => {
    expect(toHex(fxBlockBypassFrame('post3', false))).toBe('0A C0 08 01 18 08 20 01 1F 00 00 00');
  });
  it('gate ON / OFF', () => {
    expect(toHex(gateBypassFrame(true))).toBe('0A C0 08 01 18 09 20 00 1F 00 00 00');
    expect(toHex(gateBypassFrame(false))).toBe('0A C0 08 01 18 09 20 01 1F 00 00 00');
  });
});

describe('capture / cab-IR slot frames (web editor selectCaptureSlot / setCapture / selectCabIRSlot)', () => {
  it('capture bypass and select', () => {
    expect(toHex(captureBypassFrame())).toBe('08 C0 18 01 20 00 1C 00 00 00');
    expect(toHex(captureSelectFrame(1))).toBe('08 C0 18 04 20 00 1C 00 00 00');
    expect(toHex(captureSelectFrame(25))).toBe('08 C0 18 04 20 18 1C 00 00 00');
    expect(() => captureSelectFrame(0)).toThrow(RangeError);
    expect(() => captureSelectFrame(26)).toThrow(RangeError);
  });
  it('cab/IR slot: 0 bypasses, 1..5 selects', () => {
    expect(toHex(cabIrSlotFrame(0))).toBe('08 C0 18 03 20 00 1C 00 00 00');
    expect(toHex(cabIrSlotFrame(3))).toBe('08 C0 18 03 20 03 1C 00 00 00');
    expect(() => cabIrSlotFrame(6)).toThrow(RangeError);
  });
});

describe('tempo frames (found by trial on the pedal 2026-09-26)', () => {
  it('tempo set is the per-tap shape with the BPM as a float', () => {
    expect(toHex(tempoSetFrame(99))).toBe(toHex(HW_TEMPO_SET_99));
    expect(tempoSetFrame(99)[0]).toBe(tempoSetFrame(99).length - 2);
  });
  it('tap mode exit is the pedal\'s exit shape', () => {
    expect(toHex(tempoExitFrame(99))).toBe(toHex(HW_TAP_TEMPO_EXIT_99));
  });
  it('rejects tempos outside 40..300', () => {
    expect(() => tempoSetFrame(10)).toThrow(RangeError);
    expect(() => tempoExitFrame(1000)).toThrow(RangeError);
  });
});

describe('MIDI program change', () => {
  it('encodes zero-based preset on channel 1', () => {
    expect(toHex(programChange(0))).toBe('C0 00');
    expect(toHex(programChange(63))).toBe('C0 3F');
    expect(toHex(programChange(9, 2))).toBe('C1 09');
  });
  it('rejects out-of-range presets and channels', () => {
    expect(() => programChange(64)).toThrow(RangeError);
    expect(() => programChange(-1)).toThrow(RangeError);
    expect(() => programChange(0, 17)).toThrow(RangeError);
  });
});

describe('presetLabel', () => {
  it('defaults to the Mvave Chocolate layout: 4 per bank, bank number + preset letter', () => {
    expect(presetLabel(0)).toBe('1A');
    expect(presetLabel(1)).toBe('1B');
    expect(presetLabel(4)).toBe('2A');
    expect(presetLabel(9)).toBe('3B');
    expect(presetLabel(63)).toBe('16D');
    expect(presetLabel(64)).toBe('—');
  });
  it('supports the Nano Cortex A–H layout', () => {
    const nano = { presetsPerBank: 8, style: 'letter-number' as const };
    expect(presetLabel(0, nano)).toBe('A1');
    expect(presetLabel(7, nano)).toBe('A8');
    expect(presetLabel(8, nano)).toBe('B1');
    expect(presetLabel(9, nano)).toBe('B2');
    expect(presetLabel(63, nano)).toBe('H8');
  });
  it('exposes the two figures separately for colouring', () => {
    expect(presetLabelParts(9)).toEqual({ bank: '3', slot: 'B', slotIndex: 1 });
    expect(presetLabelParts(9, { presetsPerBank: 8, style: 'letter-number' })).toEqual({ bank: 'B', slot: '2', slotIndex: 1 });
    expect(presetLabelParts(64)).toBeNull();
    expect(PRESET_NAME_MAX_LENGTH).toBe(20);
  });
  it('handles other bank sizes and falls back on invalid ones', () => {
    expect(presetLabel(9, { presetsPerBank: 4, style: 'letter-number' })).toBe('C2');
    expect(presetLabel(63, { presetsPerBank: 2, style: 'letter-number' })).toBe('AF2'); // letters continue past Z
    expect(presetLabel(5, { presetsPerBank: 0 })).toBe('2B'); // invalid size falls back to 4
  });
});

describe('MIDI delivery strategies', () => {
  it('BLE-MIDI framing is the rixrix probe shape: 80 80 <status> <program>', () => {
    expect(toHex(bleMidiFrame(programChange(15)))).toBe('80 80 C0 0F');
  });
  it('lists the c304 select first, then Web MIDI, then the BLE variants from the rixrix probe, raw c302 last', () => {
    expect(MIDI_STRATEGIES.map((s) => s.id)).toEqual(['c304-select', 'web-midi', 'c303-ble-midi', 'c302-ble-midi', 'c303-raw', 'c303-sequential', 'c302-raw']);
    expect(midiStrategyById('c304-select')).toEqual({ id: 'c304-select', char: 'c304', framing: 'select' });
    expect(midiStrategyById('c302-raw')).toEqual({ id: 'c302-raw', char: 'c302', framing: 'raw' });
    expect(midiStrategyById('nope')).toBeNull();
  });
});

describe('preset select frame (Cortex Cloud HCI capture 2026-09-19)', () => {
  it('is byte-identical to the captured writes for presets 0 and 9', () => {
    expect(toHex(presetSelectFrame(0))).toBe(toHex(HW_PRESET_SELECT_0));
    expect(toHex(presetSelectFrame(9))).toBe(toHex(HW_PRESET_SELECT_9));
  });
  it('is a type-0x1D message (54-byte body) with the index in field 4 and -1 in the four footswitch fields', () => {
    const f = presetSelectFrame(63);
    expect(f).toHaveLength(56);
    expect(f[0]).toBe(0x36); // 14-bit length 54 = body + trailer, START|END
    expect(Array.from(f.slice(2, 6))).toEqual([0x18, 0x00, 0x20, 63]);
    for (const tag of [0x28, 0x30, 0x38, 0x40]) {
      const at = f.indexOf(tag);
      expect(toHex(f.slice(at + 1, at + 11))).toBe('FF FF FF FF FF FF FF FF FF 01');
    }
    expect(toHex(f.slice(50))).toBe('48 04 1D 00 00 00');
  });
  it('rejects indices outside 0..63', () => {
    expect(() => presetSelectFrame(64)).toThrow(RangeError);
    expect(() => presetSelectFrame(-1)).toThrow(RangeError);
  });
});

describe('tuner frames (Cortex Cloud HCI capture 2026-09-19)', () => {
  it('tuner on is byte-identical to the captured writes: 440 Hz, 440 Hz muted, 462 Hz', () => {
    expect(toHex(tunerOnFrame())).toBe(toHex(HW_TUNER_ON_440));
    expect(toHex(tunerOnFrame(440, true))).toBe(toHex(HW_TUNER_ON_440_MUTED));
    expect(toHex(tunerOnFrame(462))).toBe(toHex(HW_TUNER_ON_462));
  });
  it('tuner off is the captured 4-byte body', () => {
    expect(toHex(TUNER_OFF)).toBe(toHex(HW_TUNER_OFF));
  });
  it('rejects a reference outside the slider range', () => {
    expect(() => tunerOnFrame(300)).toThrow(RangeError);
    expect(() => tunerOnFrame(500)).toThrow(RangeError);
  });
});

describe('expression assignments request (Cortex Cloud HCI capture 2026-09-19)', () => {
  it('is byte-identical to the captured read for preset 58', () => {
    expect(toHex(expressionAssignmentsRequest(58))).toBe(toHex(HW_EXP_ASSIGN_REQUEST_58));
    expect(() => expressionAssignmentsRequest(64)).toThrow(RangeError);
  });
});

describe('outputs 1/2 mute frame (Cortex Cloud HCI capture 2026-09-15)', () => {
  it('mute sends 1 and unmute sends 0, byte-identical to what Cortex Cloud sent', () => {
    expect(toHex(outputsMuteFrame(true))).toBe('08 C0 08 01 68 01 43 00 00 00');
    expect(toHex(outputsMuteFrame(false))).toBe('08 C0 08 01 68 00 43 00 00 00');
    expect(toHex(outputsMuteFrame(false))).toBe(toHex(HW_OUTPUTS_MUTE_WRITES[0]!)); // first tap from muted = unmute
    expect(toHex(outputsMuteFrame(true))).toBe(toHex(HW_OUTPUTS_MUTE_WRITES[1]!));
  });
});
