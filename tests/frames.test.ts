import { describe, expect, it } from 'vitest';
import {
  CURRENT_STATE_REQUEST,
  FX_ENABLE_SLOT,
  GATE_ENABLE_SLOT,
  METADATA_DUMP_REQUEST,
  MIDI_STRATEGIES,
  PRESET_CHANGE_ACK,
  PRESET_NAME_MAX_LENGTH,
  bleMidiFrame,
  presetLabelParts,
  fxBlockBypassFrame,
  midiStrategyById,
  gateBypassFrame,
  presetLabel,
  programChange,
} from '../src/protocol/frames';
import { toHex } from '../src/protocol/hex';

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
  it('frames follow the length-prefix convention byte[0] = length - 2', () => {
    for (const f of [METADATA_DUMP_REQUEST, CURRENT_STATE_REQUEST, PRESET_CHANGE_ACK]) {
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
  it('lists Web MIDI first, then the BLE variants from the rixrix probe, raw c302 last', () => {
    expect(MIDI_STRATEGIES.map((s) => s.id)).toEqual(['web-midi', 'c303-ble-midi', 'c302-ble-midi', 'c303-raw', 'c303-sequential', 'c302-raw']);
    expect(midiStrategyById('c302-raw')).toEqual({ id: 'c302-raw', char: 'c302', framing: 'raw' });
    expect(midiStrategyById('nope')).toBeNull();
  });
});
