import {
  httpError,
  isAbortError,
  SwiftGetError,
  toSwiftGetError,
} from './errors';
import {
  ifRangeValidator,
  parseContentRange,
  requestInit,
  type ProbeResult,
  type RequestContext,
} from './probe';

/** Random-access destination. OPFS sync handles in the browser, fs handles in tests. */
export interface Sink {
  write(offset: number, data: Uint8Array): void | Promise<void>;
}

export interface ChunkState {
  /** First byte, inclusive. */
  start: number;
  /** Last byte, inclusive. */
  end: number;
  /** Next byte to fetch; the chunk is done when pos > end. */
  pos: number;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
  chunks: ChunkState[];
  activeConnections: number;
}

export interface DownloadOptions extends RequestContext {
  url: string;
  probe: ProbeResult;
  sink: Sink;
  /** Parallel connections for range-capable servers. Clamped to 1..16. */
  connections?: number;
  /** Don't split below this many bytes per chunk. */
  minChunkSize?: number;
  /** Retries per chunk without progress before giving up. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Bytes buffered per connection before writing to the sink. */
  writeBufferSize?: number;
  onProgress?: (p: DownloadProgress) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface DownloadResult {
  bytes: number;
  chunks: ChunkState[];
  rangeUsed: boolean;
}

export const MAX_CONNECTIONS = 16;
export const DEFAULT_CONNECTIONS = 4;

export function planChunks(total: number, connections: number, minChunkSize: number): ChunkState[] {
  if (total <= 0) return [];
  const n = Math.max(1, Math.min(connections, Math.ceil(total / Math.max(1, minChunkSize))));
  const base = Math.floor(total / n);
  const chunks: ChunkState[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = i < total % n ? base + 1 : base;
    chunks.push({ start, end: start + size - 1, pos: start });
    start += size;
  }
  return chunks;
}

export function backoffDelay(attempt: number, baseMs: number, maxMs: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(maxMs, retryAfterMs);
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  // Full jitter keeps parallel connections from retrying in lockstep.
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SwiftGetError('ABORTED', 'Download was cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SwiftGetError('ABORTED', 'Download was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Downloads `probe.totalSize` bytes using parallel ranged GETs into `sink`,
 * or a single plain GET when the server lacks range support.
 */
export async function download(opts: DownloadOptions): Promise<DownloadResult> {
  const total = opts.probe.totalSize;
  const useRanges = opts.probe.rangeSupported && total !== null && total > 0;
  const internal = new AbortController();
  const onOuterAbort = () => internal.abort(opts.signal?.reason);
  if (opts.signal?.aborted) throw new SwiftGetError('ABORTED', 'Download was cancelled');
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const run = new Transfer(opts, internal.signal);
  try {
    if (useRanges) {
      const connections = Math.max(1, Math.min(MAX_CONNECTIONS, opts.connections ?? DEFAULT_CONNECTIONS));
      run.chunks = planChunks(total, connections, opts.minChunkSize ?? 1024 * 1024);
      await Promise.all(
        run.chunks.map((c) =>
          run.rangeWorker(c).catch((e: unknown) => {
            // One fatal chunk error stops the whole transfer.
            internal.abort(e);
            throw e;
          }),
        ),
      );
    } else {
      await run.singleStream();
    }
  } catch (e) {
    // Report the root cause, not the AbortErrors it triggered in sibling chunks.
    const reason: unknown = internal.signal.reason;
    if (opts.signal?.aborted) throw new SwiftGetError('ABORTED', 'Download was cancelled');
    if (reason instanceof SwiftGetError) throw reason;
    throw toSwiftGetError(e);
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }

  const bytes = run.downloaded;
  if (total !== null && bytes !== total) {
    throw new SwiftGetError('SIZE_MISMATCH', `Expected ${total} bytes but received ${bytes}`);
  }
  return { bytes, chunks: run.chunks, rangeUsed: useRanges };
}

class Transfer {
  chunks: ChunkState[] = [];
  downloaded = 0;
  active = 0;
  private readonly fetch: typeof fetch;
  private readonly sleep: NonNullable<DownloadOptions['sleep']>;
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly bufSize: number;
  private readonly validator: string | undefined;

  constructor(
    private readonly opts: DownloadOptions,
    private readonly signal: AbortSignal,
  ) {
    // Never call fetch as a method: browsers throw "Illegal invocation" unless `this` is the global.
    const f = opts.fetch ?? globalThis.fetch;
    this.fetch = (input, init) => f(input, init);
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 6;
    this.baseDelay = opts.retryBaseDelayMs ?? 500;
    this.maxDelay = opts.retryMaxDelayMs ?? 30_000;
    this.bufSize = opts.writeBufferSize ?? 1024 * 1024;
    this.validator = ifRangeValidator(opts.probe);
  }

  private get url(): string {
    // The final URL skips redirect hops; Drive/CDN redirects are often to signed URLs.
    return this.opts.probe.finalUrl || this.opts.url;
  }

  private progress(): void {
    this.opts.onProgress?.({
      downloaded: this.downloaded,
      total: this.opts.probe.totalSize,
      chunks: this.chunks,
      activeConnections: this.active,
    });
  }

  /** Retries `attempt` with backoff; the failure counter resets whenever bytes arrive. */
  private async withRetries(attempt: () => Promise<void>, madeProgress: () => boolean): Promise<void> {
    let failures = 0;
    for (;;) {
      try {
        await attempt();
        return;
      } catch (e) {
        if (this.signal.aborted || isAbortError(e)) throw e;
        const err = toSwiftGetError(e);
        if (!err.retryable) throw err;
        failures = madeProgress() ? 1 : failures + 1;
        if (failures > this.maxRetries) throw err;
        await this.sleep(backoffDelay(failures, this.baseDelay, this.maxDelay, err.retryAfterMs), this.signal);
      }
    }
  }

  async rangeWorker(chunk: ChunkState): Promise<void> {
    let lastPos = chunk.pos;
    const progressed = () => {
      const p = chunk.pos > lastPos;
      lastPos = chunk.pos;
      return p;
    };
    await this.withRetries(async () => {
      if (chunk.pos > chunk.end) return;
      const headers: Record<string, string> = { Range: `bytes=${chunk.pos}-${chunk.end}` };
      if (this.validator) headers['If-Range'] = this.validator;
      this.active++;
      try {
        const res = await this.fetch(this.url, requestInit(this.opts, { headers, signal: this.signal }));
        if (res.status === 200) {
          res.body?.cancel().catch(() => {});
          // If-Range mismatch (or range support vanished): the bytes we hold may be stale.
          throw new SwiftGetError('FILE_CHANGED', 'The file changed on the server (range request returned 200)');
        }
        if (res.status !== 206) {
          res.body?.cancel().catch(() => {});
          throw httpError(res);
        }
        const cr = parseContentRange(res.headers.get('content-range'));
        if (!cr || cr.start !== chunk.pos || (cr.total !== null && cr.total !== this.opts.probe.totalSize)) {
          res.body?.cancel().catch(() => {});
          throw new SwiftGetError('BAD_RANGE', `Unexpected Content-Range: ${res.headers.get('content-range')}`);
        }
        await this.pump(res, chunk);
        if (chunk.pos <= chunk.end) {
          throw new SwiftGetError('NETWORK', 'Connection closed early', { retryable: true });
        }
      } finally {
        this.active--;
      }
    }, progressed);
  }

  async singleStream(): Promise<void> {
    const total = this.opts.probe.totalSize;
    const chunk: ChunkState = { start: 0, end: total !== null ? total - 1 : Number.MAX_SAFE_INTEGER, pos: 0 };
    this.chunks = [chunk];
    await this.withRetries(
      async () => {
        // No ranges: every retry starts over from byte 0.
        this.downloaded -= chunk.pos;
        chunk.pos = 0;
        this.active++;
        try {
          const res = await this.fetch(this.url, requestInit(this.opts, { signal: this.signal }));
          if (!res.ok) {
            res.body?.cancel().catch(() => {});
            throw httpError(res);
          }
          await this.pump(res, chunk);
          if (total !== null && chunk.pos < total) {
            throw new SwiftGetError('NETWORK', 'Connection closed early', { retryable: true });
          }
          if (total === null) chunk.end = chunk.pos - 1;
        } finally {
          this.active--;
        }
      },
      () => false,
    );
  }

  /** Streams the body into the sink, buffering to cut per-write overhead. */
  private async pump(res: Response, chunk: ChunkState): Promise<void> {
    if (!res.body) throw new SwiftGetError('NETWORK', 'Empty response body', { retryable: true });
    const reader = res.body.getReader();
    const buf = new Uint8Array(this.bufSize);
    let fill = 0;
    let bufStart = chunk.pos;
    const flush = async () => {
      if (fill === 0) return;
      await this.opts.sink.write(bufStart, buf.subarray(0, fill));
      chunk.pos = bufStart + fill;
      this.downloaded += fill;
      bufStart = chunk.pos;
      fill = 0;
      this.progress();
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let data = value;
        const remaining = chunk.end - (bufStart + fill) + 1;
        if (data.length > remaining) data = data.subarray(0, remaining);
        let off = 0;
        while (off < data.length) {
          const n = Math.min(buf.length - fill, data.length - off);
          buf.set(data.subarray(off, off + n), fill);
          fill += n;
          off += n;
          if (fill === buf.length) await flush();
        }
        if (bufStart + fill > chunk.end) break;
      }
      await flush();
    } catch (e) {
      // Keep the bytes that did arrive so the retry resumes after them.
      await flush();
      throw e;
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
