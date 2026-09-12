import { describe, expect, it } from 'vitest';
import { PacketDeduper } from '../src/transport/dedupe';
import { fromHex } from '../src/protocol/hex';

describe('PacketDeduper (c305/c306 mirror suppression)', () => {
  it('drops an identical payload from the other characteristic inside the window', () => {
    const d = new PacketDeduper(500);
    const pkt = fromHex('C0 05');
    expect(d.accept('c305', pkt, 1000)).toBe(true);
    expect(d.accept('c306', fromHex('C0 05'), 1100)).toBe(false);
  });
  it('keeps identical consecutive packets on the same characteristic', () => {
    const d = new PacketDeduper(500);
    expect(d.accept('c305', fromHex('C0 05'), 1000)).toBe(true);
    expect(d.accept('c305', fromHex('C0 05'), 1100)).toBe(true);
  });
  it('keeps different payloads and mirrors outside the window', () => {
    const d = new PacketDeduper(500);
    expect(d.accept('c305', fromHex('C0 05'), 1000)).toBe(true);
    expect(d.accept('c306', fromHex('C0 06'), 1100)).toBe(true);
    expect(d.accept('c305', fromHex('C0 06'), 1700)).toBe(true);
  });
  it('works in either direction (c306 first)', () => {
    const d = new PacketDeduper(500);
    expect(d.accept('c306', fromHex('FE 41 08'), 1000)).toBe(true);
    expect(d.accept('c305', fromHex('FE 41 08'), 1010)).toBe(false);
  });
});
