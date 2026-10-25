import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backoffDelay, download, planChunks } from '../../src/engine/downloader';
import { SwiftGetError } from '../../src/engine/errors';
import { parseContentRange, parseSha256Digest, probe } from '../../src/engine/probe';
import { contentSha256 } from '../server/content';
import { startTestServer, type TestServer } from '../server/server';
import { fileSink, growableSink, memorySink, noSleep } from './helpers';

let server: TestServer;
const MB = 1024 * 1024;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => server.reset());

const fileUrl = (params: Record<string, string | number>) =>
  `${server.url}/file?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

async function fetchAll(url: string, opts: Partial<Parameters<typeof download>[0]> = {}) {
  const p = await probe(url);
  const sink = memorySink(p.totalSize!);
  const result = await download({ url, probe: p, sink, sleep: noSleep, ...opts });
  return { p, sink, result };
}

describe('probe', () => {
  it('detects range support, size, validators and filename', async () => {
    const p = await probe(fileUrl({ size: 12345, name: 'héllo wörld.bin' }));
    expect(p).toMatchObject({
      status: 206,
      totalSize: 12345,
      rangeSupported: true,
      filename: 'héllo wörld.bin',
      method: 'range',
      etag: '"s1-12345"',
    });
    expect(p.lastModified).toBeTruthy();
  });

  it('reports no range support when the server ignores Range', async () => {
    const p = await probe(fileUrl({ size: 5000, noRange: 1 }));
    expect(p).toMatchObject({ status: 200, totalSize: 5000, rangeSupported: false });
  });

  it('follows redirects and reports the final URL', async () => {
    const target = `/file?size=100&name=r.bin`;
    const p = await probe(`${server.url}/redirect?to=${encodeURIComponent(target)}`);
    expect(p.finalUrl).toBe(`${server.url}${target}`);
    expect(p.totalSize).toBe(100);
  });

  it('reads a sha-256 Repr-Digest', async () => {
    const p = await probe(fileUrl({ size: 1000, digest: 1 }));
    expect(p.sha256).toBe(contentSha256(1000, 1));
  });

  it('throws HTTP errors for expired URLs', async () => {
    await expect(probe(fileUrl({ size: 10, expires: Date.now() - 1000 }))).rejects.toMatchObject({
      code: 'HTTP',
      status: 403,
    });
  });

  it('parses Content-Range and digests', () => {
    expect(parseContentRange('bytes 0-0/99')).toEqual({ start: 0, end: 0, total: 99 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ start: 5, end: 9, total: null });
    expect(parseContentRange('garbage')).toBeNull();
    expect(parseSha256Digest('sha-512=:abc:')).toBeUndefined();
  });
});

describe('planChunks', () => {
  it('splits evenly and covers every byte exactly once', () => {
    for (const [total, n, min] of [
      [10, 4, 1],
      [1, 4, 1],
      [1000, 16, 100],
      [7 * MB + 3, 4, MB],
    ] as const) {
      const chunks = planChunks(total, n, min);
      expect(chunks[0]!.start).toBe(0);
      expect(chunks.at(-1)!.end).toBe(total - 1);
      for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end + 1);
      expect(chunks.length).toBeLessThanOrEqual(n);
      expect(chunks.length).toBe(Math.min(n, Math.ceil(total / min)));
    }
    expect(planChunks(0, 4, 1)).toEqual([]);
  });

  it('backoff grows exponentially, is capped, and honors Retry-After', () => {
    expect(backoffDelay(1, 100, 10_000)).toBeLessThanOrEqual(100);
    expect(backoffDelay(4, 100, 10_000)).toBeGreaterThanOrEqual(400);
    expect(backoffDelay(30, 100, 10_000)).toBeLessThanOrEqual(10_000);
    expect(backoffDelay(3, 100, 10_000, 1234)).toBe(1234);
  });
});

describe('download', () => {
  it('fetches 4 parallel ranges and the hash matches', async () => {
    const size = 8 * MB + 17;
    const url = fileUrl({ size, seed: 7, key: 'par4' });
    const { sink, result } = await fetchAll(url, { connections: 4, minChunkSize: MB });
    expect(result.rangeUsed).toBe(true);
    expect(result.bytes).toBe(size);
    expect(sink.sha256()).toBe(contentSha256(size, 7));
    const ranged = server.stats('par4').filter((r) => r.range && r.range !== 'bytes=0-0');
    expect(ranged).toHaveLength(4);
    expect(ranged.every((r) => r.status === 206 && r.ifRange === '"s7-8388625"')).toBe(true);
  });

  it('uses Last-Modified for If-Range when the ETag is weak', async () => {
    const url = fileUrl({ size: 2 * MB, etag: 'weak', key: 'weak' });
    await fetchAll(url, { connections: 2, minChunkSize: MB });
    const ranged = server.stats('weak').filter((r) => r.range !== 'bytes=0-0');
    expect(ranged[0]!.ifRange).toMatch(/GMT$/);
  });

  it('falls back to a single stream without range support', async () => {
    const size = 3 * MB;
    const url = fileUrl({ size, noRange: 1, key: 'norange' });
    const { sink, result } = await fetchAll(url, { connections: 8 });
    expect(result.rangeUsed).toBe(false);
    expect(sink.sha256()).toBe(contentSha256(size, 1));
  });

  it('handles unknown length (chunked, no ranges)', async () => {
    const size = 2 * MB + 5;
    const url = fileUrl({ size, noRange: 1, noLength: 1 });
    const p = await probe(url);
    expect(p.totalSize).toBeNull();
    const sink = growableSink();
    const result = await download({ url, probe: p, sink, sleep: noSleep });
    expect(result.bytes).toBe(size);
    expect(sink.sha256()).toBe(contentSha256(size, 1));
  });

  it('resumes each chunk after dropped connections', async () => {
    const size = 6 * MB;
    // Every response is cut after 700 KB for the first 6 responses.
    const url = fileUrl({ size, dropAfter: 700_000, dropTimes: 6, key: 'drop' });
    const { sink } = await fetchAll(url, { connections: 4, minChunkSize: MB });
    expect(sink.sha256()).toBe(contentSha256(size, 1));
    const resumed = server.stats('drop').filter((r) => r.range && !/^bytes=(0|1572864|3145728|4718592)-/.test(r.range));
    expect(resumed.length).toBeGreaterThan(0);
  });

  it('restarts the single stream from zero when a no-range connection drops', async () => {
    const size = 2 * MB;
    const url = fileUrl({ size, noRange: 1, dropAfter: 500_000, dropTimes: 2 });
    const { sink } = await fetchAll(url);
    expect(sink.sha256()).toBe(contentSha256(size, 1));
  });

  it('retries 503 and 429 with backoff', async () => {
    for (const status of [503, 429]) {
      const url = fileUrl({ size: 2 * MB, fail: status, failTimes: 3, key: `fail${status}` });
      const { sink } = await fetchAll(url, { connections: 2, minChunkSize: MB });
      expect(sink.sha256()).toBe(contentSha256(2 * MB, 1));
    }
  });

  it('gives up after maxRetries', async () => {
    const url = fileUrl({ size: MB, fail: 503, failTimes: 100 });
    const p = await probe(fileUrl({ size: MB }));
    await expect(
      download({ url, probe: { ...p, finalUrl: url }, sink: memorySink(MB), sleep: noSleep, maxRetries: 2 }),
    ).rejects.toMatchObject({ code: 'HTTP', status: 503 });
  });

  it('detects a file that changed mid-download via If-Range', async () => {
    // The probe is request 1; the content changes for every request after it.
    const url = fileUrl({ size: 2 * MB, changeAfter: 1, key: 'changed' });
    await expect(fetchAll(url, { connections: 2, minChunkSize: MB })).rejects.toMatchObject({ code: 'FILE_CHANGED' });
  });

  it('fails cleanly when the URL expires', async () => {
    const url = fileUrl({ size: MB, expires: Date.now() + 60_000 });
    const p = await probe(url);
    const expired = fileUrl({ size: MB, expires: Date.now() - 1 });
    await expect(
      download({ url: expired, probe: { ...p, finalUrl: expired }, sink: memorySink(MB), sleep: noSleep, maxRetries: 1 }),
    ).rejects.toMatchObject({ code: 'HTTP', status: 403 });
  });

  it('can be cancelled', async () => {
    const url = fileUrl({ size: 4 * MB, throttle: 256 * 1024 });
    const p = await probe(url);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await download({ url, probe: p, sink: memorySink(4 * MB), signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwiftGetError);
    expect((err as SwiftGetError).code).toBe('ABORTED');
  });

  it('reports progress that ends at the total', async () => {
    const seen: number[] = [];
    const size = 3 * MB;
    await fetchAll(fileUrl({ size }), { connections: 3, minChunkSize: MB, onProgress: (p) => seen.push(p.downloaded) });
    expect(seen.at(-1)).toBe(size);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('streams a large file to disk at 16 connections with a matching hash', async () => {
    const size = 256 * MB + 1;
    const url = fileUrl({ size, seed: 42 });
    const p = await probe(url);
    const sink = await fileSink();
    try {
      await download({ url, probe: p, sink, connections: 16, minChunkSize: MB });
      expect(await sink.sha256()).toBe(contentSha256(size, 42));
    } finally {
      await sink.close();
    }
  });
});
