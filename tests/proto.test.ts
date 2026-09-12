import { describe, expect, it } from 'vitest';
import {
  bytesField,
  decodePrintable,
  encodeVarint,
  firstBytes,
  firstFixed32Float,
  firstString,
  firstVarint,
  fixed32FloatField,
  parseFields,
  readVarint,
  stringField,
  varintField,
} from '../src/protocol/proto';
import { fromHex } from '../src/protocol/hex';

describe('readVarint', () => {
  it('reads single and multi-byte varints', () => {
    expect(readVarint([0x7f], 0)).toEqual({ value: 127, next: 1 });
    expect(readVarint([0x8f, 0x01], 0)).toEqual({ value: 143, next: 2 });
    expect(readVarint([0x90, 0x01], 0)).toEqual({ value: 144, next: 2 });
    expect(readVarint([0xd1, 0x8c, 0x01], 0)).toEqual({ value: 18001, next: 3 }); // 0x51 + (0x0C << 7) + (1 << 14)
  });
  it('honours offset and reports truncation', () => {
    expect(readVarint([0x00, 0xff, 0x01], 1)).toEqual({ value: 255, next: 3 });
    expect(readVarint([0xff], 0)).toBeNull();
    expect(readVarint([], 0)).toBeNull();
  });
  it('round-trips with encodeVarint', () => {
    for (const n of [0, 1, 127, 128, 255, 300, 16383, 16384, 2 ** 31, 2 ** 40]) {
      const enc = encodeVarint(n);
      expect(readVarint(enc, 0)).toEqual({ value: n, next: enc.length });
    }
  });
});

describe('parseFields', () => {
  it('parses varint, length-delimited, fixed32 and fixed64 fields in order', () => {
    const msg = Uint8Array.from([
      ...varintField(1, 5),
      ...stringField(2, 'hi'),
      ...fixed32FloatField(3, 0.5),
      0x21, 1, 2, 3, 4, 5, 6, 7, 8, // field 4, wire 1 (fixed64)
      ...varintField(1, 6),
    ]);
    const f = parseFields(msg);
    expect(f.map((x) => [x.field, x.wire])).toEqual([
      [1, 0],
      [2, 2],
      [3, 5],
      [4, 1],
      [1, 0],
    ]);
    expect(firstVarint(f, 1)).toBe(5);
    expect(firstString(f, 2)).toBe('hi');
    expect(firstFixed32Float(f, 3)).toBeCloseTo(0.5);
    expect(firstBytes(f, 2)).toEqual(Uint8Array.from([0x68, 0x69]));
  });
  it('stops gracefully on truncated input instead of throwing', () => {
    const truncated = fromHex('08 05 12 10 41 42'); // says 16 bytes, provides 2
    const f = parseFields(truncated);
    expect(f).toHaveLength(1);
    expect(f[0]?.value).toBe(5);
    expect(parseFields(fromHex('08'))).toEqual([]);
    expect(parseFields(new Uint8Array())).toEqual([]);
  });
  it('stops on unknown wire types (3/4 groups)', () => {
    expect(parseFields(fromHex('0B 08 01'))).toEqual([]);
  });
  it('handles nested messages', () => {
    const inner = [...varintField(1, 1), ...stringField(2, 'NoMatch Chief 1')];
    const outer = Uint8Array.from(bytesField(32, inner));
    const f = parseFields(outer);
    const sub = parseFields(firstBytes(f, 32)!);
    expect(firstString(sub, 2)).toBe('NoMatch Chief 1');
  });
});

describe('decodePrintable / firstString', () => {
  it('returns null for non-printable bytes and empty string for empty', () => {
    expect(decodePrintable([0x41, 0x00])).toBeNull();
    expect(decodePrintable([])).toBe('');
    expect(decodePrintable([0x41, 0x7e])).toBe('A~');
  });
  it('firstString skips non-printable candidates', () => {
    const msg = Uint8Array.from([...bytesField(1, [0xff, 0x00]), ...stringField(1, 'ok')]);
    expect(firstString(parseFields(msg), 1)).toBe('ok');
    expect(firstString(parseFields(msg), 9)).toBe('');
  });
});
