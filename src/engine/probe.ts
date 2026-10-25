import { httpError, toSwiftGetError } from './errors';
import { pickFilename } from './filename';

export type FetchFn = typeof fetch;

export interface RequestContext {
  fetch?: FetchFn;
  /** Extra request headers (e.g. Authorization). Referer/Origin are set via DNR, not here. */
  headers?: Record<string, string>;
  /** 'include' sends the user's cookies so signed-in downloads work. */
  credentials?: RequestCredentials;
  signal?: AbortSignal;
}

export interface ProbeResult {
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  /** Total size in bytes, or null when the server does not say. */
  totalSize: number | null;
  rangeSupported: boolean;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  contentDisposition?: string;
  filename: string;
  /** Hex SHA-256 the server advertised via Repr-Digest/Digest, if any. */
  sha256?: string;
  /** Which request produced the answer. */
  method: 'range' | 'head';
}

/** Parses "bytes 0-0/12345". Returns null for unparseable input; total is null for "*". */
export function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? null : Number(m[3]),
  };
}

/** Reads sha-256 from `Repr-Digest: sha-256=:b64:` (RFC 9530) or legacy `Digest: SHA-256=b64`. */
export function parseSha256Digest(value: string | null): string | undefined {
  if (!value) return undefined;
  const m = /sha-256\s*=\s*:?([A-Za-z0-9+/=]+):?/i.exec(value);
  if (!m) return undefined;
  try {
    const bin = atob(m[1]!);
    if (bin.length !== 32) return undefined;
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

function parseLength(v: string | null): number | null {
  if (v == null || !/^\d+$/.test(v.trim())) return null;
  return Number(v);
}

export function requestInit(ctx: RequestContext, extra: RequestInit = {}): RequestInit {
  return {
    credentials: ctx.credentials ?? 'include',
    redirect: 'follow',
    cache: 'no-store',
    signal: ctx.signal,
    ...extra,
    headers: { ...ctx.headers, ...(extra.headers as Record<string, string> | undefined) },
  };
}

function discardBody(res: Response): void {
  // Don't download the body we didn't ask for (a 200 to a range probe could be gigabytes).
  res.body?.cancel().catch(() => {});
}

function resultFrom(url: string, res: Response, method: ProbeResult['method']): ProbeResult {
  const h = res.headers;
  const cr = parseContentRange(h.get('content-range'));
  const rangeSupported = res.status === 206 && cr !== null && cr.total !== null;
  const totalSize = rangeSupported ? cr!.total : parseLength(h.get('content-length'));
  const finalUrl = res.url || url;
  const contentDisposition = h.get('content-disposition') ?? undefined;
  return {
    url,
    finalUrl,
    status: res.status,
    totalSize,
    rangeSupported,
    etag: h.get('etag') ?? undefined,
    lastModified: h.get('last-modified') ?? undefined,
    contentType: h.get('content-type') ?? undefined,
    contentDisposition,
    filename: pickFilename({ contentDisposition, finalUrl, url }),
    sha256: parseSha256Digest(h.get('repr-digest') ?? h.get('digest')),
    method,
  };
}

/**
 * Discovers size, range support and validators.
 * Uses `Range: bytes=0-0` (a 1-byte GET, which works on servers that mishandle HEAD) and falls back to HEAD.
 */
export async function probe(
  url: string,
  ctx: RequestContext & { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ProbeResult> {
  const maxRetries = ctx.maxRetries ?? 3;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await probeOnce(url, ctx);
    } catch (e) {
      const err = toSwiftGetError(e);
      if (!err.retryable || attempt > maxRetries || ctx.signal?.aborted) throw err;
      await sleep(Math.min(10_000, err.retryAfterMs ?? 500 * 2 ** (attempt - 1)));
    }
  }
}

async function probeOnce(url: string, ctx: RequestContext): Promise<ProbeResult> {
  const f = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, requestInit(ctx, { headers: { Range: 'bytes=0-0' } }));
  } catch (e) {
    throw toSwiftGetError(e);
  }

  if (res.status === 206 || res.status === 200) {
    discardBody(res);
    const r = resultFrom(url, res, 'range');
    // A 206 with a bogus Content-Range: treat as no range support, but keep what we learned.
    if (res.status === 206 && !r.rangeSupported) r.totalSize = null;
    return r;
  }
  discardBody(res);

  // 416 can come from empty files; other errors may be range-specific server bugs. Try HEAD.
  if (res.status === 416 || res.status === 405 || res.status === 501 || res.status >= 500) {
    let head: Response;
    try {
      head = await f(url, requestInit(ctx, { method: 'HEAD' }));
    } catch (e) {
      throw toSwiftGetError(e);
    }
    if (head.ok) {
      const r = resultFrom(url, head, 'head');
      // HEAD can't confirm ranges; Accept-Ranges is a hint we trust only with a known size.
      r.rangeSupported =
        r.totalSize !== null && /bytes/i.test(head.headers.get('accept-ranges') ?? '');
      return r;
    }
    throw httpError(head);
  }
  throw httpError(res);
}

export function isHtml(p: Pick<ProbeResult, 'contentType'>): boolean {
  return /^\s*(text\/html|application\/xhtml)/i.test(p.contentType ?? '');
}

/** Picks the If-Range validator: a strong ETag, else Last-Modified. */
export function ifRangeValidator(p: Pick<ProbeResult, 'etag' | 'lastModified'>): string | undefined {
  if (p.etag && !p.etag.startsWith('W/')) return p.etag;
  return p.lastModified;
}

