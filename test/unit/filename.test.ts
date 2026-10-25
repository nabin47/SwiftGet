import { describe, expect, it } from 'vitest';
import { filenameFromUrl, parseContentDisposition, pickFilename, sanitizeFilename } from '../../src/engine/filename';

describe('parseContentDisposition', () => {
  it.each([
    ['attachment; filename="report.pdf"', 'report.pdf'],
    ['attachment; filename=report.pdf', 'report.pdf'],
    ["attachment; filename=\"x.bin\"; filename*=UTF-8''h%C3%A9llo%20w.bin", 'héllo w.bin'],
    ["attachment; filename*=utf-8''%E6%97%A5%E6%9C%AC.txt", '日本.txt'],
    ["attachment; filename*=iso-8859-1'en'%E9t%E9.txt", 'été.txt'],
    ['attachment; filename="with \\"quotes\\".txt"', 'with "quotes".txt'],
    ['inline', undefined],
    [null, undefined],
  ])('%s', (header, expected) => {
    expect(parseContentDisposition(header)).toBe(expected);
  });

  it('decodes raw UTF-8 that arrived as latin1', () => {
    const raw = String.fromCharCode(...new TextEncoder().encode('naïve.txt'));
    expect(parseContentDisposition(`attachment; filename="${raw}"`)).toBe('naïve.txt');
  });
});

describe('sanitizeFilename', () => {
  it('replaces illegal characters and trims dots', () => {
    expect(sanitizeFilename('a/b\\c:d*e?.txt')).toBe('a_b_c_d_e_.txt');
    expect(sanitizeFilename('..hidden..')).toBe('hidden');
    expect(sanitizeFilename('  ')).toBe('download');
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
  });
  it('keeps the extension when truncating', () => {
    const s = sanitizeFilename(`${'x'.repeat(300)}.tar.gz`);
    expect(s.length).toBeLessThanOrEqual(180);
    expect(s.endsWith('.gz')).toBe(true);
  });
});

describe('pickFilename', () => {
  it('prefers Content-Disposition, then final URL, then URL', () => {
    expect(pickFilename({ contentDisposition: 'attachment; filename=a.zip', url: 'https://x/b.zip' })).toBe('a.zip');
    expect(pickFilename({ finalUrl: 'https://cdn/c%20d.zip?sig=1', url: 'https://x/b.zip' })).toBe('c d.zip');
    expect(pickFilename({ url: 'https://x/' })).toBe('download');
    expect(filenameFromUrl('not a url')).toBeUndefined();
  });
});
