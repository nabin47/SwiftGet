/// <reference lib="webworker" />
import { download } from '../engine/downloader';
import { resolveDownload } from '../engine/drive';
import { SwiftGetError, toSwiftGetError } from '../engine/errors';
import { SpeedMeter } from '../engine/speed';
import { db, opfsName, patchDownload, type DownloadRecord } from '../shared/db';
import type { WorkerEvent, WorkerRequest } from '../shared/messages';
import { copyToHandle, hashSyncHandle, openSyncHandle, removeFile, syncHandleSink } from './opfs';

/**
 * Download engine. Runs in a dedicated worker owned by the offscreen document, because only
 * workers get OPFS sync access handles and the service worker may be killed at any time.
 */

declare const self: DedicatedWorkerGlobalScope;

const running = new Map<string, AbortController>();
const PROGRESS_INTERVAL_MS = 500;

function post(ev: WorkerEvent): void {
  self.postMessage(ev);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      void start(msg.id);
      break;
    case 'cancel':
      running.get(msg.id)?.abort();
      break;
    case 'delete':
      void removeFile(opfsName(msg.id));
      break;
    case 'probe':
      resolveDownload(msg.url, { credentials: 'include' })
        .then(({ probe, steps }) => post({ type: 'probe-result', requestId: msg.requestId, result: { ...probe, steps } }))
        .catch((err: unknown) =>
          post({ type: 'probe-result', requestId: msg.requestId, error: toSwiftGetError(err).message }),
        );
      break;
  }
};

async function start(id: string): Promise<void> {
  if (running.has(id)) return;
  const ac = new AbortController();
  running.set(id, ac);
  let handle: FileSystemSyncAccessHandle | undefined;
  try {
    const rec = await db.downloads.get(id);
    if (!rec || rec.status !== 'queued') return;
    await patchDownload(id, { status: 'probing', error: undefined, errorCode: undefined });
    const { probe } = await resolveDownload(rec.url, { credentials: 'include', signal: ac.signal });
    const filename = rec.filename || probe.filename;
    await patchDownload(id, {
      status: 'downloading',
      finalUrl: probe.finalUrl,
      filename,
      totalSize: probe.totalSize,
      rangeSupported: probe.rangeSupported,
      etag: probe.etag,
      lastModified: probe.lastModified,
      contentType: probe.contentType,
      expectedChecksum: probe.sha256,
    });

    handle = await openSyncHandle(opfsName(id));
    handle.truncate(0);
    const meter = new SpeedMeter();
    let lastWrite = 0;
    let latest: Partial<DownloadRecord> = {};
    const result = await download({
      url: rec.url,
      probe,
      sink: syncHandleSink(handle),
      connections: rec.connections,
      credentials: 'include',
      signal: ac.signal,
      onProgress: (p) => {
        const now = Date.now();
        const speed = meter.sample(p.downloaded, now);
        latest = { downloaded: p.downloaded, speed, activeConnections: p.activeConnections, chunks: p.chunks };
        if (now - lastWrite >= PROGRESS_INTERVAL_MS) {
          lastWrite = now;
          void patchDownload(id, latest);
        }
      },
    });

    handle.flush();
    const size = handle.getSize();
    if (size !== result.bytes) {
      throw new SwiftGetError('SIZE_MISMATCH', `File on disk is ${size} bytes, expected ${result.bytes}`);
    }
    await patchDownload(id, { ...latest, downloaded: result.bytes, totalSize: result.bytes, speed: 0, activeConnections: 0, status: 'verifying' });
    const sha256 = await hashSyncHandle(handle, undefined, ac.signal);
    const checksumOk = probe.sha256 ? probe.sha256 === sha256 : undefined;
    if (checksumOk === false) {
      throw new SwiftGetError('SIZE_MISMATCH', `Checksum mismatch: server says ${probe.sha256}, got ${sha256}`);
    }
    await patchDownload(id, { sha256, checksumOk, status: 'delivering' });

    const latestRec = await db.downloads.get(id);
    if (latestRec?.deliveryMode === 'picker' && latestRec.saveHandle) {
      await copyToHandle(handle, latestRec.saveHandle, ac.signal);
      handle.close();
      handle = undefined;
      await removeFile(opfsName(id));
      await patchDownload(id, { status: 'completed', completedAt: Date.now() });
    } else {
      // The offscreen document turns the OPFS file into a blob: URL for chrome.downloads.
      handle.close();
      handle = undefined;
      post({ type: 'ready-to-deliver', id, filename });
    }
  } catch (e) {
    const err = toSwiftGetError(e);
    console.warn('[engine]', id, err);
    handle?.close();
    handle = undefined;
    await removeFile(opfsName(id)).catch(() => {});
    if (err.code === 'ABORTED') {
      await patchDownload(id, { status: 'cancelled', speed: 0, activeConnections: 0 });
    } else {
      await patchDownload(id, { status: 'failed', error: err.message, errorCode: err.code, speed: 0, activeConnections: 0 });
    }
  } finally {
    running.delete(id);
  }
}
