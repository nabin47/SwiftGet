import { createHash } from 'node:crypto';

/**
 * Deterministic pseudo-random file content with random access:
 * byte i depends only on (seed, i), so any range can be generated on demand.
 */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Fills `out` with content bytes starting at absolute `offset`. */
export function fillContent(out: Uint8Array, offset: number, seed: number): void {
  for (let i = 0; i < out.length; ) {
    const abs = offset + i;
    const word = Math.floor(abs / 4);
    const v = mix32((seed * 0x9e3779b1) ^ word ^ Math.floor(word / 0x100000000));
    for (let b = abs % 4; b < 4 && i < out.length; b++, i++) out[i] = (v >>> (b * 8)) & 0xff;
  }
}

export function content(offset: number, length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  fillContent(out, offset, seed);
  return out;
}

const hashCache = new Map<string, string>();

export function contentSha256(size: number, seed: number): string {
  const key = `${size}:${seed}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const h = createHash('sha256');
  const block = new Uint8Array(4 * 1024 * 1024);
  for (let off = 0; off < size; off += block.length) {
    const n = Math.min(block.length, size - off);
    const view = block.subarray(0, n);
    fillContent(view, off, seed);
    h.update(view);
  }
  const hex = h.digest('hex');
  hashCache.set(key, hex);
  return hex;
}
