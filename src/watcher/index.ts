/**
 * chokidar-based watcher that re-ingests transcripts as they change.
 */

import type Database from 'better-sqlite3';
import chalk from 'chalk';
import chokidar from 'chokidar';
import { writeSession } from '../db/index.js';
import { parseSessionFile, projectHashForFile } from '../parser/index.js';
import { claudeProjectsDir } from '../utils/paths.js';
import { relativeTime } from '../utils/time.js';

export interface WatchOptions {
  projectsDir?: string;
  /** Debounce window (ms) to coalesce rapid append events per file. */
  debounceMs?: number;
  /** Called after each successful (re)ingest, for logging/testing. */
  onIngest?: (filePath: string) => void;
}

/**
 * Start watching `~/.claude/projects/**` for new and modified `.jsonl` files,
 * re-ingesting each into the database. Returns a stop() function.
 *
 * Appends are debounced per-file: Claude Code writes a transcript line-by-line
 * as a session progresses, so we wait for writes to settle before re-parsing
 * the whole file (parsing is idempotent via INSERT OR REPLACE + delete/insert).
 */
export function startWatcher(
  db: Database.Database,
  options: WatchOptions = {},
): () => Promise<void> {
  const projectsDir = options.projectsDir ?? claudeProjectsDir();
  const debounceMs = options.debounceMs ?? 750;

  const pending = new Map<string, NodeJS.Timeout>();

  const scheduleIngest = (filePath: string) => {
    if (!filePath.endsWith('.jsonl')) return;
    const existing = pending.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pending.delete(filePath);
      void ingestOne(filePath);
    }, debounceMs);
    pending.set(filePath, timer);
  };

  const ingestOne = async (filePath: string) => {
    try {
      const projectHash = projectHashForFile(filePath, projectsDir);
      const session = await parseSessionFile(filePath, projectHash);
      if (!session) return;
      writeSession(db, session);
      const when = relativeTime(session.startedAt);
      const title = session.aiTitle ?? '(untitled)';
      process.stdout.write(
        `${chalk.green('●')} ingested ${chalk.bold(session.id.slice(0, 8))} ` +
          `${chalk.dim(title)} ${chalk.dim(`[${when}]`)}\n`,
      );
      options.onIngest?.(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${chalk.red('✗')} failed to ingest ${filePath}: ${msg}\n`);
    }
  };

  const watcher = chokidar.watch(projectsDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100,
    },
  });

  watcher
    .on('add', scheduleIngest)
    .on('change', scheduleIngest)
    .on('ready', () => {
      process.stdout.write(
        `${chalk.cyan('watching')} ${chalk.dim(projectsDir)} ${chalk.dim('(Ctrl+C to stop)')}\n`,
      );
    })
    .on('error', (err) => {
      const e = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${chalk.red('watcher error:')} ${e}\n`);
    });

  return async () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    await watcher.close();
  };
}
