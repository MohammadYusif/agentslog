import { describe, it, expect } from 'vitest';
import { parseWindow, windowCutoffIso, relativeTime, formatDuration } from '../src/utils/time.js';
import { abbreviateNumber, withCommas, truncate, padTo, shortModel, projectLabel } from '../src/utils/format.js';

describe('parseWindow', () => {
  it('parses days/hours/weeks', () => {
    expect(parseWindow('7d')).toBe(7 * 86_400_000);
    expect(parseWindow('24h')).toBe(24 * 3_600_000);
    expect(parseWindow('2w')).toBe(2 * 604_800_000);
    expect(parseWindow('30m')).toBe(30 * 60_000);
  });
  it('returns null for garbage', () => {
    expect(parseWindow('banana')).toBeNull();
    expect(parseWindow(undefined)).toBeNull();
    expect(parseWindow('7')).toBeNull();
  });
});

describe('windowCutoffIso', () => {
  it('computes a cutoff relative to now', () => {
    const now = Date.parse('2026-01-10T00:00:00Z');
    expect(windowCutoffIso('7d', now)).toBe('2026-01-03T00:00:00.000Z');
  });
  it('null window yields null cutoff', () => {
    expect(windowCutoffIso(undefined)).toBeNull();
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  it('formats minutes/hours/days ago', () => {
    expect(relativeTime('2026-01-10T11:00:00Z', now)).toBe('1h ago');
    expect(relativeTime('2026-01-08T12:00:00Z', now)).toBe('2d ago');
    expect(relativeTime('2026-01-10T11:59:30Z', now)).toBe('30s ago');
  });
  it('handles null', () => {
    expect(relativeTime(null, now)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('formats compactly', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
    expect(formatDuration(null)).toBe('-');
  });
});

describe('abbreviateNumber', () => {
  it('abbreviates k/M/B', () => {
    expect(abbreviateNumber(950)).toBe('950');
    expect(abbreviateNumber(1234)).toBe('1.2k');
    expect(abbreviateNumber(47_200)).toBe('47.2k');
    expect(abbreviateNumber(2_100_000)).toBe('2.1M');
    expect(abbreviateNumber(890_000)).toBe('890k');
  });
});

describe('withCommas', () => {
  it('adds thousands separators', () => {
    expect(withCommas(2847)).toBe('2,847');
    expect(withCommas(0)).toBe('0');
  });
});

describe('truncate / padTo', () => {
  it('truncates with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate('hi', 5)).toBe('hi');
  });
  it('pads to fixed width', () => {
    expect(padTo('hi', 5)).toBe('hi   ');
    expect(padTo('toolong', 4)).toBe('too…');
  });
});

describe('shortModel', () => {
  it('strips the claude- prefix', () => {
    expect(shortModel('claude-opus-4-8')).toBe('opus-4-8');
    expect(shortModel(null)).toBe('-');
  });
});

describe('projectLabel', () => {
  it('uses basename of the path when present', () => {
    expect(projectLabel('C:\\Users\\x\\Desktop\\githubmaxxing', 'c--Users-x-Desktop-githubmaxxing')).toBe('githubmaxxing');
  });
  it('falls back to last hash segment', () => {
    expect(projectLabel(null, 'c--Users-x-Desktop-pointly')).toBe('pointly');
  });
});
