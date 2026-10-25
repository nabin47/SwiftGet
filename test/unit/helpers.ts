import { createHash } from 'node:crypto';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sink } from '../../src/engine/downloader';

/** In-memory sink that records writes; fine for files up to a few hundred MB. */
export function memorySink(size: number): Sink & { data: Uint8Array; sha256(): string; writes: number } {
  const data = new Uint8Array(size);
  const sink = {
    data,
    writes: 0,
    write(offset: number, chunk: Uint8Array) {
      if (offset + chunk.length > size) throw new Error(`write past end: ${offset}+${chunk.length} > ${size}`);
      data.set(chunk, offset);
      sink.writes++;
    },
    sha256: () => createHash('sha256').update(data).digest('hex'),
  };
  return sink;
}

/** Growable in-memory sink for unknown sizes. */
export function growableSink(): Sink & { bytes(): Uint8Array; sha256(): string } {
  let data = new Uint8Array(1 << 20);
  let len = 0;
  return {
    write(offset, chunk) {
      const need = offset + chunk.length;
      if (need > data.length) {
        const n = new Uint8Array(Math.max(need, data.length * 2));
        n.set(data.subarray(0, len));
        data = n;
      }
      data.set(chunk, offset);
      len = Math.max(len, need);
    },
    bytes: () => data.subarray(0, len),
    sha256: () => createHash('sha256').update(data.subarray(0, len)).digest('hex'),
  };
}

/** File-backed sink, like OPFS, for large transfers. */
export async function fileSink() {
  const dir = await mkdtemp(join(tmpdir(), 'swiftget-'));
  const path = join(dir, 'out.bin');
  const fh = await open(path, 'w+');
  return {
    path,
    async write(offset: number, chunk: Uint8Array) {
      let done = 0;
      while (done < chunk.length) {
        const { bytesWritten } = await fh.write(chunk, done, chunk.length - done, offset + done);
        done += bytesWritten;
      }
    },
    async sha256() {
      const h = createHash('sha256');
      for await (const c of fh.createReadStream({ start: 0, autoClose: false })) h.update(c as Buffer);
      return h.digest('hex');
    },
    async close() {
      await fh.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const noSleep = async () => {};
