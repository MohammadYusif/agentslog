/**
 * `agentslog db <subcommand>` — database maintenance.
 *
 * The reasoning FTS5 index churns as sessions are re-ingested (delete + insert),
 * which fragments free space. `vacuum` reclaims it and keeps queries fast.
 */
import fs from 'node:fs';
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { abbreviateNumber } from '../../utils/format.js';
import { dbPath } from '../../utils/paths.js';

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** `agentslog db vacuum` — VACUUM + PRAGMA optimize, reporting space reclaimed. */
export function runDbVacuum(): void {
  const path = dbPath();
  const before = fileSize(path);
  const db = openDb();
  db.pragma('optimize');
  db.exec('VACUUM');
  const after = fileSize(path);

  const reclaimed = Math.max(0, before - after);
  process.stdout.write(
    `${chalk.bold('Vacuumed')} ${chalk.dim(path)}\n` +
      `  before ${abbreviateNumber(before)}B → after ${abbreviateNumber(after)}B ` +
      `(${chalk.green(`${abbreviateNumber(reclaimed)}B`)} reclaimed)\n`,
  );
}
