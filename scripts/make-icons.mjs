#!/usr/bin/env node
// Renders the SwiftGet icon (rounded square + download arrow) to PNGs without image tools.
// Usage: node scripts/make-icons.mjs  -> public/icon/{16,32,48,128}.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape in unit coordinates, supersampled 4x4 for anti-aliasing.
function inside(u, v) {
  const r = 0.22;
  const dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - r));
  const dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - r));
  if (dx * dx + dy * dy > r * r) return 0; // outside rounded square
  const shaft = Math.abs(u - 0.5) < 0.09 && v > 0.2 && v < 0.56;
  const head = v >= 0.5 && v < 0.72 && Math.abs(u - 0.5) < 0.24 - (v - 0.5) * 1.09;
  const bar = v > 0.77 && v < 0.85 && Math.abs(u - 0.5) < 0.27;
  return shaft || head || bar ? 2 : 1;
}
const pixel = (x, y, size) => {
  let bg = 0;
  let fg = 0;
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      const s = inside((x + (i + 0.5) / 4) / size, (y + (j + 0.5) / 4) / size);
      if (s === 1) bg++;
      if (s === 2) fg++;
    }
  const a = (bg + fg) / 16;
  if (a === 0) return [0, 0, 0, 0];
  const t = fg / (bg + fg);
  const mix = (c1, c2) => Math.round(c1 * (1 - t) + c2 * t);
  return [mix(26, 255), mix(115, 255), mix(232, 255), Math.round(a * 255)];
};

mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icon/${size}.png`, png(size, pixel));
writeFileSync('site/icon.png', png(128, pixel));
console.log('icons written');
