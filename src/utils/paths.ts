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

/**
 * Absolute path to the SQLite database file. Honors AGENTSLOG_DB to relocate
 * the database (also lets tests point the standalone writer at a temp file).
 */
export function dbPath(): string {
  const override = process.env.AGENTSLOG_DB;
  if (override && override.trim().length > 0) return override;
  const { data } = envPaths('agentslog', { suffix: '' });
  return path.join(data, 'agentslog.db');
}

/**
 * The Claude configuration directory (`~/.claude`), honoring CLAUDE_CONFIG_DIR.
 * Shared base for the projects dir, the global CLAUDE.md, and settings.json.
 */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.trim().length > 0 ? override : path.join(os.homedir(), '.claude');
}

/**
 * Absolute path to the Claude Code projects directory:
 * `~/.claude/projects`. Honors CLAUDE_CONFIG_DIR if set.
 */
export function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects');
}

/** Absolute path to the global Claude memory file (`~/.claude/CLAUDE.md`). */
export function globalClaudeMd(): string {
  return path.join(claudeConfigDir(), 'CLAUDE.md');
}

/** Absolute path to the user-scope Claude settings (`~/.claude/settings.json`). */
export function claudeSettingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
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
