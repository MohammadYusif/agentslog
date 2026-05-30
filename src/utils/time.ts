/**
 * Time parsing and relative/duration formatting helpers.
 */

/** Parse a "Nd" / "Nh" / "Nm" / "Nw" window into milliseconds, or null. */
export function parseWindow(spec: string | undefined): number | null {
  if (!spec) return null;
  const m = /^(\d+)\s*([smhdw])$/i.exec(spec.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factors: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * factors[unit];
}

/** Compute the ISO cutoff timestamp for a "--last" window, or null. */
export function windowCutoffIso(spec: string | undefined, now = Date.now()): string | null {
  const ms = parseWindow(spec);
  if (ms == null) return null;
  return new Date(now - ms).toISOString();
}

/** Format an ISO timestamp as a compact relative time like "2h ago". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '-';
  const diff = now - t;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

/** Format a duration in ms as a compact human string like "1h 3m" or "12s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}
