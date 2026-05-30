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
  const base =
    override && override.trim().length > 0 ? override : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** The VS Code "User" directory that holds globalStorage, per platform. */
function vscodeUserDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

/**
 * Cline (saoudrizwan.claude-dev) task storage directory. Honors
 * AGENTSLOG_CLINE_DIR for non-standard installs (e.g. VS Codium, Cursor).
 */
export function clineTasksDir(): string {
  const override = process.env.AGENTSLOG_CLINE_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(vscodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
}

/**
 * Explicit Aider history locations. Aider writes `.aider.chat.history.md` into
 * each repo, so there is no central registry — the user supplies paths (files
 * or directories to scan) via AGENTSLOG_AIDER_PATHS, delimited by the platform
 * path separator. Returns [] when unset, in which case Aider is not ingested.
 */
export function aiderSearchPaths(): string[] {
  const raw = process.env.AGENTSLOG_AIDER_PATHS;
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
