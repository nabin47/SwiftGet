import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION_PATH = resolve(process.env.EXTENSION_PATH ?? '.output/chrome-mv3');

export const test = base.extend<{
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  serverUrl: string;
  downloadsDir: string;
}>({
  downloadsDir: async ({}, use) => {
    await use(await mkdtemp(join(tmpdir(), 'swiftget-dl-')));
  },
  context: async ({ downloadsDir }, use) => {
    // Point Chrome's own download folder at a temp dir. Playwright's download handling is left
    // off because it renames files, and we want to check the names Chrome picks.
    const profile = await mkdtemp(join(tmpdir(), 'swiftget-profile-'));
    await mkdir(join(profile, 'Default'), { recursive: true });
    await writeFile(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false } }),
    );
    const context = await chromium.launchPersistentContext(profile, {
      // The new headless mode supports extensions; HEADED=1 (with xvfb in CI) runs a real window.
      headless: !process.env.HEADED,
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const cdp = await context.browser()!.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  serverUrl: async ({}, use) => {
    await use(process.env.TEST_SERVER_URL!);
  },
});

export const expect = test.expect;
