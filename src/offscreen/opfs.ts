import { Sha256 } from '../engine/sha256';
import type { Sink } from '../engine/downloader';

/**
 * Origin Private File System storage. Sync access handles (worker-only) write at arbitrary
 * offsets straight to disk, with no swap file and no merge step.
 */

const DIR = 'downloads';

export async function downloadsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

export async function openSyncHandle(name: string): Promise<FileSystemSyncAccessHandle> {
  const dir = await downloadsDir();
  const fh = await dir.getFileHandle(name, { create: true });
  return fh.createSyncAccessHandle();
}

export async function getFile(name: string): Promise<File> {
  const dir = await downloadsDir();
  return (await dir.getFileHandle(name)).getFile();
}

export async function removeFile(name: string): Promise<void> {
  const dir = await downloadsDir();
  await dir.removeEntry(name).catch((e: unknown) => {
    if ((e as { name?: string }).name !== 'NotFoundError') throw e;
  });
}

export function syncHandleSink(h: FileSystemSyncAccessHandle): Sink {
  return {
    write(offset, data) {
      let done = 0;
      while (done < data.length) {
        const n = h.write(data.subarray(done), { at: offset + done });
        if (n <= 0) throw new Error('OPFS write failed (disk full?)');
        done += n;
      }
    },
  };
}

const READ_BLOCK = 8 * 1024 * 1024;

/** Streams the file through SHA-256. Yields to the event loop so cancel messages get through. */
export async function hashSyncHandle(
  h: FileSystemSyncAccessHandle,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const size = h.getSize();
  const sha = new Sha256();
  const buf = new Uint8Array(READ_BLOCK);
  for (let off = 0; off < size; ) {
    signal?.throwIfAborted();
    const n = h.read(buf, { at: off });
    if (n <= 0) throw new Error('OPFS read failed');
    sha.update(buf.subarray(0, n));
    off += n;
    onProgress?.(off);
    await new Promise((r) => setTimeout(r, 0));
  }
  return sha.hex();
}

/** Copies the OPFS file to a user-chosen location (File System Access API). */
export async function copyToHandle(
  h: FileSystemSyncAccessHandle,
  target: FileSystemFileHandle,
  signal?: AbortSignal,
): Promise<void> {
  const writable = await target.createWritable();
  try {
    const size = h.getSize();
    const buf = new Uint8Array(READ_BLOCK);
    for (let off = 0; off < size; ) {
      signal?.throwIfAborted();
      const n = h.read(buf, { at: off });
      if (n <= 0) throw new Error('OPFS read failed');
      await writable.write(buf.slice(0, n));
      off += n;
    }
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    throw e;
  }
}
