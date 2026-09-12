/** Hex helpers shared by transport, protocol and UI code. */

export function toHex(bytes: ArrayLike<number>, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`odd hex length: ${text}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: ArrayLike<number>[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(Array.from(p), offset);
    offset += p.length;
  }
  return out;
}

export function printableAscii(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
}
