/**
 * Packet framing, classification and multi-packet message assembly for the
 * `c305` notification stream.
 *
 * FRAMING (derived from a hardware log captured 2026-09-12 on NanOS 2.2.1;
 * consistent with every packet in the reference repos):
 *
 *   byte[0..1] = little-endian u16:  bits 0-13 body length (= packet length - 2)
 *                                    bit 14 (0x4000) START of message
 *                                    bit 15 (0x8000) END of message
 *   body       = protobuf message, normally followed by a 4-byte trailer
 *                `<msgType> 00 00 00`
 *
 * Examples: `FE 41` = 510 B + START, `FE 01` = 510 B continuation,
 * `0A 81` = 266 B + END, `EE 80` = 238 B + END, `FD C1` = 509 B single
 * message, `06 C0 08 01 1F 00 00 00` = 6 B single event, msgType 0x1F.
 * The "FE/FD/CE/D0 stream start" bytes the reference projects match on are
 * simply the low length byte of MTU-sized packets.
 *
 * A message is complete when a packet carrying END arrives — no debounce is
 * needed. An inactivity timer remains as a fail-soft fallback for a stream
 * that never terminates, and the legacy reference heuristics are kept for
 * packets whose header does not validate.
 */

export interface FrameHeader {
  bodyLength: number;
  start: boolean;
  end: boolean;
}

export const FLAG_START = 0x4000;
export const FLAG_END = 0x8000;
const LENGTH_MASK = 0x3fff;

/** Parse the 2-byte header; null if the encoded length does not match the packet. */
export function parseFrameHeader(data: Uint8Array): FrameHeader | null {
  if (data.length < 2) return null;
  const raw = data[0]! | (data[1]! << 8);
  const bodyLength = raw & LENGTH_MASK;
  if (bodyLength !== data.length - 2) return null;
  return { bodyLength, start: (raw & FLAG_START) !== 0, end: (raw & FLAG_END) !== 0 };
}

/**
 * A single-packet tuner pitch reading (type 0x80, `.. C0 .. 80 00 00 00`). Streamed ~30/s
 * while the tuner is on, so the transports keep it out of the hex log: it would push every
 * useful line out of the 400-line history in about 13 seconds.
 */
export function isTunerPitchPacket(data: Uint8Array): boolean {
  const n = data.length;
  return n >= 8 && data[1] === 0xc0 && data[n - 4] === 0x80 && data[n - 3] === 0 && data[n - 2] === 0 && data[n - 1] === 0;
}

export function encodeFrameHeader(bodyLength: number, start: boolean, end: boolean): [number, number] {
  if (bodyLength < 0 || bodyLength > LENGTH_MASK) throw new RangeError(`body too long: ${bodyLength}`);
  const raw = bodyLength | (start ? FLAG_START : 0) | (end ? FLAG_END : 0);
  return [raw & 0xff, raw >> 8];
}

/** Wrap a body as one complete frame (START+END). */
export function frameSingle(body: ArrayLike<number>): Uint8Array {
  return Uint8Array.from([...encodeFrameHeader(body.length, true, true), ...Array.from(body)]);
}

export interface SplitBody {
  payload: Uint8Array;
  /** Trailer message type, or null when the body has no `xx 00 00 00` trailer. */
  msgType: number | null;
}

/** Split the `<msgType> 00 00 00` trailer off a message body. */
export function splitTrailer(body: Uint8Array): SplitBody {
  const n = body.length;
  if (n >= 4 && body[n - 1] === 0 && body[n - 2] === 0 && body[n - 3] === 0) {
    return { payload: body.subarray(0, n - 4), msgType: body[n - 4]! };
  }
  return { payload: body, msgType: null };
}

/** Observed trailer message types (provisional; names describe what was seen). */
export const MSG = {
  /** Reply to a dump request: full state, optionally with capture/preset/IR lists. */
  DUMP: 0x02,
  /** Knob-value event family (`… 30 01 1A 00 00 00`). */
  KNOB: 0x1a,
  /** Footswitch encoder / bank button (`… 1C 00 00 00`). */
  ENCODER: 0x1c,
  /** Preset changed: field 4 = preset index, 5/6/7/8 = footswitch IA/IB/IIA/IIB. */
  PRESET_CHANGED: 0x1d,
  /**
   * Preset-change acknowledgement: we send `06 C0 20 01 1E 00 00 00` after a MIDI Program
   * Change; the pedal sends `08 C0 08 01 20 01 1E 00 00 00` after a c304 preset select.
   */
  PRESET_ACK_REQUEST: 0x1e,
  /** FX / gate bypass changed. */
  BYPASS_CHANGED: 0x1f,
  /** Expression pedal position, ~20/s while moving: field 3 = 2, field 4 = 0–254 (2026-09-19). */
  EXPRESSION: 0x40,
  /** Read a preset's expression assignments (we send this; Cortex Cloud does too). */
  EXP_ASSIGN_REQUEST: 0x3c,
  /** Reply: a sub-message `{2: min, 3: max}` per assigned slot. */
  EXP_ASSIGN_REPLY: 0x3d,
  /** Write a preset's expression assignments (Cortex Cloud; not sent by NanoGig). */
  EXP_ASSIGN_WRITE: 0x3e,
  /** Ack to the assignment write. */
  EXP_ASSIGN_ACK: 0x3f,
  /** Parameter values produced by the expression pedal, one field per assigned slot. */
  EXPRESSION_VALUES: 0xaa,
  /** Device-settings request (we send this; Cortex Cloud does too). */
  SETTINGS_REQUEST: 0x41,
  /** Reply to the device-settings request (60 B on 2.2.1). */
  SETTINGS: 0x42,
  /** Outputs 1/2 mute write (we send this). */
  OUTPUTS_MUTE_REQUEST: 0x43,
  /** Ack to the outputs-mute write: `08 C0 08 01 18 01 44 00 00 00`. */
  OUTPUTS_MUTE_ACK: 0x44,
  /** Tuner on/off write (we send this; Cortex Cloud does too). */
  TUNER_REQUEST: 0x7f,
  /** Tuner pitch event, streamed while a note is detected. */
  TUNER_PITCH: 0x80,
} as const;

// ---------------------------------------------------------------------------
// Legacy heuristics from the reference projects (fallback only)
// ---------------------------------------------------------------------------

export const LEGACY_STREAM_START_BYTES = new Set([0xfe, 0xfd, 0xce, 0xd0]);

/** `<len> C0 …` with len === data.length - 2 (single-frame convention). */
export function isLengthPrefixedCommandFrame(data: Uint8Array): boolean {
  return data.length >= 4 && data[1] === 0xc0 && data[0] === data.length - 2;
}

/** Single-packet FX float-param refresh reply: `.. C0 08 06 22 <len> <f32…>`. */
export function isFxParamReply(data: Uint8Array): boolean {
  return data.length >= 10 && data[1] === 0xc0 && data[2] === 0x08 && data[3] === 0x06 && data[4] === 0x22;
}

/** Single-packet cab/IR param refresh reply: `8E C0 08 06 …`. */
export function isCabParamReply(data: Uint8Array): boolean {
  return data.length > 20 && data[0] === 0x8e && data[1] === 0xc0 && data[2] === 0x08 && data[3] === 0x06;
}

export type PacketKind = 'empty' | 'fx-param-reply' | 'cab-param-reply' | 'message' | 'fragment';

/**
 * Classify a packet. `open` says whether a multi-packet message is currently
 * being assembled (affects only the legacy fallback rules).
 */
export function classifyPacket(data: Uint8Array, open = false): PacketKind {
  if (data.length === 0) return 'empty';
  if (isCabParamReply(data)) return 'cab-param-reply';
  if (isFxParamReply(data)) return 'fx-param-reply';
  const h = parseFrameHeader(data);
  if (h) return h.start && h.end ? 'message' : 'fragment';
  // Header did not validate — fall back to the reference heuristics.
  if (data.length >= 3 && LEGACY_STREAM_START_BYTES.has(data[0]!)) return 'fragment';
  if (open && data.length >= 3 && (data[1]! & 0x80) === 0x80 && !isLengthPrefixedCommandFrame(data)) return 'fragment';
  return 'message';
}

export interface AssemblerOptions {
  onMessage: (body: Uint8Array, meta: { packets: number; complete: boolean }) => void;
  /** Flush an unterminated message after this much silence (fail-soft). */
  inactivityMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export const DEFAULT_INACTIVITY_MS = 2500;

/** Assembles START … END fragment sequences into message bodies. */
export class MessageAssembler {
  private buffer: number[] = [];
  private packets = 0;
  private timer: unknown = null;
  private readonly onMessage: AssemblerOptions['onMessage'];
  private readonly inactivityMs: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(opts: AssemblerOptions) {
    this.onMessage = opts.onMessage;
    this.inactivityMs = opts.inactivityMs ?? DEFAULT_INACTIVITY_MS;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get open(): boolean {
    return this.packets > 0;
  }

  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** Feed a packet classified as `fragment` (or a complete `message`; it is emitted at once). */
  push(data: Uint8Array): void {
    const h = parseFrameHeader(data);
    if (h?.start && this.open) {
      // A new message started before the previous one terminated: flush the partial one.
      this.flush(false);
    }
    for (let i = 2; i < data.length; i++) this.buffer.push(data[i]!);
    this.packets += 1;
    if (h?.end) {
      this.flush(true);
      return;
    }
    this.arm();
  }

  private arm() {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = this.setT(() => this.flush(false), this.inactivityMs);
  }

  /** Emit what has been collected. `complete` = terminated by an END flag. */
  flush(complete = false): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    if (this.buffer.length === 0) {
      this.packets = 0;
      return;
    }
    const body = Uint8Array.from(this.buffer);
    const meta = { packets: this.packets, complete };
    this.buffer = [];
    this.packets = 0;
    this.onMessage(body, meta);
  }

  /** Drop any partial message. */
  cancel(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    this.buffer = [];
    this.packets = 0;
  }
}
