import { ACTIVE_STATUSES, db, patchDownload } from '../shared/db';
import type { BackgroundMessage, OffscreenMessage } from '../shared/messages';

/**
 * Service worker: coordination only. It can be killed at any moment, so it keeps no state in
 * memory; transfers run in the offscreen document's worker and state lives in IndexedDB.
 */
export default defineBackground(() => {
  chrome.action.onClicked.addListener(() => {
    void openManager();
  });

  chrome.runtime.onStartup.addListener(() => {
    // The offscreen document did not survive the browser restart. Resume arrives in Phase 1.
    void db.downloads
      .where('status')
      .anyOf(ACTIVE_STATUSES.filter((s) => s !== 'queued'))
      .modify({ status: 'interrupted', speed: 0, activeConnections: 0, error: 'Interrupted by browser restart' });
  });

  chrome.runtime.onMessage.addListener((msg: BackgroundMessage, _sender, sendResponse) => {
    if (msg?.target !== 'background') return;
    handle(msg).then(sendResponse, (e: unknown) => sendResponse({ error: String(e) }));
    return true;
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state && !delta.error) return;
    void (async () => {
      const rec = await db.downloads.where('downloadItemId').equals(delta.id).first();
      if (!rec) return;
      if (delta.state?.current === 'complete') {
        await patchDownload(rec.id, { status: 'completed', completedAt: Date.now() });
        await toOffscreen({ target: 'offscreen', type: 'cleanup', id: rec.id });
      } else if (delta.state?.current === 'interrupted') {
        await patchDownload(rec.id, {
          status: 'failed',
          error: `Saving to Downloads failed: ${delta.error?.current ?? 'unknown error'}`,
        });
        await toOffscreen({ target: 'offscreen', type: 'cleanup', id: rec.id });
      }
    })();
  });
});

async function handle(msg: BackgroundMessage): Promise<unknown> {
  switch (msg.type) {
    case 'start':
      await toOffscreen({ target: 'offscreen', type: 'start', id: msg.id });
      return { ok: true };
    case 'cancel':
      await toOffscreen({ target: 'offscreen', type: 'cancel', id: msg.id });
      return { ok: true };
    case 'probe':
      return toOffscreen({ target: 'offscreen', type: 'probe', url: msg.url });
    case 'deliver': {
      const downloadItemId = await chrome.downloads.download({
        url: msg.blobUrl,
        filename: msg.filename,
        conflictAction: 'uniquify',
      });
      await patchDownload(msg.id, { downloadItemId });
      return { ok: true };
    }
  }
}

async function openManager(): Promise<void> {
  const url = chrome.runtime.getURL('/manager.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

let creating: Promise<void> | undefined;

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('/offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Runs the download engine in a worker and creates blob URLs for finished downloads.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

async function toOffscreen(msg: OffscreenMessage): Promise<unknown> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(msg);
}
