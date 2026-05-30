/**
 * Approximate per-model token pricing and cost estimation.
 *
 * Prices are in USD per **million** tokens and are necessarily approximate:
 * providers change them, and historical sessions may have been billed at
 * different rates. Treat every figure here as an estimate, not an invoice.
 *
 * Users can override or extend the table by placing a `pricing.json` file in
 * the app data directory, or by pointing `AGENTSLOG_PRICING` at a JSON file.
 * The file maps a model-name substring to a {@link ModelPrice}:
 *
 *   { "opus": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { appDataDir } from './paths.js';

/** USD per million tokens for each token bucket. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A token breakdown to price. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Built-in defaults, keyed by a lowercase substring matched against the model
 * id (e.g. "claude-opus-4-8" matches "opus"). Longer keys are tried first so a
 * specific key can override a generic one.
 */
const DEFAULT_PRICING: Record<string, ModelPrice> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

let cachedTable: Record<string, ModelPrice> | null = null;

/** Read and validate an override pricing file, or return null if absent/bad. */
function readOverrideFile(file: string): Record<string, ModelPrice> | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, ModelPrice> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Partial<ModelPrice>;
      out[key.toLowerCase()] = {
        input: Number(v.input) || 0,
        output: Number(v.output) || 0,
        cacheRead: Number(v.cacheRead) || 0,
        cacheWrite: Number(v.cacheWrite) || 0,
      };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The effective pricing table: built-in defaults merged under any user
 * overrides from `AGENTSLOG_PRICING` or `<appData>/pricing.json`. Cached.
 */
export function loadPricing(): Record<string, ModelPrice> {
  if (cachedTable) return cachedTable;
  const merged: Record<string, ModelPrice> = { ...DEFAULT_PRICING };

  const candidates = [
    process.env.AGENTSLOG_PRICING,
    path.join(appDataDir(), 'pricing.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const file of candidates) {
    const override = readOverrideFile(file);
    if (override) Object.assign(merged, override);
  }

  cachedTable = merged;
  return merged;
}

/** Reset the cached table (used by tests). */
export function resetPricingCache(): void {
  cachedTable = null;
}

/** Find the price entry for a model id, or null if no rule matches. */
export function priceForModel(
  model: string | null | undefined,
  table = loadPricing(),
): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  // Prefer the longest matching key so specific rules win over generic ones.
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.includes(key)) return table[key];
  }
  return null;
}

/**
 * Estimate the USD cost of a token breakdown for a given model. Returns null
 * when the model has no known pricing, so callers can show "unknown" rather
 * than a misleading $0.00.
 */
export function estimateCost(
  model: string | null | undefined,
  tokens: TokenCounts,
  table = loadPricing(),
): number | null {
  const price = priceForModel(model, table);
  if (!price) return null;
  const per = 1_000_000;
  return (
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheCreationTokens * price.cacheWrite) /
    per
  );
}

/** Format a USD amount with sensible precision: $12.34, $0.0042, $0. */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return 'n/a';
  if (usd === 0) return '$0';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}
