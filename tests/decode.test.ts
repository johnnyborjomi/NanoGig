import { describe, expect, it } from 'vitest';
import {
  decodeCurrentState,
  decodeEvent,
  decodeMetadata,
  inferActivePreset,
  isInternalIdentifier,
  sanitizeName,
  decodeExpressionAssignments,
} from '../src/protocol/decode';
import { fromHex } from '../src/protocol/hex';
import {
  HW_EXP_ASSIGN_ACK,
  HW_EXP_ASSIGN_REPLY_2,
  HW_EXP_ASSIGN_REPLY_58,
  HW_EXP_ASSIGN_WRITE_ALL,
  HW_EXP_VALUES_ALL_96,
  HW_EXP_POSITION_138,
  HW_EXP_POSITION_HEEL,
  HW_EXP_POSITION_TOE,
  HW_EXP_VALUES_NONE,
  HW_EXP_VALUES_POST2_POST3,
  HW_EXP_VALUES_POST3,
  HW_TUNER_ON_ACK,
  HW_TUNER_PITCH_A_PLUS_14,
  HW_TUNER_PITCH_D_MINUS_0_5,
  HW_TUNER_PITCH_G_PLUS_2_3,
} from '../src/fixtures/hardware-2026-09-19';
import { bytesField, stringField } from '../src/protocol/proto';
import { DEMO_PRESETS, REAL_EVENTS, REAL_STATE_DUMP_PACKET, buildFootswitchSelectEvent, buildMetadataBody, buildPresetChangedEvent } from '../src/fixtures/captures';

describe('decodeCurrentState (real firmware 2.2.1 capture)', () => {
  const state = decodeCurrentState(REAL_STATE_DUMP_PACKET.subarray(2))!;

  it('decodes the field-31 bypass array: pre1/pre2 bypassed, post1..3 on', () => {
    expect(state.bypassRaw).toEqual([1, 1, 0, 0, 0]);
    expect(state.fxOn).toEqual({ pre1: false, pre2: false, post1: true, post2: true, post3: true });
  });
  it('decodes gate (inverted field 54, absent → on) and cab/IR (field 12)', () => {
    expect(state.gateOn).toBe(true);
    expect(state.cabOn).toBe(false);
  });
  it('decodes capture and IR names from sub-messages 32 / 33', () => {
    expect(state.capture?.name).toBe('NoMatch Chief 1');
    expect(state.capture?.enabled).toBe(true);
    expect(state.ir?.shortName).toBe('110 US PRN C10R');
    expect(state.ir?.fullName).toBe('110 US PRN C10R/Ribbon 160/2');
  });
  it('decodes amp knobs, capture slot/volume, firmware', () => {
    expect(state.amp).toEqual({ gain: 127, level: 144, bass: 129, mid: 127, treble: 113 });
    expect(state.captureSlot).toBe(2);
    expect(state.captureVolumeRaw).toBe(127);
    expect(state.firmware).toBe('2.2.1');
  });
  it('decodes FX model ids tolerating varint encoding (raw bytes preserved)', () => {
    expect(state.fxModelIds).toEqual({ pre1: 'D18C01', pre2: '1B', post1: 'F336', post2: 'FA2E', post3: 'CB3E' });
  });
  it('decodes footswitch assignments', () => {
    expect(state.footswitchAssignments).toEqual({ ia: 3, ib: 7, iia: 10, iib: 16 });
  });
  it('is always provisional', () => {
    expect(state.provisional).toBe(true);
  });
  it('reports gate off when field 54 is non-zero and cab on when field 12 is set', () => {
    const body = Uint8Array.from([...fromHex('18 7F'), 0x60, 0x01, ...fromHex('B0 03 01'), ...bytesField(31, [0, 0, 0, 0, 1])]);
    const s = decodeCurrentState(body)!;
    expect(s.gateOn).toBe(false);
    expect(s.cabOn).toBe(true);
    expect(s.fxOn?.post3).toBe(false);
  });
  it('returns null for unrecognisable payloads instead of throwing', () => {
    expect(decodeCurrentState(new Uint8Array())).toBeNull();
    expect(decodeCurrentState(fromHex('FF FF FF'))).toBeNull();
    expect(decodeCurrentState(fromHex('C0 08 01'))).toBeNull();
  });
});

describe('decodeMetadata', () => {
  it('extracts 64 preset names in slot order from the synthetic metadata', () => {
    const md = decodeMetadata(buildMetadataBody(DEMO_PRESETS));
    expect(md.presets).toHaveLength(64);
    expect(md.presetRecordCount).toBe(64);
    expect(md.presets[7]?.name).toBe('Clean Chief');
    expect(md.presets[7]?.captureName).toBe('NoMatch Chief 1');
    expect(md.presets[7]?.irShortName).toBe('110 US PRN C10R');
    expect(md.presets[0]?.name).toBe('Fuzz Face Melter');
    expect(md.presets[9]?.name).toBe('');
    expect(md.presets[10]?.name).toBe('Djent 8 String');
    expect(md.presets[63]?.name).toBe('');
    expect(md.captures.map((c) => c.name)).toContain('Brit 1959 Crunch');
    expect(md.irs.length).toBeGreaterThan(0);
    expect(md.provisional).toBe(true);
  });
  it('preserves blank slots and blanks internal identifier-like names without shifting', () => {
    const bytes = Uint8Array.from([
      ...fromHex('92 01 09 0A 07 43 6C 65 61 6E 20 31'), // "Clean 1"
      ...fromHex('92 01 08 0A 00 22 04 0A 00 12 00'), // blank
      ...fromHex('92 01 11 0A 0F 43 62 38 62 61 30 31 36 35 30 32 65 38 39 32'), // "Cb8ba016502e892"
      ...fromHex('92 01 08 0A 06 45 64 67 65 20 32'), // "Edge 2"
    ]);
    const md = decodeMetadata(bytes);
    expect(md.presets.slice(0, 4).map((p) => p.name)).toEqual(['Clean 1', '', '', 'Edge 2']);
    expect(md.presetRecordCount).toBe(4);
  });
  it('scans past partial prefix bytes when the top level yields no presets', () => {
    const bytes = Uint8Array.from([
      ...fromHex('08 01 12 FF FF'), // partial / junk prefix (length-delimited claims 255 bytes)
      ...fromHex('92 01 09 0A 07 43 6C 65 61 6E 20 31'),
      ...fromHex('8A 01 07 12 05 43 61 70 20 41'),
      ...fromHex('9A 01 07 0A 05 49 52 20 30 31'),
    ]);
    const md = decodeMetadata(bytes);
    expect(md.presets[0]?.name).toBe('Clean 1');
    expect(md.captures[0]?.name).toBe('Cap A');
    expect(md.irs[0]?.shortName).toBe('IR 01');
  });
  it('does not treat nested records as presets', () => {
    const bytes = Uint8Array.from([
      ...fromHex('8A 01 14 92 01 11 0A 0F 43 62 38 62 61 30 31 36 35 30 32 65 38 39 32'),
      ...fromHex('92 01 09 0A 07 43 6C 65 61 6E 20 31'),
    ]);
    const md = decodeMetadata(bytes);
    expect(md.presetRecordCount).toBe(1);
    expect(md.presets[0]?.name).toBe('Clean 1');
  });
  it('returns an all-blank list for garbage', () => {
    const md = decodeMetadata(fromHex('FF FF FF FF'));
    expect(md.presets).toHaveLength(64);
    expect(md.presetRecordCount).toBe(0);
  });
});

describe('name sanitising', () => {
  it('detects internal identifiers', () => {
    expect(isInternalIdentifier('d48b4316dbcc')).toBe(true);
    expect(isInternalIdentifier('d48b-4316-dbcc')).toBe(true);
    expect(isInternalIdentifier('Clean 1')).toBe(false);
    expect(isInternalIdentifier('abc123')).toBe(false);
  });
  it('trims and blanks', () => {
    expect(sanitizeName('  Lead  ')).toBe('Lead');
    expect(sanitizeName(null)).toBe('');
    expect(sanitizeName('x'.repeat(121))).toBe('');
  });
});

describe('decodeEvent', () => {
  it('decodes the 2-byte MIDI program change shape for presets 0..63 on any channel', () => {
    expect(decodeEvent(fromHex('C0 00'))).toMatchObject({ kind: 'program-change', preset: 0, shape: 'midi-2byte' });
    expect(decodeEvent(fromHex('C0 1F'))).toMatchObject({ kind: 'program-change', preset: 31 });
    expect(decodeEvent(fromHex('C3 3F'))).toMatchObject({ kind: 'program-change', preset: 63 });
  });
  it('rejects out-of-range or differently shaped 2-byte payloads', () => {
    expect(decodeEvent(fromHex('C0 40')).kind).toBe('unknown');
    expect(decodeEvent(fromHex('B0 00')).kind).toBe('unknown');
    expect(decodeEvent(fromHex('C0')).kind).toBe('unknown');
    expect(decodeEvent(fromHex('80 80 C0 00')).kind).toBe('unknown'); // BLE-MIDI framed: not recognised
  });
  it('decodes the hardware-captured footswitch preset-select shape (with and without length byte)', () => {
    const ev = decodeEvent(REAL_EVENTS.footswitchSelectPreset0);
    expect(ev).toMatchObject({ kind: 'program-change', preset: 0, shape: 'footswitch-select', assignments: { ia: 0, ib: 1, iia: 2, iib: 3 } });
    const ev2 = decodeEvent(buildFootswitchSelectEvent(9));
    expect(ev2).toMatchObject({ kind: 'program-change', preset: 9, assignments: { ia: 3, ib: 7, iia: 10, iib: 16 } });
    const ev3 = decodeEvent(buildPresetChangedEvent(9));
    expect(ev3).toMatchObject({ kind: 'program-change', preset: 9, shape: 'preset-changed' });
  });
  it('treats the bank button (type 0x1C) as control telemetry, never a preset change', () => {
    expect(decodeEvent(fromHex('08 C0 08 01 20 01 1C 00 00 00'))).toMatchObject({ kind: 'control', msgType: 0x1c });
  });
  it('carries the provisional flag everywhere', () => {
    expect(decodeEvent(fromHex('C0 00')).provisional).toBe(true);
    expect(decodeEvent(fromHex('00')).provisional).toBe(true);
  });
});

describe('inferActivePreset', () => {
  const md = decodeMetadata(buildMetadataBody(DEMO_PRESETS));
  it('returns the index when exactly one preset matches capture + IR', () => {
    const state = decodeCurrentState(REAL_STATE_DUMP_PACKET.subarray(2))!;
    expect(inferActivePreset(md, state)).toBe(7); // Clean Chief: NoMatch Chief 1 + 110 US PRN C10R
  });
  it('returns null when the match is ambiguous', () => {
    const body = Uint8Array.from([
      ...bytesField(32, [...stringField(2, 'Brit 1959 Crunch')]),
      ...bytesField(33, [...stringField(2, '412 UK GRN V30')]),
    ]);
    expect(inferActivePreset(md, decodeCurrentState(body)!)).toBeNull(); // 3 presets share this pair
  });
  it('returns null when no names are available', () => {
    const body = Uint8Array.from([...fromHex('18 7F')]);
    expect(inferActivePreset(md, decodeCurrentState(body)!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hardware captures, 2026-09-12 (NanOS 2.2.1)
// ---------------------------------------------------------------------------
import {
  HW_BYPASS_CHANGED,
  HW_METADATA_FIRST_BODY_PREFIX,
  HW_PRESET_CHANGED,
  HW_STATE_AFTER_CAPTURE_BYPASS,
  HW_STATE_SEGMENTED,
  HW_STATE_SINGLE,
  HW_UNKNOWN_73,
} from '../src/fixtures/hardware-2026-09-12';
import { splitTrailer } from '../src/protocol/reassembly';
import { concatBytes } from '../src/protocol/hex';

describe('hardware 2026-09-12: preset-changed event', () => {
  it('decodes `10 C0 … 1D 00 00 00` as preset index 3 with footswitch assignments', () => {
    expect(decodeEvent(HW_PRESET_CHANGED)).toEqual({
      kind: 'program-change',
      preset: 3,
      shape: 'preset-changed',
      assignments: { ia: 3, ib: 5, iia: 20, iib: 14 },
      provisional: true,
    });
  });
  it('decodes the bypass-changed and unknown events by trailer type', () => {
    expect(decodeEvent(HW_BYPASS_CHANGED)).toEqual({ kind: 'bypass-changed', provisional: true });
    expect(decodeEvent(HW_UNKNOWN_73)).toMatchObject({ kind: 'unknown', msgType: 0x73 });
  });
  it('classifies knob / expression / encoder telemetry as control, not unknown', () => {
    expect(decodeEvent(REAL_EVENTS.gainKnob)).toMatchObject({ kind: 'control', msgType: 0x1a });
    expect(decodeEvent(REAL_EVENTS.expressionToe)).toMatchObject({ kind: 'expression', position: 255 }); // now decoded, not telemetry
    expect(decodeEvent(REAL_EVENTS.encoderI)).toMatchObject({ kind: 'control', msgType: 0x1c });
  });
});

describe('hardware 2026-09-12: state dumps', () => {
  const single = decodeCurrentState(splitTrailer(HW_STATE_SINGLE.subarray(2)).payload)!;
  const body = concatBytes([HW_STATE_SEGMENTED[0]!.subarray(2), HW_STATE_SEGMENTED[1]!.subarray(2)]);
  const segmented = decodeCurrentState(splitTrailer(body).payload)!;

  it('single-packet dump: preset 14, bypass [0,1,0,0,0], cab on, gate on, names', () => {
    expect(single.activePreset).toBe(14);
    expect(single.bypassRaw).toEqual([0, 1, 0, 0, 0]);
    expect(single.fxOn).toEqual({ pre1: true, pre2: false, post1: true, post2: true, post3: true });
    expect(single.cabOn).toBe(true);
    expect(single.gateOn).toBe(true);
    expect(single.capture?.name).toBe("CA John's Ch1 1");
    expect(single.ir?.shortName).toBe('110 US PRN C10R');
    expect(single.ir?.fullName).toBe('110 US PRN C10R/Ribbon 160/3');
    expect(single.amp.gain).toBe(154);
    expect(single.firmware).toBe('2.2.1');
    expect(single.footswitchAssignments).toEqual({ ia: 3, ib: 5, iia: 20, iib: 14 });
    expect(single.tempoBpm).toBe(120); // field 56 fixed32 = tempo BPM (confirmed 2026-09-14)
  });
  it('two-packet dump after the footswitch: preset 3 matches the event, bypass [1,0,0,1,1]', () => {
    expect(segmented.activePreset).toBe(3);
    expect(segmented.bypassRaw).toEqual([1, 0, 0, 1, 1]);
    expect(segmented.fxOn).toEqual({ pre1: false, pre2: true, post1: true, post2: false, post3: false });
    expect(segmented.cabOn).toBe(true);
    expect(segmented.gateOn).toBe(true);
    expect(segmented.capture?.name).toBe('EVH 5150III Ch3 Gain3');
    expect(segmented.ir?.shortName).toBe("412 CA Stand OS A V30 '01");
    expect(segmented.amp.gain).toBe(159);
    expect(segmented.fxModelIds.pre1).toBe('D18C01');
  });
  it('2026-09-13 dump after the capture-bypass frame: position 0 = bypassed although 32.1 still says 1', () => {
    const st = decodeCurrentState(splitTrailer(HW_STATE_AFTER_CAPTURE_BYPASS.subarray(2)).payload)!;
    expect(st.activePreset).toBe(33);
    expect(st.captureSlot).toBeNull(); // field 11 absent → 0 → bypassed
    expect(st.capture?.enabled).toBe(true); // stale / different meaning — not the bypass flag
    expect(st.capture?.name).toBe('US Prince 65 4');
    expect(st.cabOn).toBe(false); // field 12 absent
    expect(st.ir?.shortName).toBe('110 US PRN C10R');
    expect(st.ir?.fullName).toBe('110 US PRN C10R/Dynamic 57/0');
    expect(st.fxOn).toEqual({ pre1: false, pre2: false, post1: false, post2: true, post3: true });
    expect(st.gateOn).toBe(true);
    // the segmented 09-12 dump is the mirror case: 32.1 = 0 while position 4 → on
    expect(segmented.capture?.enabled).toBe(false);
    expect(segmented.captureSlot).toBe(4);
  });
  it('the metadata reply starts with the same state fields (preset 14)', () => {
    const md = decodeCurrentState(HW_METADATA_FIRST_BODY_PREFIX)!;
    expect(md.activePreset).toBe(14);
    expect(md.amp).toEqual({ gain: 154, level: 99, bass: 120, mid: 127, treble: 127 });
  });
  it('a state-only dump yields no preset records', () => {
    expect(decodeMetadata(splitTrailer(HW_STATE_SINGLE.subarray(2)).payload).presetRecordCount).toBe(0);
  });
  it('the reference firmware-2.2.1 dump carries preset index 7 in field 13', () => {
    expect(decodeCurrentState(REAL_STATE_DUMP_PACKET.subarray(2))!.activePreset).toBe(7);
  });
});

describe('device settings (type 0x42) and outputs-mute ack (type 0x44)', async () => {
  const { decodeDeviceSettings, describeDeviceSettings, decodeEvent } = await import('../src/protocol/decode');
  const { splitTrailer } = await import('../src/protocol/reassembly');
  const { HW_DEVICE_SETTINGS_REPLY, HW_DEVICE_SETTINGS_REPLY_UNMUTED, HW_OUTPUTS_MUTE_ACK } = await import('../src/fixtures/hardware-2026-09-15');
  it('decodes the settings reply fields and the device name', () => {
    const { payload, msgType } = splitTrailer(HW_DEVICE_SETTINGS_REPLY.subarray(2));
    expect(msgType).toBe(0x42);
    const s = decodeDeviceSettings(payload)!;
    expect(s.deviceName).toBe('Neural DSP Nano Cortex');
    expect(s.fields[1]).toBe(1);
    expect(s.fields[6]).toBe(56);
    expect(s.fields[11]).toBe(0);
    expect(s.fields[13]).toBe(107);
    expect(s.fields[17]).toBe(-6);
    expect(s.fields[16]).toBe(1);
    expect(s.outputsMuted).toBe(true);
    expect(describeDeviceSettings(s)).toContain('f5="Neural DSP Nano Cortex"');
    expect(describeDeviceSettings(s)).toContain('f17=-6');
  });
  it('reads outputs 1/2 as on when field 16 is absent (57 B reply after an unmute)', () => {
    const { payload } = splitTrailer(HW_DEVICE_SETTINGS_REPLY_UNMUTED.subarray(2));
    const s = decodeDeviceSettings(payload)!;
    expect(s.fields[16]).toBeUndefined();
    expect(s.outputsMuted).toBe(false);
    expect(s.deviceName).toBe('Neural DSP Nano Cortex');
  });
  it('decodeEvent classifies the settings reply and the mute ack', () => {
    const ev = decodeEvent(HW_DEVICE_SETTINGS_REPLY);
    expect(ev.kind).toBe('settings');
    if (ev.kind === 'settings') expect(ev.settings.deviceName).toBe('Neural DSP Nano Cortex');
    expect(decodeEvent(HW_OUTPUTS_MUTE_ACK).kind).toBe('outputs-mute-ack');
  });
  it('decodeEvent reads the tuner-on ack: on, 440 Hz (NanoGig log 2026-09-19)', () => {
    const ev = decodeEvent(HW_TUNER_ON_ACK);
    expect(ev.kind).toBe('tuner-ack');
    if (ev.kind === 'tuner-ack') {
      expect(ev.on).toBe(true);
      expect(ev.referenceHz).toBe(440);
    }
  });
  it('decodeEvent reads tuner pitch events: note, cents and the in-tune flag (2026-09-19 capture)', () => {
    const a = decodeEvent(HW_TUNER_PITCH_A_PLUS_14);
    expect(a.kind).toBe('tuner');
    if (a.kind === 'tuner') {
      expect(a.reading.note).toBe('A');
      expect(a.reading.cents).toBeCloseTo(14.272, 2);
      expect(a.reading.inTune).toBe(false);
    }
    const d = decodeEvent(HW_TUNER_PITCH_D_MINUS_0_5);
    if (d.kind === 'tuner') {
      expect(d.reading.note).toBe('D');
      expect(d.reading.cents).toBeCloseTo(-0.541, 2);
      expect(d.reading.inTune).toBe(true);
    } else throw new Error(d.kind);
    const g = decodeEvent(HW_TUNER_PITCH_G_PLUS_2_3);
    if (g.kind === 'tuner') {
      expect(g.reading.note).toBe('G');
      expect(g.reading.cents).toBeCloseTo(2.341, 2);
      expect(g.reading.inTune).toBe(false);
    } else throw new Error(g.kind);
  });
});

describe('expression pedal (Cortex Cloud HCI capture 2026-09-19)', () => {
  it('position events: 138, heel (field absent) and toe', () => {
    for (const [pkt, pos] of [[HW_EXP_POSITION_138, 138], [HW_EXP_POSITION_HEEL, 0], [HW_EXP_POSITION_TOE, 254]] as const) {
      const ev = decodeEvent(pkt);
      expect(ev.kind).toBe('expression');
      if (ev.kind === 'expression') expect(ev.position).toBe(pos);
    }
    const c = decodeEvent(REAL_EVENTS.expressionCenter); // the rixrix fixtures decode the same way
    if (c.kind === 'expression') expect(c.position).toBe(128);
    else throw new Error(c.kind);
  });
  it('values events: post 3 alone, post 2 + post 3, none', () => {
    const a = decodeEvent(HW_EXP_VALUES_POST3);
    if (a.kind === 'expression-values') expect(a.values).toEqual({ ranges: { post3: 78 }, bypasses: {} });
    else throw new Error(a.kind);
    const b = decodeEvent(HW_EXP_VALUES_POST2_POST3);
    if (b.kind === 'expression-values') expect(b.values).toEqual({ ranges: { post2: 224, post3: 224 }, bypasses: {} });
    else throw new Error(b.kind);
    const n = decodeEvent(HW_EXP_VALUES_NONE);
    if (n.kind === 'expression-values') expect(n.values).toEqual({ ranges: {}, bypasses: {} });
    else throw new Error(n.kind);
    // Everything assigned, pedal at 96: all eleven ranges at 96, the six heel-toe bypasses engaged.
    const all = decodeEvent(HW_EXP_VALUES_ALL_96);
    if (all.kind === 'expression-values') {
      expect(all.values.ranges).toEqual({ gain: 96, bass: 96, mid: 96, treble: 96, level: 96, pre1: 96, pre2: 96, post1: 96, post2: 96, post3: 96, range13: 96 });
      expect(all.values.bypasses).toEqual({ pre1: true, pre2: true, post1: true, post2: true, post3: true, bypass22: true });
    } else throw new Error(all.kind);
  });
  it('assignment replies: post 3 17–130 (preset 58) and 15–127 (preset 2); the ack', () => {
    const r = decodeEvent(HW_EXP_ASSIGN_REPLY_58);
    if (r.kind === 'expression-assignments') expect(r.assignments).toEqual({ ranges: { post3: { min: 17, max: 130, flag: 0 } }, bypasses: {} });
    else throw new Error(r.kind);
    const r2 = decodeEvent(HW_EXP_ASSIGN_REPLY_2);
    if (r2.kind === 'expression-assignments') expect(r2.assignments.ranges.post3).toEqual({ min: 15, max: 127, flag: 0 });
    else throw new Error(r2.kind);
    expect(decodeEvent(HW_EXP_ASSIGN_ACK).kind).toBe('expression-assign-ack');
  });
  it("Cortex Cloud's 'assign everything' write decodes to the full map (write numbering)", () => {
    const { payload } = splitTrailer(HW_EXP_ASSIGN_WRITE_ALL.subarray(2));
    const a = decodeExpressionAssignments(payload, 0);
    expect(Object.keys(a.ranges).sort()).toEqual(['bass', 'gain', 'level', 'mid', 'post1', 'post2', 'post3', 'pre1', 'pre2', 'range13', 'treble']);
    expect(a.ranges.level).toEqual({ min: 0, max: 255, flag: 0 });
    expect(a.bypasses).toEqual({
      capture: { mode: 1, delayMs: 600 },
      ir: { mode: 3, delayMs: 600 },
      pre1: { mode: 2, delayMs: 0 },
      pre2: { mode: 2, delayMs: 0 },
      post1: { mode: 2, delayMs: 0 },
      post2: { mode: 2, delayMs: 0 },
      post3: { mode: 2, delayMs: 0 },
      bypass22: { mode: 2, delayMs: 0 },
    });
  });
});
