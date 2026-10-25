import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from './fixtures';

const sha256File = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const MB = 1024 * 1024;

async function hashOf(serverUrl: string, size: number, seed = 1): Promise<string> {
  const r = await fetch(`${serverUrl}/hash?size=${size}&seed=${seed}`);
  return ((await r.json()) as { sha256: string }).sha256;
}

async function stats(serverUrl: string, key: string) {
  const r = await fetch(`${serverUrl}/__stats?key=${key}`);
  return (await r.json()) as { range: string | null; status: number }[];
}

test('service worker loads with the expected manifest', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(expect.arrayContaining(['downloads', 'offscreen']));
});

test('downloads with 4 parallel ranges into OPFS and saves a verified file', async ({ context, extensionId, serverUrl, downloadsDir }) => {
  const size = 24 * MB + 123;
  const key = `e2e-${Date.now()}`;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.getByTestId('url-input').fill(`${serverUrl}/file?size=${size}&seed=3&name=e2e%20file.bin&key=${key}`);
  await page.getByTestId('connections').selectOption('4');
  await page.getByTestId('start').click();

  const item = page.getByTestId('download-item').first();
  await expect(item).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
  await expect(item.getByTestId('sha256')).toContainText(await hashOf(serverUrl, size, 3));

  const ranges = (await stats(serverUrl, key)).filter((r) => r.range && r.range !== 'bytes=0-0');
  expect(ranges).toHaveLength(4);
  expect(ranges.every((r) => r.status === 206)).toBe(true);

  // The hand-off went through chrome.downloads and the saved file has the full size.
  const saved = await page.evaluate(async () => {
    const [d] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    return d && { state: d.state, fileSize: d.fileSize, filename: d.filename };
  });
  expect(saved?.state).toBe('complete');
  expect(saved?.fileSize).toBe(size);
  expect(saved?.filename).toBe(join(downloadsDir, 'e2e file.bin'));
  expect(sha256File(await readFile(saved!.filename))).toBe(await hashOf(serverUrl, size, 3));

  // The OPFS working copy is removed after delivery.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('downloads', { create: true });
        const names: string[] = [];
        for await (const k of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(k);
        return names.length;
      }),
    )
    .toBe(0);
});

test('falls back to a single stream when the server has no range support', async ({ context, extensionId, serverUrl }) => {
  const size = 5 * MB;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.getByTestId('url-input').fill(`${serverUrl}/file?size=${size}&noRange=1&name=single.bin`);
  await page.getByTestId('start').click();
  const item = page.getByTestId('download-item').first();
  await expect(item).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
  await expect(item.getByTestId('sha256')).toContainText(await hashOf(serverUrl, size));
});

test('survives dropped connections and still verifies', async ({ context, extensionId, serverUrl }) => {
  const size = 8 * MB;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.getByTestId('url-input').fill(`${serverUrl}/file?size=${size}&dropAfter=900000&dropTimes=4&key=drop-${Date.now()}`);
  await page.getByTestId('start').click();
  const item = page.getByTestId('download-item').first();
  await expect(item).toHaveAttribute('data-status', 'completed', { timeout: 60_000 });
  await expect(item.getByTestId('sha256')).toContainText(await hashOf(serverUrl, size));
});

test('shows a clear error for an expired URL', async ({ context, extensionId, serverUrl }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manager.html`);
  await page.getByTestId('url-input').fill(`${serverUrl}/file?size=1000&expires=1`);
  await page.getByTestId('start').click();
  const item = page.getByTestId('download-item').first();
  await expect(item).toHaveAttribute('data-status', 'failed', { timeout: 60_000 });
  await expect(item.getByTestId('error')).toContainText('403');
});
