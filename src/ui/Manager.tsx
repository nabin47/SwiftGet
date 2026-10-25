import { useLiveQuery } from 'dexie-react-hooks';
import { useState, type FormEvent } from 'react';
import { DEFAULT_CONNECTIONS, MAX_CONNECTIONS } from '../engine/downloader';
import { DRIVE_DEFAULT_CONNECTIONS, driveDownloadUrl, isDriveHost, parseDriveLink } from '../engine/drive';
import { sanitizeFilename } from '../engine/filename';
import { etaSeconds, formatBytes, formatDuration } from '../engine/speed';
import { db, newDownloadId, type DownloadRecord } from '../shared/db';
import { sendToBackground } from '../shared/messages';

export function Manager() {
  const downloads = useLiveQuery(() => db.downloads.orderBy('createdAt').reverse().toArray(), []);
  const [url, setUrl] = useState('');
  const [connections, setConnections] = useState(DEFAULT_CONNECTIONS);
  const [pickLocation, setPickLocation] = useState(false);
  const [formError, setFormError] = useState<string>();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    let target = url.trim();
    try {
      const u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      setFormError('Enter an http(s) URL.');
      return;
    }
    // A Drive "view" link becomes its direct download URL.
    const drive = parseDriveLink(target);
    if (drive && !target.includes('/download')) target = driveDownloadUrl(drive);

    let saveHandle: FileSystemFileHandle | undefined;
    if (pickLocation) {
      if (!('showSaveFilePicker' in window)) {
        setFormError('This browser does not support choosing a save location.');
        return;
      }
      try {
        // Must run first in the click handler: the picker needs the user gesture.
        saveHandle = await window.showSaveFilePicker({ suggestedName: sanitizeFilename(new URL(target).pathname.split('/').pop()) });
      } catch {
        return; // picker dismissed
      }
    }

    const id = newDownloadId();
    const now = Date.now();
    await db.downloads.add({
      id,
      url: target,
      filename: saveHandle?.name ?? '',
      status: 'queued',
      totalSize: null,
      downloaded: 0,
      speed: 0,
      connections: isDriveHost(target) ? Math.min(connections, DRIVE_DEFAULT_CONNECTIONS) : connections,
      deliveryMode: saveHandle ? 'picker' : 'downloads',
      saveHandle,
      createdAt: now,
      updatedAt: now,
    });
    await sendToBackground({ type: 'start', id });
    setUrl('');
  }

  return (
    <main>
      <header>
        <h1>SwiftGet</h1>
        <nav className="row">
          <a href="/diagnostics.html">Drive diagnostics</a>
        </nav>
      </header>
      <form className="panel" onSubmit={onSubmit} aria-label="New download">
        <div className="row">
          <label htmlFor="url" className="muted">
            URL
          </label>
          <input
            id="url"
            type="url"
            required
            placeholder="https://example.com/file.zip"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            data-testid="url-input"
          />
          <button type="submit" className="primary" data-testid="start">
            Download
          </button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Connections{' '}
            <select
              value={connections}
              onChange={(e) => setConnections(Number(e.target.value))}
              data-testid="connections"
            >
              {Array.from({ length: MAX_CONNECTIONS }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={pickLocation} onChange={(e) => setPickLocation(e.target.checked)} /> Choose
            where to save
          </label>
        </div>
        {formError && (
          <p className="bad" role="alert">
            {formError}
          </p>
        )}
      </form>

      <h2>Downloads</h2>
      {downloads?.length === 0 && <p className="muted">Nothing yet.</p>}
      <ul className="list" data-testid="downloads">
        {downloads?.map((d) => <DownloadRow key={d.id} d={d} />)}
      </ul>
    </main>
  );
}

const STATUS_LABEL: Record<DownloadRecord['status'], string> = {
  queued: 'Queued',
  probing: 'Connecting',
  downloading: 'Downloading',
  verifying: 'Verifying',
  delivering: 'Saving',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

function DownloadRow({ d }: { d: DownloadRecord }) {
  const active = ['queued', 'probing', 'downloading', 'verifying', 'delivering'].includes(d.status);
  const pct = d.totalSize ? Math.min(100, (d.downloaded / d.totalSize) * 100) : undefined;
  const eta = etaSeconds(d.downloaded, d.totalSize, d.speed);
  const statusClass = d.status === 'completed' ? 'ok' : d.status === 'failed' ? 'bad' : d.status === 'interrupted' ? 'warn' : '';

  async function cancel() {
    if (d.status === 'queued') await db.downloads.update(d.id, { status: 'cancelled' });
    await sendToBackground({ type: 'cancel', id: d.id });
  }

  return (
    <li className="item" data-testid="download-item" data-status={d.status} data-id={d.id}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="name">{d.filename || d.url}</span>
        <span className="row">
          <span className={statusClass} data-testid="status">
            {STATUS_LABEL[d.status]}
          </span>
          {active ? (
            <button type="button" onClick={cancel} aria-label={`Cancel ${d.filename}`}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={() => db.downloads.delete(d.id)} aria-label={`Remove ${d.filename} from list`}>
              Remove
            </button>
          )}
        </span>
      </div>
      {active && <progress max={100} value={pct} aria-label="Progress" />}
      {d.status === 'downloading' && d.chunks && d.chunks.length > 1 && <ChunkBar d={d} />}
      <div className="meta">
        <span>
          {formatBytes(d.downloaded)} / {formatBytes(d.totalSize)}
        </span>
        {d.status === 'downloading' && <span>{formatBytes(d.speed)}/s</span>}
        {d.status === 'downloading' && <span>ETA {formatDuration(eta)}</span>}
        {d.status === 'downloading' && (
          <span>
            {d.activeConnections ?? 0}/{d.connections} connections
          </span>
        )}
        {d.rangeSupported === false && <span className="warn">Server doesn't support ranges: single connection</span>}
      </div>
      {d.sha256 && (
        <div className="meta">
          <span className="mono" data-testid="sha256">
            SHA-256 {d.sha256}
          </span>
          {d.checksumOk && <span className="ok">matches server checksum</span>}
        </div>
      )}
      {d.error && (
        <p className="bad" role="alert" data-testid="error">
          {d.error}
        </p>
      )}
      <div className="meta mono">{d.url}</div>
    </li>
  );
}

function ChunkBar({ d }: { d: DownloadRecord }) {
  const total = d.totalSize ?? 1;
  return (
    <div className="chunks" aria-hidden="true">
      {d.chunks!.map((c) => {
        const size = c.end - c.start + 1;
        const done = Math.min(1, (c.pos - c.start) / size);
        return (
          <span key={c.start} style={{ flex: size / total }}>
            <i style={{ width: `${done * 100}%` }} />
          </span>
        );
      })}
    </div>
  );
}
