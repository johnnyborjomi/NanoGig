/**
 * Minimal hand-rolled protobuf wire-format walker (varint + fixed64 +
 * length-delimited + fixed32). Adapted from choldy/nano-cortex-web-editor's
 * `parseProtoFields` / `readVarint` (MIT) and cross-checked with the Rust
 * `parse_proto_fields` in rixrix/deskop-nano-cortex.
 *
 * Design rules: never throw on malformed input — stop and return what was
 * parsed so far. The device messages are simple; protobufjs is deliberately
 * not used.
 */

export type WireType = 0 | 1 | 2 | 5;

export interface ProtoField {
  field: number;
  wire: WireType;
  /** Raw value bytes (varint bytes, 8/4 fixed bytes, or the delimited payload). */
  raw: Uint8Array;
  /** Decoded numeric value for wire 0 (varint). Saturates at MAX_SAFE_INTEGER. */
  value?: number;
}

export interface VarintResult {
  value: number;
  next: number;
}

/** Read a base-128 varint at `offset`. Returns null if truncated / >10 bytes. */
export function readVarint(bytes: ArrayLike<number>, offset: number): VarintResult | null {
  let value = 0;
  let multiplier = 1;
  const end = Math.min(bytes.length, offset + 10);
  for (let i = offset; i < end; i++) {
    const b = bytes[i]!;
    value += (b & 0x7f) * multiplier;
    if ((b & 0x80) === 0) {
      return { value: value > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value, next: i + 1 };
    }
    multiplier *= 128;
  }
  return null;
}

/** Parse a message into an ordered field list (repeated fields preserved). */
export function parseFields(input: ArrayLike<number>): ProtoField[] {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(Array.from(input));
  const out: ProtoField[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = readVarint(bytes, i);
    if (!tag) break;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 0x07;
    i = tag.next;
    if (field === 0) break;
    if (wire === 0) {
      const v = readVarint(bytes, i);
      if (!v) break;
      out.push({ field, wire, raw: bytes.slice(i, v.next), value: v.value });
      i = v.next;
    } else if (wire === 1) {
      if (i + 8 > bytes.length) break;
      out.push({ field, wire, raw: bytes.slice(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = readVarint(bytes, i);
      if (!len) break;
      const start = len.next;
      const end = start + len.value;
      if (end > bytes.length) break;
      out.push({ field, wire, raw: bytes.slice(start, end) });
      i = end;
    } else if (wire === 5) {
      if (i + 4 > bytes.length) break;
      out.push({ field, wire, raw: bytes.slice(i, i + 4) });
      i += 4;
    } else {
      break; // groups / unknown wire types: stop, fail soft
    }
  }
  return out;
}

export function fieldsNumbered(fields: ProtoField[], n: number): ProtoField[] {
  return fields.filter((f) => f.field === n);
}

export function firstField(fields: ProtoField[], n: number): ProtoField | undefined {
  return fields.find((f) => f.field === n);
}

export function firstVarint(fields: ProtoField[], n: number): number | null {
  const f = fields.find((x) => x.field === n && x.wire === 0);
  return f?.value ?? null;
}

export function firstBytes(fields: ProtoField[], n: number): Uint8Array | null {
  const f = fields.find((x) => x.field === n && x.wire === 2);
  return f ? f.raw : null;
}

export function firstFixed32Float(fields: ProtoField[], n: number): number | null {
  const f = fields.find((x) => x.field === n && x.wire === 5);
  if (!f) return null;
  return new DataView(f.raw.buffer, f.raw.byteOffset, 4).getFloat32(0, true);
}

/** Printable-ASCII decode; null if any byte is outside 0x20..0x7E. Empty → ''. */
export function decodePrintable(bytes: ArrayLike<number>): string | null {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 32 || b > 126) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

/** First printable string in field `n`, or '' when absent / non-printable. */
export function firstString(fields: ProtoField[], n: number): string {
  for (const f of fields) {
    if (f.field !== n || f.wire !== 2) continue;
    const text = decodePrintable(f.raw);
    if (text !== null) return text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Encoding helpers — used by the mock transport and tests to build fixtures.
// ---------------------------------------------------------------------------

export function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`varint must be a non-negative integer: ${value}`);
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

export function tag(field: number, wire: WireType): number[] {
  return encodeVarint(field * 8 + wire);
}

export function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...encodeVarint(value)];
}

/**
 * Like `varintField`, but a zero value emits nothing, as the pedal does (proto3 default
 * semantics, seen 2026-09-26: a state dump on preset 1 has no field 13 at all). Use it in
 * fixtures for fields where 0 is a legal value, so tests exercise the absent-field path.
 */
export function varintFieldOpt(field: number, value: number): number[] {
  return value === 0 ? [] : varintField(field, value);
}

export function bytesField(field: number, payload: ArrayLike<number>): number[] {
  return [...tag(field, 2), ...encodeVarint(payload.length), ...Array.from(payload)];
}

export function stringField(field: number, text: string): number[] {
  return bytesField(field, Array.from(new TextEncoder().encode(text)));
}

export function fixed32FloatField(field: number, value: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return [...tag(field, 5), ...new Uint8Array(buf)];
}
