import Dexie, { type EntityTable } from 'dexie';
import type { ChunkState } from '../engine/downloader';
import type { ErrorCode } from '../engine/errors';

export type DownloadStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'verifying'
  | 'delivering'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type DeliveryMode = 'downloads' | 'picker';

export interface DownloadRecord {
  id: string;
  url: string;
  finalUrl?: string;
  filename: string;
  status: DownloadStatus;
  totalSize: number | null;
  downloaded: number;
  /** Bytes/second, smoothed. */
  speed: number;
  connections: number;
  activeConnections?: number;
  rangeSupported?: boolean;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  chunks?: ChunkState[];
  sha256?: string;
  /** Checksum the server advertised, if any, and whether ours matched. */
  expectedChecksum?: string;
  checksumOk?: boolean;
  error?: string;
  errorCode?: ErrorCode;
  deliveryMode: DeliveryMode;
  /** Chosen via showSaveFilePicker when deliveryMode is 'picker'. */
  saveHandle?: FileSystemFileHandle;
  /** chrome.downloads id of the final hand-off. */
  downloadItemId?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export const db = new Dexie('swiftget') as Dexie & {
  downloads: EntityTable<DownloadRecord, 'id'>;
};

db.version(1).stores({
  downloads: 'id, status, createdAt, downloadItemId',
});

export function opfsName(id: string): string {
  return `${id}.part`;
}

export function newDownloadId(): string {
  return crypto.randomUUID();
}

export async function patchDownload(id: string, patch: Partial<DownloadRecord>): Promise<void> {
  await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
}

export const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'probing', 'downloading', 'verifying', 'delivering'];
