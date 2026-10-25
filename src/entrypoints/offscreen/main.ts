import { db, opfsName, patchDownload } from '../../shared/db';
import type { OffscreenMessage, ProbeResponse, WorkerEvent, WorkerRequest } from '../../shared/messages';
import { getFile } from '../../offscreen/opfs';

/**
 * Offscreen document: hosts the engine worker and creates blob: URLs for delivery.
 * It holds no transfer state of its own; that lives in the worker and IndexedDB.
 */

const worker = new Worker(new URL('../../offscreen/engine.worker.ts', import.meta.url), { type: 'module' });
const blobUrls = new Map<string, string>();
const pendingProbes = new Map<number, (r: ProbeResponse) => void>();
let nextProbeId = 1;

function toWorker(msg: WorkerRequest): void {
  worker.postMessage(msg);
}

worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
  const ev = e.data;
  if (ev.type === 'ready-to-deliver') void deliver(ev.id, ev.filename);
  else if (ev.type === 'probe-result') {
    pendingProbes.get(ev.requestId)?.({ result: ev.result, error: ev.error });
    pendingProbes.delete(ev.requestId);
  } else if (ev.type === 'log') console.log('[engine]', ev.message);
};

async function deliver(id: string, filename: string): Promise<void> {
  try {
    // A File from OPFS is disk-backed, so the blob URL doesn't copy the download into memory.
    const file = await getFile(opfsName(id));
    const blobUrl = URL.createObjectURL(file);
    blobUrls.set(id, blobUrl);
    await chrome.runtime.sendMessage({ target: 'background', type: 'deliver', id, blobUrl, filename });
  } catch (e) {
    await patchDownload(id, { status: 'failed', error: `Could not hand off to Downloads: ${String(e)}` });
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
    case 'cancel':
      toWorker({ type: msg.type, id: msg.id });
      break;
    case 'cleanup': {
      const url = blobUrls.get(msg.id);
      if (url) URL.revokeObjectURL(url);
      blobUrls.delete(msg.id);
      toWorker({ type: 'delete', id: msg.id });
      break;
    }
    case 'probe': {
      const requestId = nextProbeId++;
      pendingProbes.set(requestId, sendResponse);
      toWorker({ type: 'probe', requestId, url: msg.url });
      return true;
    }
  }
  return undefined;
});

// The document may have been (re)created to resume work: pick up anything queued.
void db.downloads
  .where('status')
  .equals('queued')
  .each((r) => toWorker({ type: 'start', id: r.id }));
