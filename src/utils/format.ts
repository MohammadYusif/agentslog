/**
 * Output formatting helpers: number abbreviation, truncation, and fixed-width
 * table rendering with a colored header row.
 */
import path from 'node:path';
import chalk from 'chalk';

/** Abbreviate a token/number count: 1234 -> "1.2k", 2_100_000 -> "2.1M". */
export function abbreviateNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) {
    const v = n / 1000;
    return `${trimDecimal(v)}k`;
  }
  if (abs < 1_000_000_000) {
    const v = n / 1_000_000;
    return `${trimDecimal(v)}M`;
  }
  const v = n / 1_000_000_000;
  return `${trimDecimal(v)}B`;
}

/** Format an integer with thousands separators: 2847 -> "2,847". */
export function withCommas(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function trimDecimal(v: number): string {
  // One decimal place, but drop a trailing ".0".
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Truncate `s` to `width` chars, appending an ellipsis when shortened. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  if (width === 1) return '…';
  return s.slice(0, width - 1) + '…';
}

/** Pad (or truncate) a string to exactly `width` visible characters. */
export function padTo(s: string, width: number): string {
  const t = truncate(s, width);
  return t.padEnd(width, ' ');
}

/** Take the basename of a stored POSIX path for compact display. */
export function baseName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

/** Derive a short, human label for a project from its path or hash. */
export function projectLabel(projectPath: string | null, projectHash: string): string {
  if (projectPath && projectPath.trim().length > 0) {
    const norm = projectPath.replace(/\\/g, '/');
    return path.posix.basename(norm) || norm;
  }
  // Fall back to the last hyphen-delimited segment of the hash.
  const parts = projectHash.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? projectHash;
}

/** Shorten a model id like "claude-opus-4-8" to "opus-4-8". */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '-';
  return model.replace(/^claude-/, '');
}

export interface Column {
  header: string;
  width: number;
  /** Right-align the cell content (used for numeric columns). */
  align?: 'left' | 'right';
}

/** Render a fixed-width table with a bold, colored header row. */
export function renderTable(columns: Column[], rows: string[][]): string {
  const lines: string[] = [];
  const header = columns
    .map((c) => alignCell(c.header, c.width, c.align))
    .join('  ');
  lines.push(chalk.bold.cyan(header));
  for (const row of rows) {
    const line = columns
      .map((c, i) => alignCell(row[i] ?? '', c.width, c.align))
      .join('  ');
    lines.push(line);
  }
  return lines.join('\n');
}

function alignCell(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const t = truncate(value, width);
  return align === 'right' ? t.padStart(width, ' ') : t.padEnd(width, ' ');
}
