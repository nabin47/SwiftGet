import { resolveDownload, driveDownloadUrl, isDriveHost, parseDriveLink } from '../engine/drive';
import { toSwiftGetError } from '../engine/errors';
import { ifRangeValidator, parseContentRange, probe, requestInit, type ProbeResult } from '../engine/probe';
import type { ProbeResponse } from '../shared/messages';
import { sendToBackground } from '../shared/messages';

/**
 * Drive diagnostics: measures how a real (Drive or other) download URL behaves, so engine
 * defaults are based on evidence. All requests use the user's own cookies; nothing is uploaded.
 */

export interface CheckResult {
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface ConnectionRun {
  connections: number;
  bytes: number;
  ms: number;
  mbps: number;
  statuses: Record<string, number>;
  errors: string[];
  ttfbMs: number[];
}

export interface CaptureResult {
  how: 'extension-triggered' | 'user-click';
  capturedUrl?: string;
  host?: string;
  reuse?: { status: number; rangeSupported: boolean; totalSize: number | null; sameSize: boolean };
  error?: string;
}

export interface DiagnosticsReport {
  version: string;
  browser: string;
  startedAt: string;
  input: string;
  isDrive: boolean;
  resolvedUrl?: string;
  steps: string[];
  probe?: Partial<ProbeResult>;
  checks: CheckResult[];
  capture: CaptureResult[];
  connections: ConnectionRun[];
  fatal?: string;
}

export interface DiagnosticsOptions {
  testBytes: number;
  connectionCounts: number[];
  nativeCapture: boolean;
  signal?: AbortSignal;
  log: (line: string) => void;
}

export function initialReport(input: string): DiagnosticsReport {
  return {
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    startedAt: new Date().toISOString(),
    input,
    isDrive: false,
    steps: [],
    checks: [],
    capture: [],
    connections: [],
  };
}

export async function runDiagnostics(
  input: string,
  opts: DiagnosticsOptions,
  onUpdate: (r: DiagnosticsReport) => void,
): Promise<DiagnosticsReport> {
  const report = initialReport(input);
  const update = () => onUpdate(structuredClone(report));
  const ctx = { credentials: 'include' as const, signal: opts.signal };
  try {
    const link = parseDriveLink(input);
    report.isDrive = link !== null || isDriveHost(input);
    const start = link && !input.includes('/download') ? driveDownloadUrl(link) : input.trim();
    opts.log(`Start URL: ${start}`);

    const { probe: p, steps } = await resolveDownload(start, { ...ctx, treatAsDrive: true });
    report.steps = steps;
    report.resolvedUrl = p.finalUrl;
    report.probe = {
      status: p.status,
      totalSize: p.totalSize,
      rangeSupported: p.rangeSupported,
      contentType: p.contentType,
      contentDisposition: p.contentDisposition,
      filename: p.filename,
      etag: p.etag,
      lastModified: p.lastModified,
      sha256: p.sha256,
      finalUrl: p.finalUrl,
    };
    report.checks.push({
      name: 'Range honored (206)',
      ok: p.rangeSupported,
      detail: `status ${p.status}, size ${p.totalSize ?? 'unknown'}`,
    });
    update();

    if (p.rangeSupported && p.totalSize) {
      report.checks.push(await tailRangeCheck(p, ctx));
      update();
      const v = ifRangeValidator(p);
      report.checks.push(
        v
          ? await ifRangeCheck(p, v, ctx)
          : { name: 'If-Range honored', ok: null, detail: 'No ETag/Last-Modified: resume cannot detect file changes' },
      );
      update();
    }

    report.checks.push(await engineContextCheck(p));
    update();

    if (opts.nativeCapture) {
      opts.log('Starting a native download to capture its URL (it is cancelled immediately)…');
      report.capture.push(await captureNative(p, opts.signal, () => chrome.downloads.download({ url: p.finalUrl })));
      update();
    }

    if (p.rangeSupported && p.totalSize) {
      for (const n of opts.connectionCounts) {
        opts.signal?.throwIfAborted();
        opts.log(`Measuring ${n} connection(s)…`);
        report.connections.push(await connectionRun(p, n, Math.min(opts.testBytes, p.totalSize), ctx));
        update();
        // Give the server a moment between runs so they don't skew each other.
        await new Promise((r) => setTimeout(r, 1500));
      }
    } else {
      opts.log('Skipping parallel tests: no range support.');
    }
  } catch (e) {
    const err = toSwiftGetError(e);
    report.fatal = `${err.code}: ${err.message}`;
    opts.log(`Stopped: ${report.fatal}`);
  }
  update();
  return report;
}

async function tailRangeCheck(p: ProbeResult, ctx: { signal?: AbortSignal }): Promise<CheckResult> {
  const last = p.totalSize! - 1;
  try {
    const res = await fetch(p.finalUrl, requestInit({ ...ctx }, { headers: { Range: `bytes=${last}-${last}` } }));
    const body = new Uint8Array(await res.arrayBuffer());
    const cr = parseContentRange(res.headers.get('content-range'));
    const ok = res.status === 206 && cr?.start === last && body.length === 1;
    return { name: 'Last byte reachable', ok, detail: `status ${res.status}, ${body.length} byte(s), ${res.headers.get('content-range')}` };
  } catch (e) {
    return { name: 'Last byte reachable', ok: false, detail: String(e) };
  }
}

async function ifRangeCheck(p: ProbeResult, validator: string, ctx: { signal?: AbortSignal }): Promise<CheckResult> {
  try {
    const res = await fetch(p.finalUrl, requestInit({ ...ctx }, { headers: { Range: 'bytes=0-0', 'If-Range': validator } }));
    res.body?.cancel().catch(() => {});
    return {
      name: 'If-Range honored',
      ok: res.status === 206,
      detail: `status ${res.status} using ${validator.startsWith('"') ? 'ETag' : 'Last-Modified'}`,
    };
  } catch (e) {
    return { name: 'If-Range honored', ok: false, detail: String(e) };
  }
}

async function engineContextCheck(p: ProbeResult): Promise<CheckResult> {
  try {
    const r = await sendToBackground<ProbeResponse>({ type: 'probe', url: p.finalUrl });
    if (!r?.result) return { name: 'Engine worker sees the same file', ok: false, detail: r?.error ?? 'no response' };
    const same = r.result.totalSize === p.totalSize && r.result.rangeSupported === p.rangeSupported;
    return {
      name: 'Engine worker sees the same file',
      ok: same,
      detail: `status ${r.result.status}, size ${r.result.totalSize}, range ${r.result.rangeSupported}`,
    };
  } catch (e) {
    return { name: 'Engine worker sees the same file', ok: false, detail: String(e) };
  }
}

/**
 * Waits for the next download Chrome creates (optionally triggering one), cancels it right away,
 * then checks whether its final URL still serves ranges to us.
 */
export async function captureNative(
  p: ProbeResult | null,
  signal: AbortSignal | undefined,
  trigger?: () => Promise<number>,
  timeoutMs = 120_000,
): Promise<CaptureResult> {
  const how = trigger ? 'extension-triggered' : 'user-click';
  let item: chrome.downloads.DownloadItem;
  try {
    item = await new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('Timed out waiting for a download to start')), timeoutMs);
      const onCreated = (d: chrome.downloads.DownloadItem) => {
        if (!trigger && !isDriveHost(d.finalUrl || d.url) && !d.url.includes('googleusercontent')) return;
        void chrome.downloads.cancel(d.id).catch(() => {});
        done(undefined, d);
      };
      const onAbort = () => done(new Error('Stopped'));
      function done(err?: Error, d?: chrome.downloads.DownloadItem) {
        clearTimeout(timer);
        chrome.downloads.onCreated.removeListener(onCreated);
        signal?.removeEventListener('abort', onAbort);
        if (d) resolve(d);
        else reject(err);
      }
      chrome.downloads.onCreated.addListener(onCreated);
      signal?.addEventListener('abort', onAbort, { once: true });
      trigger?.().catch((e: unknown) => done(e instanceof Error ? e : new Error(String(e))));
    });
  } catch (e) {
    return { how, error: String(e) };
  }
  // onCreated can fire before redirects settle; re-read the item for the final URL.
  const [fresh] = await chrome.downloads.search({ id: item.id });
  const capturedUrl = fresh?.finalUrl || item.finalUrl || item.url;
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
  const result: CaptureResult = { how, capturedUrl, host: safeHost(capturedUrl) };
  try {
    const r = await probe(capturedUrl, { credentials: 'include', signal });
    result.reuse = {
      status: r.status,
      rangeSupported: r.rangeSupported,
      totalSize: r.totalSize,
      sameSize: p ? r.totalSize === p.totalSize : true,
    };
  } catch (e) {
    result.error = `Captured URL could not be reused: ${toSwiftGetError(e).message}`;
  }
  return result;
}

async function connectionRun(
  p: ProbeResult,
  n: number,
  bytes: number,
  ctx: { signal?: AbortSignal },
): Promise<ConnectionRun> {
  const statuses: Record<string, number> = {};
  const errors: string[] = [];
  const ttfbMs: number[] = [];
  const per = Math.floor(bytes / n);
  let received = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const start = i * per;
      const end = i === n - 1 ? bytes - 1 : start + per - 1;
      const ts = performance.now();
      try {
        const res = await fetch(p.finalUrl, requestInit({ ...ctx }, { headers: { Range: `bytes=${start}-${end}` } }));
        ttfbMs.push(Math.round(performance.now() - ts));
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status !== 206 || !res.body) {
          res.body?.cancel().catch(() => {});
          return;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
        }
      } catch (e) {
        errors.push(toSwiftGetError(e).message);
      }
    }),
  );
  const ms = Math.round(performance.now() - t0);
  return { connections: n, bytes: received, ms, mbps: Math.round((received / 1048576 / (ms / 1000)) * 100) / 100, statuses, errors, ttfbMs };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const SECRET_PARAMS = /^(id|uuid|confirm|at|resourcekey|token|key|signature|sig|expires|x-goog-.*|access_token)$/i;

/** Replaces identifiers and tokens in URLs so the report can be shared. */
export function redactReport(r: DiagnosticsReport): DiagnosticsReport {
  const ids = new Set<string>();
  const link = parseDriveLink(r.input);
  if (link) ids.add(link.id);
  const redactUrl = (s: string | undefined) => {
    if (!s) return s;
    try {
      const u = new URL(s);
      for (const [k] of u.searchParams) if (SECRET_PARAMS.test(k)) u.searchParams.set(k, '<redacted>');
      let out = u.href.replace(/%3Credacted%3E/g, '<redacted>');
      for (const id of ids) out = out.split(id).join('<file-id>');
      // Signed CDN paths can embed tokens; keep only the shape.
      if (/googleusercontent\.com$/.test(u.hostname)) out = `${u.protocol}//${u.hostname}/<path-redacted>`;
      return out;
    } catch {
      return '<redacted>';
    }
  };
  const c = structuredClone(r);
  c.input = redactUrl(c.input) ?? '';
  c.resolvedUrl = redactUrl(c.resolvedUrl);
  if (c.probe) {
    c.probe.finalUrl = redactUrl(c.probe.finalUrl);
    if (c.probe.etag) c.probe.etag = '<present>';
  }
  for (const cap of c.capture) cap.capturedUrl = redactUrl(cap.capturedUrl);
  c.steps = c.steps.map((s) => {
    let out = s;
    for (const id of ids) out = out.split(id).join('<file-id>');
    return out;
  });
  return c;
}
