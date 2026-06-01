/**
 * `agentslog impact` — contrast your agent activity *before* vs *after* you
 * started using agentslog. The cutover is auto-detected from the first session
 * that actually called an agentslog MCP tool, falling back to the recorded
 * `setup_at`. Honest framing: this is correlational, not proof of causation.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import {
  aggregateWindow,
  firstAgentslogUseIso,
  getMeta,
  type WindowAggregate,
} from '../../db/queries.js';
import { abbreviateNumber } from '../../utils/format.js';
import { windowCutoffIso } from '../../utils/time.js';

export interface ImpactOptions {
  /** Override the cutover: a window (e.g. "30d") or an ISO date. */
  since?: string;
  json?: boolean;
}

interface CohortMetrics {
  sessions: number;
  toolCalls: number;
  tokens: number;
  errors: number;
  avgToolCalls: number;
  avgTokens: number;
  avgErrors: number;
  errorRate: number;
}

function metrics(a: WindowAggregate): CohortMetrics {
  const s = a.session_count || 0;
  const div = s > 0 ? s : 1;
  return {
    sessions: s,
    toolCalls: a.tool_calls,
    tokens: a.tokens,
    errors: a.errors,
    avgToolCalls: a.tool_calls / div,
    avgTokens: a.tokens / div,
    avgErrors: a.errors / div,
    errorRate: a.tool_calls > 0 ? a.errors / a.tool_calls : 0,
  };
}

/** Resolve the cutover ISO from --since, else first agentslog use, else setup_at. */
function resolveCutover(
  db: ReturnType<typeof openDb>,
  since?: string,
): { iso: string; source: string } | null {
  if (since) {
    // Accept a relative window ("30d") or a literal date.
    const win = windowCutoffIso(since);
    if (win) return { iso: win, source: `--since ${since}` };
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) return { iso: d.toISOString(), source: `--since ${since}` };
    return null;
  }
  const used = firstAgentslogUseIso(db);
  if (used) return { iso: used, source: 'first agentslog tool use' };
  const setup = getMeta(db, 'setup_at');
  if (setup) return { iso: setup, source: 'setup date' };
  return null;
}

function pct(before: number, after: number): number | null {
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

/** Format a percentage delta; lower-is-better metrics are green when negative. */
function delta(before: number, after: number, lowerIsBetter: boolean): string {
  const p = pct(before, after);
  if (p == null) return chalk.dim('n/a');
  const rounded = `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
  const good = lowerIsBetter ? p < 0 : p > 0;
  if (Math.abs(p) < 0.05) return chalk.dim('~0%');
  return good ? chalk.green(rounded) : chalk.red(rounded);
}

export function runImpact(opts: ImpactOptions = {}): void {
  const db = openDb();
  const cut = resolveCutover(db, opts.since);

  if (!cut) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ cutover: null, before: null, after: null })}\n`);
      return;
    }
    process.stdout.write(
      `${chalk.yellow('No adoption baseline yet.')}\n` +
        'Run `agentslog setup` (or start using the agentslog tools), then check back —\n' +
        'or pass an explicit baseline with `--since 30d` / `--since 2026-01-01`.\n',
    );
    return;
  }

  const before = metrics(aggregateWindow(db, { toIso: cut.iso }));
  const after = metrics(aggregateWindow(db, { fromIso: cut.iso }));

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        cutover: cut.iso,
        cutoverSource: cut.source,
        before,
        after,
        deltas: {
          avgToolCalls: pct(before.avgToolCalls, after.avgToolCalls),
          avgTokens: pct(before.avgTokens, after.avgTokens),
          errorRate: pct(before.errorRate, after.errorRate),
        },
      })}\n`,
    );
    return;
  }

  const date = cut.iso.slice(0, 10);
  process.stdout.write(`${chalk.bold('agentslog impact')} — before vs after adoption\n`);
  process.stdout.write(`${chalk.dim(`cutover: ${date} (${cut.source})`)}\n\n`);

  if (after.sessions === 0) {
    process.stdout.write(
      `${chalk.yellow('Not enough post-adoption data yet')} — only ${before.sessions} session(s) before the cutover and none after.\nKeep using agentslog and check back.\n`,
    );
    return;
  }
  if (before.sessions === 0) {
    process.stdout.write(
      `${chalk.yellow('No pre-adoption data')} — every indexed session is after the cutover, so there's nothing to compare against.\n`,
    );
    return;
  }

  const rows: { label: string; before: string; after: string; delta: string }[] = [
    {
      label: 'Sessions',
      before: String(before.sessions),
      after: String(after.sessions),
      delta: chalk.dim('—'),
    },
    {
      label: 'Avg tool calls / session',
      before: before.avgToolCalls.toFixed(1),
      after: after.avgToolCalls.toFixed(1),
      delta: delta(before.avgToolCalls, after.avgToolCalls, true),
    },
    {
      label: 'Avg tokens / session',
      before: abbreviateNumber(Math.round(before.avgTokens)),
      after: abbreviateNumber(Math.round(after.avgTokens)),
      delta: delta(before.avgTokens, after.avgTokens, true),
    },
    {
      label: 'Error rate',
      before: `${(before.errorRate * 100).toFixed(1)}%`,
      after: `${(after.errorRate * 100).toFixed(1)}%`,
      delta: delta(before.errorRate, after.errorRate, true),
    },
    {
      label: 'Avg errors / session',
      before: before.avgErrors.toFixed(1),
      after: after.avgErrors.toFixed(1),
      delta: delta(before.avgErrors, after.avgErrors, true),
    },
  ];

  const w = Math.max(...rows.map((r) => r.label.length));
  process.stdout.write(
    `  ${' '.repeat(w)}   ${chalk.dim('BEFORE')}      ${chalk.dim('AFTER')}      ${chalk.dim('Δ')}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `  ${r.label.padEnd(w)}   ${r.before.padStart(6)}    ${r.after.padStart(6)}    ${r.delta}\n`,
    );
  }

  process.stdout.write(
    `\n${chalk.dim('Note: a correlation, not a controlled experiment — many things change a workflow over time.')}\n`,
  );
}
