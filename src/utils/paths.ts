/**
 * Cross-platform path helpers for the app database and the Claude projects dir.
 */
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';

/** Application data directory provided by env-paths (no suffix). */
export function appDataDir(): string {
  const { data } = envPaths('agentslog', { suffix: '' });
  return data;
}

/** Absolute path to the SQLite database file. */
export function dbPath(): string {
  const { data } = envPaths('agentslog', { suffix: '' });
  return path.join(data, 'agentslog.db');
}

/**
 * Absolute path to the Claude Code projects directory:
 * `~/.claude/projects`. Honors CLAUDE_CONFIG_DIR if set.
 */
export function claudeProjectsDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  const base = override && override.trim().length > 0 ? override : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}
