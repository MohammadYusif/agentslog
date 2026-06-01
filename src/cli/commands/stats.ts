/**
 * `agentslog stats` — aggregate token / tool / file statistics.
 */
import chalk from 'chalk';
import { openDb } from '../../db/index.js';
import { statsTotals, tokensByModel, topFiles, topTools } from '../../db/queries.js';
import { abbreviateNumber, baseName, padTo, withCommas } from '../../utils/format.js';
import { type CostBreakdown, estimateCostBreakdown, formatCost } from '../../utils/pricing.js';
import { windowCutoffIso } from '../../utils/time.js';

export interface StatsOptions {
  last?: string;
  json?: boolean;
}

/** Render aggregate statistics over an optional time window. */
export function runStats(options: StatsOptions = {}): void {
  const db = openDb();
  const sinceIso = windowCutoffIso(options.last);
  const period = options.last ? `last ${options.last}` : 'all time';

  const totals = statsTotals(db, sinceIso);
  const files = topFiles(db, sinceIso, 10);
  const tools = topTools(db, sinceIso, 10);

  // Estimate cost per-model (pricing is per-model) and sum. Track whether any
  // tokens belonged to a model we have no price for, so we can flag the total
  // as a lower bound rather than silently undercounting.
  const byModel = tokensByModel(db, sinceIso);
  const cost: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let hasPricedTokens = false;
  let hasUnpricedTokens = false;
  for (const m of byModel) {
    const b = estimateCostBreakdown(m.model, {
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      cacheReadTokens: m.cache_read_tokens,
      cacheCreationTokens: m.cache_creation_tokens,
    });
    if (b == null) {
      if (m.input_tokens + m.output_tokens > 0) hasUnpricedTokens = true;
    } else {
      cost.input += b.input;
      cost.output += b.output;
      cost.cacheRead += b.cacheRead;
      cost.cacheWrite += b.cacheWrite;
      cost.total += b.total;
      hasPricedTokens = true;
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          period,
          totals,
          estimatedCostUsd: hasPricedTokens ? Number(cost.total.toFixed(4)) : null,
          estimatedCostBreakdownUsd: hasPricedTokens
            ? {
                input: Number(cost.input.toFixed(4)),
                output: Number(cost.output.toFixed(4)),
                cacheWrite: Number(cost.cacheWrite.toFixed(4)),
                cacheRead: Number(cost.cacheRead.toFixed(4)),
              }
            : null,
          costIsLowerBound: hasUnpricedTokens,
          topFiles: files,
          topTools: tools,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const totalTokens = totals.input_tokens + totals.output_tokens;
  const cached = totals.cache_read_tokens;
  const errPct =
    totals.tool_calls > 0 ? ((totals.errors / totals.tool_calls) * 100).toFixed(1) : '0.0';

  const label = (s: string) => chalk.bold.cyan(padTo(s, 12));

  process.stdout.write(`${label('PERIOD')}${period}\n`);
  const sessionsLine =
    totals.subagent_count > 0
      ? `${withCommas(totals.session_count)}  ` +
        chalk.dim(`(+ ${withCommas(totals.subagent_count)} sub-agent run(s))`)
      : withCommas(totals.session_count);
  process.stdout.write(`${label('SESSIONS')}${sessionsLine}\n`);
  process.stdout.write(
    `${label('TOKENS')}${abbreviateNumber(totalTokens)}   ` +
      chalk.dim(
        `(in: ${abbreviateNumber(totals.input_tokens)}  ` +
          `out: ${abbreviateNumber(totals.output_tokens)}  ` +
          `cached: ${abbreviateNumber(cached)})`,
      ) +
      '\n',
  );
  process.stdout.write(
    `${label('TOOLS')}${withCommas(totals.tool_calls)}  ` +
      chalk.dim(`(errors: ${withCommas(totals.errors)}, ${errPct}%)`) +
      '\n',
  );
  if (hasPricedTokens) {
    const note = hasUnpricedTokens ? ' (≥, some models unpriced)' : ' (est.)';
    process.stdout.write(`${label('COST')}${formatCost(cost.total)}${chalk.dim(note)}\n`);
    // Break the total down by bucket — cache reads usually dominate, which is
    // prompt caching saving money rather than wasting it.
    process.stdout.write(
      `${padTo('', 12)}${chalk.dim(
        `input ${formatCost(cost.input)} · output ${formatCost(cost.output)} · ` +
          `cache-write ${formatCost(cost.cacheWrite)} · cache-read ${formatCost(cost.cacheRead)}`,
      )}\n`,
    );
  }

  if (files.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold.cyan(`${padTo('TOP FILES', 34)}TOUCHES\n`));
    for (const f of files) {
      process.stdout.write(`${padTo(baseName(f.label), 34)}${withCommas(f.count)}\n`);
    }
  }

  if (tools.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.bold.cyan(`${padTo('TOP TOOLS', 34)}CALLS\n`));
    for (const t of tools) {
      process.stdout.write(`${padTo(t.label, 34)}${withCommas(t.count)}\n`);
    }
  }
}
