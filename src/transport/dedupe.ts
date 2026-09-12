import { bytesEqual } from '../protocol/hex';

/**
 * c306 (indicate) mirrors c305 (notify). Drop a payload that is identical to
 * the most recent packet from the *other* characteristic within the window.
 * Identical consecutive packets on the same characteristic are kept — the
 * device legitimately repeats events (e.g. a footswitch pressed twice).
 */
export class PacketDeduper {
  private last: { char: string; data: Uint8Array; at: number } | null = null;

  constructor(private readonly windowMs = 500) {}

  /** Returns true if the packet should be delivered, false if it is a mirror. */
  accept(char: string, data: Uint8Array, at: number): boolean {
    const last = this.last;
    if (last && last.char !== char && at - last.at <= this.windowMs && bytesEqual(last.data, data)) {
      return false;
    }
    this.last = { char, data, at };
    return true;
  }

  reset(): void {
    this.last = null;
  }
}
