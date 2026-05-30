/**
 * `agentslog ingest` — scan every available source and index all sessions.
 *
 * The primary Claude Code source is always scanned; experimental sources
 * (Cline, Aider) are scanned only when their data location exists or is
 * configured. An explicit `--dir` restricts the run to Claude Code over that
 * directory (used by the watcher and tests).
 */
import chalk from 'chalk';
import { openDb, writeSession } from '../../db/index.js';
import { discoverSessionFiles } from '../../parser/index.js';
import {
  availableAdapters,
  claudeCodeAdapter,
  type SourceAdapter,
  type DiscoveredUnit,
} from '../../parser/sources/index.js';
import { abbreviateNumber } from '../../utils/format.js';

export interface IngestOptions {
  /** Override the Claude projects directory (Claude Code only; used by tests). */
  dir?: string;
  /** Suppress per-file error output. */
  quiet?: boolean;
}

/** Run a full ingest pass over every available source. */
export async function runIngest(options: IngestOptions = {}): Promise<void> {
  const db = openDb();

  // Assemble the work: either a single Claude Code directory, or every
  // available adapter's discovered units.
  const work: { adapter: SourceAdapter; units: DiscoveredUnit[] }[] = [];
  if (options.dir) {
    const units = discoverSessionFiles(options.dir).map((f) => ({
      filePath: f.filePath,
      projectHash: f.projectHash,
    }));
    work.push({ adapter: claudeCodeAdapter, units });
  } else {
    for (const adapter of availableAdapters()) {
      work.push({ adapter, units: adapter.discover() });
    }
  }

  const totalUnits = work.reduce((n, w) => n + w.units.length, 0);
  if (totalUnits === 0) {
    process.stdout.write(`${chalk.yellow('No transcripts found')} for any source.\n`);
    return;
  }

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let totalTokens = 0;
  const start = Date.now();

  for (const { adapter, units } of work) {
    const tag = adapter.experimental
      ? `${adapter.label} ${chalk.dim('(experimental)')}`
      : adapter.label;
    process.stdout.write(`${chalk.bold(tag)}: scanning ${units.length} unit(s)…\n`);

    let srcIndexed = 0;
    for (const unit of units) {
      try {
        const sessions = await adapter.parse(unit);
        if (sessions.length === 0) {
          skipped++;
          continue;
        }
        for (const session of sessions) {
          writeSession(db, session);
          srcIndexed++;
          indexed++;
          totalTokens += session.inputTokens + session.outputTokens;
        }
      } catch (err) {
        failed++;
        if (!options.quiet) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`${chalk.red('✗')} ${unit.filePath}: ${msg}\n`);
        }
      }
    }
    process.stdout.write(`  ${chalk.green(String(srcIndexed))} indexed\n`);
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
