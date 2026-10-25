export type ErrorCode =
  | 'HTTP'
  | 'NETWORK'
  | 'ABORTED'
  | 'FILE_CHANGED'
  | 'BAD_RANGE'
  | 'SIZE_MISMATCH'
  | 'DRIVE_QUOTA'
  | 'DRIVE_ACCESS'
  | 'DRIVE_UNRECOGNIZED'
  | 'DRIVE_NOT_FILE'
  | 'STORAGE';

export class SwiftGetError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  /** Whether retrying the same request may succeed. */
  readonly retryable: boolean;
  /** Server-suggested wait before retrying, in ms. */
  readonly retryAfterMs?: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'SwiftGetError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Statuses worth retrying with backoff. 403 is included because Drive/CDNs use it for throttling. */
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

export function httpError(res: Response): SwiftGetError {
  return new SwiftGetError('HTTP', `Server responded ${res.status} ${res.statusText}`.trim(), {
    status: res.status,
    retryable: RETRYABLE_STATUS.has(res.status),
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
  });
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof SwiftGetError && e.code === 'ABORTED') ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
  );
}

/** Normalizes anything thrown during a transfer into a SwiftGetError. */
export function toSwiftGetError(e: unknown): SwiftGetError {
  if (e instanceof SwiftGetError) return e;
  if (isAbortError(e)) return new SwiftGetError('ABORTED', 'Download was cancelled', { cause: e });
  const msg = e instanceof Error ? e.message : String(e);
  // fetch() rejects with TypeError for network failures; stream reads can fail with various errors.
  return new SwiftGetError('NETWORK', `Network error: ${msg}`, { retryable: true, cause: e });
}
