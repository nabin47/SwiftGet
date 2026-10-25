import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from '../../src/engine/sha256';

const ref = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('Sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto for all padding boundaries', () => {
    for (let n = 0; n < 200; n++) {
      const b = randomBytes(n);
      expect(sha256Hex(b)).toBe(ref(b));
    }
  });

  it('gives the same digest regardless of how input is split', () => {
    const b = randomBytes(100_000);
    const h = new Sha256();
    let off = 0;
    for (const step of [1, 63, 64, 65, 1000, 4096, 7]) {
      while (off < b.length && Math.random() < 0.9) {
        h.update(b.subarray(off, off + step));
        off += step;
      }
    }
    h.update(b.subarray(off));
    expect(h.hex()).toBe(ref(b));
  });
});
