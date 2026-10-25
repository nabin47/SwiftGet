import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { download } from '../../src/engine/downloader';
import {
  classifyDrivePage,
  driveDownloadUrl,
  isDriveHost,
  parseConfirmPage,
  parseDriveLink,
  resolveDownload,
} from '../../src/engine/drive';
import { contentSha256 } from '../server/content';
import { startTestServer, type TestServer } from '../server/server';
import { memorySink, noSleep } from './helpers';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('parseDriveLink', () => {
  it.each([
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`, { id: ID }],
    [`https://drive.google.com/file/u/1/d/${ID}/view`, { id: ID, authuser: '1' }],
    [`https://drive.google.com/open?id=${ID}&authuser=2`, { id: ID, authuser: '2' }],
    [`https://drive.google.com/uc?export=download&id=${ID}`, { id: ID }],
    [`https://drive.usercontent.google.com/download?id=${ID}&export=download&authuser=0&confirm=t`, { id: ID, authuser: '0' }],
    [`https://drive.google.com/file/d/${ID}/view?resourcekey=0-abc`, { id: ID, resourcekey: '0-abc' }],
  ])('%s', (link, expected) => {
    expect(parseDriveLink(link)).toMatchObject(expected);
  });

  it('rejects non-Drive links', () => {
    expect(parseDriveLink(`https://example.com/file/d/${ID}/view`)).toBeNull();
    expect(parseDriveLink('nonsense')).toBeNull();
    expect(isDriveHost('https://drive.usercontent.google.com/x')).toBe(true);
  });

  it('builds a usercontent download URL that keeps authuser', () => {
    const u = new URL(driveDownloadUrl({ id: ID, authuser: '1' }));
    expect(u.hostname).toBe('drive.usercontent.google.com');
    expect(u.searchParams.get('id')).toBe(ID);
    expect(u.searchParams.get('authuser')).toBe('1');
  });
});

describe('Drive pages', () => {
  const base = 'https://drive.usercontent.google.com/download?id=x&export=download';

  it('parses the current virus-scan form', () => {
    const html = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
      <input type="submit" id="uc-download-link" value="Download anyway"/>
      <input type="hidden" name="id" value="${ID}"><input type="hidden" name="export" value="download">
      <input type="hidden" name="authuser" value="1"><input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="abc-123"><input type="hidden" name="at" value="tok&amp;en"></form>`;
    const url = new URL(parseConfirmPage(html, base)!);
    expect(url.origin + url.pathname).toBe('https://drive.usercontent.google.com/download');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id: ID,
      export: 'download',
      authuser: '1',
      confirm: 't',
      uuid: 'abc-123',
      at: 'tok&en',
    });
  });

  it('parses the legacy confirm link', () => {
    const html = `<a id="uc-download-link" class="goog-inline-block" href="/uc?export=download&amp;confirm=AbCd&amp;id=${ID}">Download anyway</a>`;
    expect(parseConfirmPage(html, 'https://drive.google.com/uc?id=x')).toBe(
      `https://drive.google.com/uc?export=download&confirm=AbCd&id=${ID}`,
    );
  });

  it('classifies quota and sign-in pages', () => {
    expect(classifyDrivePage('<p>Too many users have viewed or downloaded this file recently.</p>', base).kind).toBe('quota');
    expect(classifyDrivePage('Download quota exceeded for this file', base).kind).toBe('quota');
    expect(classifyDrivePage('<a href="https://accounts.google.com/ServiceLogin?x">Sign in</a>', base).kind).toBe('access');
    expect(classifyDrivePage('<p>hello</p>', base).kind).toBe('unknown');
  });
});

describe('resolveDownload against a Drive-like server', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());

  it('follows the interstitial and downloads the real file', async () => {
    const size = 3 * 1024 * 1024 + 11;
    const { probe, steps } = await resolveDownload(`${server.url}/drive/uc?id=${ID}&size=${size}&seed=9`, {
      treatAsDrive: true,
    });
    expect(steps).toContain('drive page: confirm');
    expect(probe.rangeSupported).toBe(true);
    expect(probe.totalSize).toBe(size);
    expect(probe.filename).toBe('big file.bin');
    expect(new URL(probe.finalUrl).searchParams.get('uuid')).toBeTruthy();
    const sink = memorySink(size);
    await download({ url: probe.finalUrl, probe, sink, connections: 4, minChunkSize: 1024 * 1024, sleep: noSleep });
    expect(sink.sha256()).toBe(contentSha256(size, 9));
  });

  it('reports quota exceeded without trying to work around it', async () => {
    await expect(resolveDownload(`${server.url}/drive/uc?id=${ID}&quota=1`, { treatAsDrive: true })).rejects.toMatchObject({
      code: 'DRIVE_QUOTA',
    });
  });

  it('reports missing access', async () => {
    await expect(
      resolveDownload(`${server.url}/drive/uc?id=${ID}&access=denied`, { treatAsDrive: true }),
    ).rejects.toMatchObject({ code: 'DRIVE_ACCESS' });
  });

  it('leaves HTML from non-Drive hosts alone', async () => {
    const { probe } = await resolveDownload(`${server.url}/file?size=100&type=text/html`);
    expect(probe.totalSize).toBe(100);
  });
});
