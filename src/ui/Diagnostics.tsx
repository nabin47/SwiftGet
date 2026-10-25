import { useRef, useState, type FormEvent } from 'react';
import {
  captureNative,
  redactReport,
  runDiagnostics,
  type CaptureResult,
  type DiagnosticsReport,
} from '../diagnostics/run';

const SIZES = [16, 32, 64, 128, 256];

export function Diagnostics() {
  const [input, setInput] = useState('');
  const [testMb, setTestMb] = useState(64);
  const [nativeCapture, setNativeCapture] = useState(true);
  const [redact, setRedact] = useState(true);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<DiagnosticsReport>();
  const [userCapture, setUserCapture] = useState<CaptureResult>();
  const [waitingClick, setWaitingClick] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const addLog = (line: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);

  async function onRun(e: FormEvent) {
    e.preventDefault();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setLog([]);
    setReport(undefined);
    setCopied(false);
    try {
      await runDiagnostics(
        input,
        { testBytes: testMb * 1048576, connectionCounts: [1, 2, 4, 8], nativeCapture, signal: ac.signal, log: addLog },
        setReport,
      );
      addLog('Done.');
    } finally {
      setRunning(false);
    }
  }

  async function onWaitForClick() {
    const ac = new AbortController();
    abortRef.current = ac;
    setWaitingClick(true);
    setUserCapture(undefined);
    addLog('Waiting up to 2 minutes: click Download in your Google Drive tab (and "Download anyway" if asked).');
    const r = await captureNative(null, ac.signal);
    setUserCapture(r);
    setWaitingClick(false);
    addLog(r.error ? `Capture: ${r.error}` : 'Captured the native download and cancelled it.');
  }

  const full = report ? { ...report, capture: [...report.capture, ...(userCapture ? [userCapture] : [])] } : undefined;
  const shown = full && redact ? redactReport(full) : full;
  const json = shown ? JSON.stringify(shown, null, 2) : '';

  return (
    <main>
      <header>
        <h1>Drive diagnostics</h1>
        <a href="/manager.html">Back to downloads</a>
      </header>
      <p className="muted">
        Paste a Google Drive link (or any direct download URL). The checks use your signed-in session in this
        browser. Results stay on this page; copy the report to share it.
      </p>
      <form className="panel" onSubmit={onRun} aria-label="Run diagnostics">
        <div className="row">
          <input
            type="text"
            aria-label="Drive link or URL"
            placeholder="https://drive.google.com/file/d/…/view"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            required
            data-testid="diag-input"
          />
          <button type="submit" className="primary" disabled={running} data-testid="diag-run">
            {running ? 'Running…' : 'Run'}
          </button>
          {running && (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label>
            Bytes per speed test{' '}
            <select value={testMb} onChange={(e) => setTestMb(Number(e.target.value))}>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} MB
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={nativeCapture} onChange={(e) => setNativeCapture(e.target.checked)} /> Test
            capturing a native download
          </label>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Speed tests run at 1, 2, 4 and 8 connections and download up to {testMb * 4} MB in total.
        </p>
      </form>

      <h2>Capture from a real Drive click</h2>
      <div className="panel row">
        <button type="button" onClick={onWaitForClick} disabled={waitingClick}>
          {waitingClick ? 'Waiting for a download…' : 'Wait for my click in Drive'}
        </button>
        <span className="muted">
          Then start the download from the Drive page. SwiftGet cancels it and checks whether the captured URL can be
          reused.
        </span>
      </div>

      {shown && (
        <>
          <h2>Results</h2>
          <div className="panel">
            {shown.fatal && (
              <p className="bad" role="alert">
                {shown.fatal}
              </p>
            )}
            <table data-testid="diag-checks">
              <tbody>
                <tr>
                  <th>Total size</th>
                  <td data-testid="diag-size">{shown.probe?.totalSize ?? '?'}</td>
                </tr>
                {shown.checks.map((c) => (
                  <tr key={c.name}>
                    <th>{c.name}</th>
                    <td className={c.ok ? 'ok' : c.ok === false ? 'bad' : 'warn'}>
                      {c.ok ? 'Yes' : c.ok === false ? 'No' : 'n/a'} <span className="muted">({c.detail})</span>
                    </td>
                  </tr>
                ))}
                {shown.capture.map((c, i) => (
                  <tr key={i}>
                    <th>Captured URL reusable ({c.how})</th>
                    <td className={c.reuse?.rangeSupported ? 'ok' : 'bad'}>
                      {c.error ?? `status ${c.reuse?.status}, range ${c.reuse?.rangeSupported}, same size ${c.reuse?.sameSize}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.connections.length > 0 && (
              <table style={{ marginTop: 12 }} data-testid="diag-connections">
                <thead>
                  <tr>
                    <th>Connections</th>
                    <th>MB/s</th>
                    <th>Bytes</th>
                    <th>Statuses</th>
                    <th>Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.connections.map((r) => (
                    <tr key={r.connections}>
                      <td>{r.connections}</td>
                      <td>{r.mbps}</td>
                      <td>{r.bytes}</td>
                      <td className="mono">{JSON.stringify(r.statuses)}</td>
                      <td>{r.errors.length ? r.errors.join('; ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <h2>Report</h2>
          <div className="row">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(json);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy report'}
            </button>
            <label>
              <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} /> Redact file IDs
              and tokens
            </label>
          </div>
          <pre data-testid="diag-report">{json}</pre>
        </>
      )}

      {log.length > 0 && (
        <>
          <h2>Log</h2>
          <pre aria-live="polite">{log.join('\n')}</pre>
        </>
      )}
    </main>
  );
}
