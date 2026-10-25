/** Sliding-window throughput estimate. */
export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = [];

  constructor(private readonly windowMs = 5000) {}

  /** Records the cumulative byte count at time `t`. Returns bytes/second. */
  sample(bytes: number, t = Date.now()): number {
    this.samples.push({ t, bytes });
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift();
    return this.rate();
  }

  rate(): number {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0]!;
    const b = this.samples[this.samples.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    return dt > 0 ? Math.max(0, (b.bytes - a.bytes) / dt) : 0;
  }
}

export function etaSeconds(downloaded: number, total: number | null, bytesPerSec: number): number | null {
  if (total === null || bytesPerSec <= 0) return null;
  return Math.max(0, (total - downloaded) / bytesPerSec);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return '—';
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${r}s` : `${r}s`;
}
