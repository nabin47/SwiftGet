import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { contentSha256, fillContent } from './content.ts';

/**
 * Local HTTP server for engine tests. Serves deterministic content with Range support and
 * fault injection driven by query parameters, so each test describes its scenario in the URL.
 *
 * GET|HEAD /file?size=N&seed=S plus any of:
 *   name=foo.bin        Content-Disposition attachment filename (utf-8 via filename*)
 *   noRange=1           ignore Range, always 200 with the full body
 *   throttle=BPS        per-response bandwidth cap in bytes/second
 *   delay=MS            wait before sending headers
 *   dropAfter=BYTES     destroy the socket after sending BYTES of body
 *   dropTimes=K         ...only for the first K responses on this key (default: all)
 *   fail=STATUS&failTimes=K   answer the first K body requests with STATUS (Retry-After: 0)
 *   changeAfter=K       after K requests on this key the content (seed) and ETag change
 *   expires=EPOCH_MS    answer 403 "expired" after this time
 *   etag=none|weak      omit the ETag or make it weak (default: strong)
 *   noLength=1          chunked transfer without Content-Length (only without Range)
 *   digest=1            send Repr-Digest: sha-256 of the full content
 *   type=MIME           Content-Type (default application/octet-stream)
 *   key=K               namespace for counters/stats (default: the query string)
 *
 * GET /drive/uc?id=ID&size=&seed=  Drive-like virus-scan interstitial (quota=1 -> quota page,
 *   access=denied -> sign-in page). Its form posts to /drive/download?id&export&confirm&uuid.
 * GET /redirect?to=PATH            302 to PATH
 * GET /hash?size=N&seed=S          {"sha256": "..."} of the content
 * GET /__stats?key=K               request log for a key;  POST /__reset clears all state
 */

export interface RequestLogEntry {
  method: string;
  path: string;
  range: string | null;
  ifRange: string | null;
  status: number;
  time: number;
}

export interface TestServer {
  url: string;
  port: number;
  close(): Promise<void>;
  stats(key: string): RequestLogEntry[];
  reset(): void;
}

interface KeyState {
  requests: number;
  bodyRequests: number;
  drops: number;
  log: RequestLogEntry[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startTestServer(port = 0, host = '127.0.0.1'): Promise<TestServer> {
  const state = new Map<string, KeyState>();
  const keyState = (k: string): KeyState => {
    let s = state.get(k);
    if (!s) state.set(k, (s = { requests: 0, bodyRequests: 0, drops: 0, log: [] }));
    return s;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(e));
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const q = u.searchParams;
    const key = q.get('key') ?? `${u.pathname}?${q.toString()}`;

    if (u.pathname === '/__reset') {
      state.clear();
      res.writeHead(204).end();
      return;
    }
    if (u.pathname === '/__stats') {
      sendJson(res, keyState(q.get('key') ?? '').log);
      return;
    }
    if (u.pathname === '/hash') {
      sendJson(res, { sha256: contentSha256(Number(q.get('size') ?? 1048576), Number(q.get('seed') ?? 1)) });
      return;
    }
    if (u.pathname === '/redirect') {
      res.writeHead(302, { location: q.get('to') ?? '/' }).end();
      return;
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>SwiftGet test server</title><a href="/file?size=1048576&name=test.bin">test.bin</a>');
      return;
    }
    if (u.pathname === '/drive/uc') {
      const st = keyState(key);
      const log = logger(st, req, u);
      if (q.get('quota') === '1') return sendHtml(res, 200, quotaPage(), log);
      if (q.get('access') === 'denied') return sendHtml(res, 200, signinPage(), log);
      return sendHtml(res, 200, interstitial(u), log);
    }
    if (u.pathname === '/drive/download' || u.pathname === '/file') {
      if (u.pathname === '/drive/download' && (q.get('confirm') !== 't' || !q.get('uuid'))) {
        return sendHtml(res, 200, interstitial(u), logger(keyState(key), req, u));
      }
      await serveFile(req, res, u, keyState(key));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }

  function logger(st: KeyState, req: http.IncomingMessage, u: URL) {
    return (status: number) =>
      st.log.push({
        method: req.method ?? 'GET',
        path: u.pathname + u.search,
        range: (req.headers.range as string | undefined) ?? null,
        ifRange: (req.headers['if-range'] as string | undefined) ?? null,
        status,
        time: Date.now(),
      });
  }

  async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, u: URL, st: KeyState) {
    const q = u.searchParams;
    const log = logger(st, req, u);
    st.requests++;
    const size = Number(q.get('size') ?? 1048576);
    const changeAfter = q.has('changeAfter') ? Number(q.get('changeAfter')) : Infinity;
    const changed = st.requests > changeAfter;
    const seed = Number(q.get('seed') ?? 1) + (changed ? 1000 : 0);
    const etagMode = q.get('etag');
    const strongTag = `"s${seed}-${size}"`;
    const etag = etagMode === 'none' ? undefined : etagMode === 'weak' ? `W/${strongTag}` : strongTag;
    const lastModified = new Date(Date.UTC(2024, 0, 1) + (changed ? 86_400_000 : 0)).toUTCString();

    const delay = Number(q.get('delay') ?? 0);
    if (delay > 0) await sleep(delay);

    const expires = q.get('expires');
    if (expires && Date.now() > Number(expires)) {
      return sendHtml(res, 403, '<!doctype html><title>Expired</title>This link has expired.', log);
    }

    const isHead = req.method === 'HEAD';
    if (!isHead) {
      st.bodyRequests++;
      const fail = Number(q.get('fail') ?? 0);
      if (fail && st.bodyRequests <= Number(q.get('failTimes') ?? 1)) {
        log(fail);
        res.writeHead(fail, { 'retry-after': '0', 'content-type': 'text/plain' }).end('injected failure');
        return;
      }
    }

    const headers: http.OutgoingHttpHeaders = {
      'content-type': q.get('type') ?? 'application/octet-stream',
      'last-modified': lastModified,
    };
    if (etag) headers.etag = etag;
    if (q.get('digest') === '1') {
      headers['repr-digest'] = `sha-256=:${Buffer.from(contentSha256(size, seed), 'hex').toString('base64')}:`;
    }
    const name = q.get('name');
    if (name) {
      headers['content-disposition'] =
        `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    }

    const noRange = q.get('noRange') === '1';
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (!noRange) {
      headers['accept-ranges'] = 'bytes';
      const ifRange = req.headers['if-range'] as string | undefined;
      // If-Range: serve the range only when the validator still matches (strong ETag or date).
      const validatorOk = !ifRange || (ifRange === strongTag && etag === strongTag) || ifRange === lastModified;
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (m && validatorOk) {
        if (m[1] === '') {
          start = Math.max(0, size - Number(m[2]));
        } else {
          start = Number(m[1]);
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
        }
        if (start >= size || start > end) {
          log(416);
          res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          return;
        }
        status = 206;
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    const length = end - start + 1;
    if (!(q.get('noLength') === '1' && status === 200)) headers['content-length'] = String(length);

    log(status);
    res.writeHead(status, headers);
    if (isHead) return void res.end();

    const throttle = Number(q.get('throttle') ?? 0);
    const dropAfter = q.has('dropAfter') ? Number(q.get('dropAfter')) : Infinity;
    const dropTimes = q.has('dropTimes') ? Number(q.get('dropTimes')) : Infinity;
    const shouldDrop = dropAfter !== Infinity && st.drops < dropTimes;
    if (shouldDrop) st.drops++;

    const block = new Uint8Array(throttle > 0 ? Math.max(1024, Math.min(65536, Math.floor(throttle / 10))) : 256 * 1024);
    let sent = 0;
    const t0 = Date.now();
    while (sent < length) {
      if (res.destroyed) return;
      let n = Math.min(block.length, length - sent);
      if (shouldDrop && sent + n > dropAfter) n = dropAfter - sent;
      if (n <= 0) {
        res.destroy();
        return;
      }
      const view = block.subarray(0, n);
      fillContent(view, start + sent, seed);
      sent += n;
      if (!res.write(view)) await new Promise<void>((r) => res.once('drain', () => r()).once('close', () => r()));
      if (shouldDrop && sent >= dropAfter) {
        // Let the bytes leave before cutting the connection.
        await sleep(20);
        res.destroy();
        return;
      }
      if (throttle > 0) {
        const due = t0 + (sent / throttle) * 1000;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    stats: (k) => keyState(k).log,
    reset: () => state.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, body: unknown) {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, status: number, html: string, log: (s: number) => void) {
  log(status);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function interstitial(u: URL): string {
  const q = u.searchParams;
  const hidden: Record<string, string> = {
    id: q.get('id') ?? 'unknown',
    export: 'download',
    confirm: 't',
    uuid: '6b1f4a2e-0000-4000-8000-000000000001',
  };
  for (const k of ['size', 'seed', 'name', 'key', 'authuser']) {
    const v = q.get(k);
    if (v !== null) hidden[k] = v;
  }
  if (!hidden.name) hidden.name = 'big file.bin';
  const inputs = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`)
    .join('');
  return `<!DOCTYPE html><html><head><title>Google Drive - Virus scan warning</title></head><body>
<div class="uc-main"><p class="uc-warning-caption">Google Drive can&#39;t scan this file for viruses.</p>
<p class="uc-warning-subcaption"><span class="uc-name-size"><a href="/open?id=${hidden.id}">big file.bin</a> (5.2G)</span> is too large for Google to scan for viruses. Would you still like to download this file?</p>
<form id="download-form" action="/drive/download" method="get"><input type="submit" id="uc-download-link" class="goog-inline-block jfk-button jfk-button-action" value="Download anyway"/>${inputs}</form></div></body></html>`;
}

function quotaPage(): string {
  return `<!DOCTYPE html><html><head><title>Google Drive - Quota exceeded</title></head><body>
<div class="uc-main"><p class="uc-error-caption">Sorry, you can&#39;t view or download this file at this time.</p>
<p class="uc-error-subcaption">Too many users have viewed or downloaded this file recently. Please try accessing the file again later.</p></div></body></html>`;
}

function signinPage(): string {
  return `<!DOCTYPE html><html><head><title>Google Drive: Sign-in</title></head><body>
<a href="https://accounts.google.com/ServiceLogin?service=wise">Sign in</a></body></html>`;
}
