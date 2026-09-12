import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromHex, toHex } from '../src/protocol/hex';
import {
  MSG,
  MessageAssembler,
  classifyPacket,
  encodeFrameHeader,
  frameSingle,
  isLengthPrefixedCommandFrame,
  parseFrameHeader,
  splitTrailer,
} from '../src/protocol/reassembly';
import { CURRENT_STATE_REQUEST, METADATA_DUMP_REQUEST, PRESET_CHANGE_ACK } from '../src/protocol/frames';
import { REAL_EVENTS, REAL_STATE_DUMP_PACKET, segmentStream } from '../src/fixtures/captures';
import {
  HW_BYPASS_CHANGED,
  HW_METADATA_LAST_HEADER,
  HW_PRESET_CHANGED,
  HW_STATE_SEGMENTED,
  HW_STATE_SINGLE,
  HW_UNKNOWN_73,
} from '../src/fixtures/hardware-2026-09-12';

const pad = (header: string, bodyLen: number) => Uint8Array.from([...fromHex(header), ...new Array(bodyLen).fill(0x41)]);

describe('frame header (14-bit length + START/END flags) against hardware packets', () => {
  it('decodes every header shape seen on hardware', () => {
    expect(parseFrameHeader(pad('FE 41', 510))).toEqual({ bodyLength: 510, start: true, end: false });
    expect(parseFrameHeader(pad('FE 01', 510))).toEqual({ bodyLength: 510, start: false, end: false });
    expect(parseFrameHeader(pad('0A 81', 266))).toEqual({ bodyLength: 266, start: false, end: true });
    expect(parseFrameHeader(pad('EE 80', 238))).toEqual({ bodyLength: 238, start: false, end: true });
    expect(parseFrameHeader(pad('FD C1', 509))).toEqual({ bodyLength: 509, start: true, end: true });
    expect(parseFrameHeader(HW_PRESET_CHANGED)).toEqual({ bodyLength: 16, start: true, end: true });
    expect(parseFrameHeader(HW_BYPASS_CHANGED)).toEqual({ bodyLength: 6, start: true, end: true });
    expect(parseFrameHeader(HW_STATE_SINGLE)).toEqual({ bodyLength: 509, start: true, end: true });
    expect(parseFrameHeader(HW_STATE_SEGMENTED[0]!)).toEqual({ bodyLength: 510, start: true, end: false });
    expect(parseFrameHeader(HW_STATE_SEGMENTED[1]!)).toEqual({ bodyLength: 238, start: false, end: true });
    expect(toHex(HW_METADATA_LAST_HEADER)).toBe('0A 81');
  });
  it('matches the reference captures and our own request frames', () => {
    expect(REAL_STATE_DUMP_PACKET.length).toBe(488); // `E6 C1` → 0x1E6 = 486 + START + END
    expect(parseFrameHeader(REAL_STATE_DUMP_PACKET)).toEqual({ bodyLength: 486, start: true, end: true });
    expect(parseFrameHeader(REAL_EVENTS.gainKnob)).toEqual({ bodyLength: 11, start: true, end: true });
    expect(parseFrameHeader(METADATA_DUMP_REQUEST)).toEqual({ bodyLength: 6, start: true, end: true });
    expect(parseFrameHeader(CURRENT_STATE_REQUEST)).toEqual({ bodyLength: 12, start: true, end: true });
    expect(parseFrameHeader(PRESET_CHANGE_ACK)).toEqual({ bodyLength: 6, start: true, end: true });
  });
  it('rejects headers whose length does not match the packet', () => {
    expect(parseFrameHeader(fromHex('FE 41 08 01'))).toBeNull();
    expect(parseFrameHeader(fromHex('C0'))).toBeNull();
    expect(parseFrameHeader(REAL_EVENTS.footswitchSelectPreset0)).toBeNull(); // header-less rixrix fixture
  });
  it('round-trips through encodeFrameHeader / frameSingle', () => {
    expect(toHex(Uint8Array.from(encodeFrameHeader(510, true, false)))).toBe('FE 41');
    expect(toHex(Uint8Array.from(encodeFrameHeader(266, false, true)))).toBe('0A 81');
    expect(toHex(Uint8Array.from(encodeFrameHeader(509, true, true)))).toBe('FD C1');
    expect(toHex(frameSingle(fromHex('08 01 1F 00 00 00')))).toBe('06 C0 08 01 1F 00 00 00');
  });
});

describe('splitTrailer', () => {
  it('extracts the message type from `xx 00 00 00`', () => {
    expect(splitTrailer(HW_PRESET_CHANGED.subarray(2)).msgType).toBe(MSG.PRESET_CHANGED);
    expect(splitTrailer(HW_BYPASS_CHANGED.subarray(2)).msgType).toBe(MSG.BYPASS_CHANGED);
    expect(splitTrailer(HW_UNKNOWN_73.subarray(2)).msgType).toBe(0x73);
    expect(splitTrailer(HW_STATE_SINGLE.subarray(2)).msgType).toBe(MSG.DUMP);
    expect(splitTrailer(REAL_STATE_DUMP_PACKET.subarray(2)).msgType).toBe(MSG.DUMP);
    expect(toHex(splitTrailer(HW_BYPASS_CHANGED.subarray(2)).payload)).toBe('08 01');
  });
  it('returns null when there is no trailer', () => {
    expect(splitTrailer(fromHex('08 01')).msgType).toBeNull();
    expect(splitTrailer(fromHex('08 01 02 03 04')).msgType).toBeNull();
  });
});

describe('classifyPacket', () => {
  it('complete single frames are messages, partial frames are fragments', () => {
    expect(classifyPacket(HW_STATE_SINGLE)).toBe('message');
    expect(classifyPacket(HW_PRESET_CHANGED)).toBe('message');
    expect(classifyPacket(REAL_EVENTS.gainKnob)).toBe('message');
    expect(classifyPacket(HW_STATE_SEGMENTED[0]!)).toBe('fragment');
    expect(classifyPacket(HW_STATE_SEGMENTED[1]!)).toBe('fragment');
    expect(classifyPacket(pad('FE 01', 510))).toBe('fragment');
    expect(classifyPacket(pad('0A 81', 266))).toBe('fragment');
  });
  it('events interleaved during an open multi-packet message stay messages', () => {
    for (const ev of [REAL_EVENTS.gainKnob, REAL_EVENTS.encoderI, REAL_EVENTS.expressionToe, HW_PRESET_CHANGED]) {
      expect(isLengthPrefixedCommandFrame(ev)).toBe(true);
      expect(classifyPacket(ev, true)).toBe('message');
    }
  });
  it('falls back to the reference heuristics when the header does not validate', () => {
    expect(classifyPacket(fromHex('FE 41 08 01'))).toBe('fragment'); // legacy FE start byte
    expect(classifyPacket(fromHex('17 80 08 01 18 76'), true)).toBe('fragment'); // 0x80 while open
    expect(classifyPacket(fromHex('17 80 08 01 18 76'), false)).toBe('message');
    expect(classifyPacket(fromHex('C0 05'))).toBe('message'); // 2-byte MIDI PC shape
    expect(classifyPacket(REAL_EVENTS.footswitchSelectPreset0)).toBe('message');
  });
  it('classifies parameter replies and empty packets', () => {
    expect(classifyPacket(fromHex('0E C0 08 06 22 08 00 00 00 3F 00 00 80 3F'))).toBe('fx-param-reply');
    expect(classifyPacket(Uint8Array.from([0x8e, 0xc0, 0x08, 0x06, ...new Array(20).fill(0x41)]))).toBe('cab-param-reply');
    expect(classifyPacket(new Uint8Array())).toBe('empty');
  });
});

describe('MessageAssembler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits immediately on END with the concatenated body (hardware two-packet dump)', () => {
    const onMessage = vi.fn();
    const a = new MessageAssembler({ onMessage });
    a.push(HW_STATE_SEGMENTED[0]!);
    expect(a.open).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    a.push(HW_STATE_SEGMENTED[1]!);
    expect(onMessage).toHaveBeenCalledTimes(1);
    const [body, meta] = onMessage.mock.calls[0]!;
    expect(body.length).toBe(510 + 238);
    expect(meta).toEqual({ packets: 2, complete: true });
    expect(a.open).toBe(false);
  });

  it('reassembles a 34-packet synthetic stream byte-exactly', () => {
    const onMessage = vi.fn();
    const a = new MessageAssembler({ onMessage });
    const body = Uint8Array.from({ length: 17_000 }, (_, i) => i & 0xff);
    const packets = segmentStream(body, 510);
    expect(packets.length).toBe(34);
    expect(toHex(packets[0]!.subarray(0, 2))).toBe('FE 41');
    expect(toHex(packets[1]!.subarray(0, 2))).toBe('FE 01');
    for (const p of packets) a.push(p);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(Array.from(onMessage.mock.calls[0]![0])).toEqual(Array.from(body));
  });

  it('flushes an unterminated message after the inactivity fallback, marked incomplete', () => {
    const onMessage = vi.fn();
    const a = new MessageAssembler({ onMessage, inactivityMs: 2500 });
    a.push(HW_STATE_SEGMENTED[0]!);
    vi.advanceTimersByTime(2499);
    expect(onMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]![1]).toEqual({ packets: 1, complete: false });
  });

  it('a new START while open flushes the partial message first', () => {
    const onMessage = vi.fn();
    const a = new MessageAssembler({ onMessage });
    a.push(HW_STATE_SEGMENTED[0]!);
    a.push(HW_STATE_SEGMENTED[0]!);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]![1].complete).toBe(false);
    a.push(HW_STATE_SEGMENTED[1]!);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1]![1]).toEqual({ packets: 2, complete: true });
  });

  it('cancel() drops the partial buffer and the timer', () => {
    const onMessage = vi.fn();
    const a = new MessageAssembler({ onMessage });
    a.push(HW_STATE_SEGMENTED[0]!);
    a.cancel();
    expect(a.open).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
