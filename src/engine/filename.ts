/** Extracts a filename from a Content-Disposition header (RFC 6266 / RFC 5987). */
export function parseContentDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;

  // filename*=charset'lang'percent-encoded takes precedence.
  const ext = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (ext) {
    const raw = ext[1]!.trim().replace(/^"(.*)"$/, '$1');
    const m = /^([\w!#$%&+^`{}~-]*)'[^']*'(.*)$/.exec(raw);
    if (m) {
      const charset = m[1]!.toLowerCase();
      try {
        if (charset === 'utf-8' || charset === '') return decodeURIComponent(m[2]!);
        // latin1 and others: decode bytes one-by-one.
        return m[2]!.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      } catch {
        // fall through to plain filename
      }
    }
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted) return decodeMaybeUtf8(quoted[1]!.replace(/\\(.)/g, '$1'));
  const token = /filename\s*=\s*([^;\s]+)/i.exec(header);
  if (token) return decodeMaybeUtf8(token[1]!);
  return undefined;
}

/** Some servers send raw UTF-8 bytes in the header, which fetch exposes as latin1 code units. */
function decodeMaybeUtf8(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

export function filenameFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return undefined;
    return decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_LEN = 180;

/** Makes a name safe for chrome.downloads and common filesystems. */
export function sanitizeFilename(name: string | undefined, fallback = 'download'): string {
  let s = (name ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_LEN) {
    const dot = s.lastIndexOf('.');
    const extPart = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, MAX_LEN - extPart.length) + extPart;
  }
  return s;
}

export function pickFilename(opts: {
  contentDisposition?: string | null;
  finalUrl?: string;
  url: string;
}): string {
  return sanitizeFilename(
    parseContentDisposition(opts.contentDisposition) ??
      (opts.finalUrl ? filenameFromUrl(opts.finalUrl) : undefined) ??
      filenameFromUrl(opts.url),
  );
}
