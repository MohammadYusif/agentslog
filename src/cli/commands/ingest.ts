/**
 * `agentslog ingest` — scan the Claude projects dir and index all sessions.
 */
import chalk from 'chalk';
import { openDb, writeSession } from '../../db/index.js';
import { discoverSessionFiles, parseSessionFile } from '../../parser/index.js';
import { claudeProjectsDir } from '../../utils/paths.js';
import { abbreviateNumber } from '../../utils/format.js';

export interface IngestOptions {
  /** Override the projects directory (used by tests). */
  dir?: string;
  /** Suppress per-file progress output. */
  quiet?: boolean;
}

/** Run a full ingest pass over every discovered transcript. */
export async function runIngest(options: IngestOptions = {}): Promise<void> {
  const projectsDir = options.dir ?? claudeProjectsDir();
  const db = openDb();

  const files = discoverSessionFiles(projectsDir);
  if (files.length === 0) {
    process.stdout.write(
      `${chalk.yellow('No transcripts found')} under ${chalk.dim(projectsDir)}\n`
    );
    return;
  }

  process.stdout.write(
    `Indexing ${chalk.bold(String(files.length))} transcript file(s) from ${chalk.dim(projectsDir)}…\n`
  );

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let totalTokens = 0;
  const start = Date.now();

  for (const file of files) {
    try {
      const session = await parseSessionFile(file.filePath, file.projectHash);
      if (!session) {
        skipped++;
        continue;
      }
      writeSession(db, session);
      indexed++;
      totalTokens += session.inputTokens + session.outputTokens;
    } catch (err) {
      failed++;
      if (!options.quiet) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${chalk.red('✗')} ${file.filePath}: ${msg}\n`);
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const parts = [
    `${chalk.green(String(indexed))} indexed`,
    skipped ? `${chalk.yellow(String(skipped))} skipped` : null,
    failed ? `${chalk.red(String(failed))} failed` : null,
  ].filter(Boolean);

  process.stdout.write(
    `${chalk.bold('Done')} — ${parts.join(', ')} · ${abbreviateNumber(totalTokens)} tokens · ${elapsed}s\n`
  );
}
