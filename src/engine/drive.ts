import { SwiftGetError, httpError, toSwiftGetError } from './errors';
import { isHtml, probe, requestInit, type ProbeResult, type RequestContext } from './probe';

/**
 * Google Drive helpers. We only follow the "can't scan for viruses" confirmation that a user
 * would click through anyway. Quota and permission pages are reported, never bypassed.
 */

const DRIVE_HOSTS = new Set(['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com']);

export function isDriveHost(url: string): boolean {
  try {
    return DRIVE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Default connections for Drive: conservative, since Drive throttles aggressively. */
export const DRIVE_DEFAULT_CONNECTIONS = 4;

export interface DriveLink {
  id: string;
  authuser?: string;
  resourcekey?: string;
}

/** Accepts the common Drive link shapes (file/d/ID, open?id=, uc?id=, usercontent download?id=). */
export function parseDriveLink(input: string): DriveLink | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!isDriveHost(u.href)) return null;
  const m = /\/file\/(?:u\/\d+\/)?d\/([\w-]{10,})/.exec(u.pathname);
  const id = m?.[1] ?? u.searchParams.get('id') ?? undefined;
  if (!id || !/^[\w-]{10,}$/.test(id)) return null;
  // /u/1/ in the path is an alternative to ?authuser=1.
  const pathUser = /\/u\/(\d+)\//.exec(u.pathname)?.[1];
  return {
    id,
    authuser: u.searchParams.get('authuser') ?? pathUser ?? undefined,
    resourcekey: u.searchParams.get('resourcekey') ?? undefined,
  };
}

export type DriveLinkKind = 'file' | 'folder' | 'google-doc' | 'unknown';

/** Classifies a Drive/Docs URL. Returns null for non-Google-Drive URLs. */
export function driveLinkKind(input: string): DriveLinkKind | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!isDriveHost(u.href)) return null;
  if (/\/folders\/|\/folderview|\/embeddedfolderview/.test(u.pathname)) return 'folder';
  if (/^\/(?:document|spreadsheets|presentation|forms|drawings)\//.test(u.pathname)) return 'google-doc';
  return parseDriveLink(u.href) ? 'file' : 'unknown';
}

/** A user-facing explanation when a Drive link can't be downloaded as a single file, else undefined. */
export function driveLinkProblem(input: string): string | undefined {
  switch (driveLinkKind(input)) {
    case 'folder':
      return 'This is a link to a Google Drive folder, not a file. Open the folder, right-click the file, choose Share → Copy link, and paste that link.';
    case 'google-doc':
      return 'This is a Google Docs/Sheets/Slides document, which has no file to download directly. In the document use File → Download to export it.';
    case 'unknown':
      return "This Google Drive link doesn't point to a single file. Paste the file's share link (it looks like drive.google.com/file/d/…/view).";
    default:
      return undefined;
  }
}

export function driveDownloadUrl(link: DriveLink): string {
  const u = new URL('https://drive.usercontent.google.com/download');
  u.searchParams.set('id', link.id);
  u.searchParams.set('export', 'download');
  if (link.authuser) u.searchParams.set('authuser', link.authuser);
  if (link.resourcekey) u.searchParams.set('resourcekey', link.resourcekey);
  return u.href;
}

export type DrivePageKind =
  | { kind: 'confirm'; url: string }
  | { kind: 'quota' }
  | { kind: 'access' }
  | { kind: 'unknown' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos' || l === '#39') return "'";
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16));
    return String.fromCodePoint(parseInt(l.slice(1), 10));
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v === undefined ? undefined : decodeEntities(v);
}

/**
 * Finds the confirmation form/link on the virus-scan interstitial.
 * Works without DOMParser so it can run in a worker.
 */
export function parseConfirmPage(html: string, baseUrl: string): string | null {
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  for (let fm; (fm = formRe.exec(html)); ) {
    const open = /<form\b[^>]*>/i.exec(fm[0])![0];
    const isDownloadForm =
      attr(open, 'id') === 'download-form' || /uc-download-link/.test(fm[1]!) || /\/download\b|\/uc\b/.test(attr(open, 'action') ?? '');
    if (!isDownloadForm) continue;
    const action = attr(open, 'action');
    if (!action) continue;
    const target = new URL(action, baseUrl);
    const inputs = fm[1]!.match(/<input\b[^>]*>/gi) ?? [];
    for (const input of inputs) {
      if ((attr(input, 'type') ?? '').toLowerCase() !== 'hidden') continue;
      const name = attr(input, 'name');
      if (name) target.searchParams.set(name, attr(input, 'value') ?? '');
    }
    return target.href;
  }
  // Older layout: <a id="uc-download-link" href="/uc?export=download&confirm=...">
  const link = /<a\b[^>]*id\s*=\s*["']uc-download-link["'][^>]*>/i.exec(html)?.[0];
  const href = link ? attr(link, 'href') : undefined;
  return href ? new URL(href, baseUrl).href : null;
}

export function classifyDrivePage(html: string, baseUrl: string): DrivePageKind {
  if (/quota\s+(?:has\s+been\s+)?exceeded|too many users have (?:viewed or )?downloaded/i.test(html)) {
    return { kind: 'quota' };
  }
  const url = parseConfirmPage(html, baseUrl);
  if (url) return { kind: 'confirm', url };
  if (/accounts\.google\.com\/(?:ServiceLogin|v3\/signin)|you need access|request access/i.test(html)) {
    return { kind: 'access' };
  }
  return { kind: 'unknown' };
}

export interface ResolveResult {
  probe: ProbeResult;
  /** Steps taken, for diagnostics. */
  steps: string[];
}

/**
 * Probes `url`; if Drive answers with an HTML page instead of the file, follows the virus-scan
 * confirmation (at most twice) and reports quota/access pages as errors.
 */
export async function resolveDownload(
  url: string,
  ctx: RequestContext & { treatAsDrive?: boolean; onStep?: (step: string) => void } = {},
): Promise<ResolveResult> {
  const problem = driveLinkProblem(url);
  if (problem) throw new SwiftGetError('DRIVE_NOT_FILE', problem);
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    ctx.onStep?.(s);
  };
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const p = await probe(current, ctx);
    step(`probe ${p.status} ${p.contentType ?? '?'} size=${p.totalSize ?? '?'} range=${p.rangeSupported}`);
    const drive = ctx.treatAsDrive || isDriveHost(current) || isDriveHost(p.finalUrl);
    if (!drive || !isHtml(p)) return { probe: p, steps };

    const html = await fetchText(p.finalUrl, ctx);
    const page = classifyDrivePage(html, p.finalUrl);
    step(`drive page: ${page.kind}`);
    if (page.kind !== 'confirm') step(`page title: ${pageTitle(html) ?? '(none)'}`);
    if (page.kind === 'quota') {
      throw new SwiftGetError(
        'DRIVE_QUOTA',
        'Google Drive says the download quota for this file is exceeded. Try again later, or make a copy of the file in your own Drive.',
      );
    }
    if (page.kind === 'access') {
      throw new SwiftGetError(
        'DRIVE_ACCESS',
        "Google Drive didn't return the file. Check that you are signed in to an account that has access (and the authuser in the link is right).",
      );
    }
    if (page.kind === 'unknown') {
      throw new SwiftGetError('DRIVE_UNRECOGNIZED', 'Google Drive returned a page SwiftGet does not recognize.');
    }
    current = page.url;
  }
  throw new SwiftGetError('DRIVE_UNRECOGNIZED', 'Google Drive kept returning confirmation pages.');
}

function pageTitle(html: string): string | undefined {
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decodeEntities(t.replace(/\s+/g, ' ').trim()).slice(0, 120) : undefined;
}

async function fetchText(url: string, ctx: RequestContext, limit = 2 * 1024 * 1024): Promise<string> {
  const f = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, requestInit(ctx));
  } catch (e) {
    throw toSwiftGetError(e);
  }
  if (!res.ok) throw httpError(res);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    all.set(p.subarray(0, Math.min(p.length, n - off)), off);
    off += p.length;
  }
  return new TextDecoder().decode(all);
}
