/**
 * `agentslog lessons` / `agentslog lesson <add|rm|export>` — manage the durable
 * lessons the agent learns. Lessons live only in the local DB; `export` is the
 * human-reviewed path to copy good ones into CLAUDE.md.
 */
import path from 'node:path';
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { insertLesson, type LessonRow, listLessons, removeLesson } from '../../db/queries.js';
import { normalizePath } from '../../parser/claude-code.js';
import { truncate } from '../../utils/format.js';

/** The project scope key for the current working directory. */
export function currentProjectScope(): string {
  return normalizePath(process.cwd());
}

function scopeLabel(scope: string): string {
  return scope === 'global' ? 'global' : path.posix.basename(scope) || scope;
}

export interface LessonsListOptions {
  project?: boolean;
  global?: boolean;
  all?: boolean;
  json?: boolean;
}

/** `agentslog lessons` — list lessons. */
export function runLessonsList(options: LessonsListOptions = {}): void {
  const db = openDb();
  let rows: LessonRow[];
  if (options.global) rows = listLessons(db, { scope: 'global', includeGlobal: false });
  else if (options.project) rows = listLessons(db, { scope: currentProjectScope() });
  else rows = listLessons(db, {}); // all

  if (options.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(chalk.yellow('No lessons recorded yet.\n'));
    return;
  }
  for (const l of rows) {
    const tag =
      l.source === 'auto'
        ? chalk.magenta('[auto]')
        : l.source === 'user'
          ? chalk.blue('[you]')
          : chalk.cyan('[agent]');
    process.stdout.write(
      `${chalk.dim(`#${l.id}`)} ${tag} ${chalk.dim(`${scopeLabel(l.scope)}${l.tool ? `/${l.tool}` : ''} · ${l.hits} hits`)}\n`,
    );
    process.stdout.write(`  ${l.rule}\n`);
    if (l.trigger) process.stdout.write(chalk.dim(`  ↳ trigger: ${l.trigger}\n`));
    process.stdout.write('\n');
  }
  process.stdout.write(chalk.dim(`${rows.length} lesson(s)\n`));
}

export interface LessonAddOptions {
  rule?: string;
  tool?: string;
  trigger?: string;
  rationale?: string;
  project?: boolean;
}

/** `agentslog lesson add` — record a lesson by hand. */
export function runLessonAdd(options: LessonAddOptions = {}): void {
  if (!options.rule || options.rule.trim().length === 0) {
    process.stderr.write(chalk.red('Provide --rule "<the lesson>".\n'));
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  const id = insertLesson(db, {
    rule: options.rule.trim(),
    tool: options.tool ?? null,
    trigger: options.trigger ?? null,
    rationale: options.rationale ?? null,
    source: 'user',
    scope: options.project ? currentProjectScope() : 'global',
    confidence: 1.0,
  });
  process.stdout.write(`${chalk.green('Recorded')} lesson ${chalk.dim(`#${id}`)}.\n`);
}

/** `agentslog lesson rm <id>` — delete a lesson. */
export function runLessonRemove(idArg: string): void {
  const id = Number(idArg);
  if (!Number.isInteger(id)) {
    process.stderr.write(chalk.red(`Invalid id "${idArg}".\n`));
    process.exitCode = 1;
    return;
  }
  const db = openDb();
  process.stdout.write(
    removeLesson(db, id)
      ? `${chalk.green('Removed')} lesson #${id}.\n`
      : chalk.yellow(`No lesson #${id}.\n`),
  );
}

export interface LessonExportOptions {
  project?: boolean;
}

/** `agentslog lesson export` — markdown bullets for pasting into CLAUDE.md. */
export function runLessonExport(options: LessonExportOptions = {}): void {
  const db = openDb();
  const rows = options.project
    ? listLessons(db, { scope: currentProjectScope() })
    : listLessons(db, {});
  if (rows.length === 0) {
    process.stdout.write(chalk.yellow('No lessons to export.\n'));
    return;
  }
  process.stdout.write('## Lessons (from agentslog)\n\n');
  for (const l of rows) {
    const ctx = l.trigger ? ` _(${truncate(l.trigger, 40)})_` : '';
    process.stdout.write(`- ${l.rule}${ctx}\n`);
  }
}
