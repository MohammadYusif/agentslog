import { describe, it, expect } from 'vitest';
import {
  estimateCost,
  priceForModel,
  formatCost,
  loadPricing,
} from '../src/utils/pricing.js';

describe('pricing', () => {
  it('matches a model id to its price by substring', () => {
    expect(priceForModel('claude-opus-4-8')!.input).toBe(15);
    expect(priceForModel('claude-sonnet-4-6')!.output).toBe(15);
    expect(priceForModel('claude-3-5-haiku')!.input).toBe(0.8);
  });

  it('returns null for an unknown model', () => {
    expect(priceForModel('gpt-4o')).toBeNull();
    expect(estimateCost('gpt-4o', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });

  it('computes cost across all four token buckets', () => {
    // 1M input @15 + 1M output @75 + 1M cacheRead @1.5 + 1M cacheWrite @18.75
    const cost = estimateCost('claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75, 5);
  });

  it('prefers the longest matching pricing key', () => {
    const table = { ...loadPricing(), 'opus-4-8': { input: 99, output: 1, cacheRead: 0, cacheWrite: 0 } };
    expect(priceForModel('claude-opus-4-8', table)!.input).toBe(99);
  });

  it('formats USD with sensible precision', () => {
    expect(formatCost(0)).toBe('$0');
    expect(formatCost(12.345)).toBe('$12.35');
    expect(formatCost(0.0123)).toBe('$0.012');
    expect(formatCost(0.00042)).toBe('$0.0004');
    expect(formatCost(null)).toBe('n/a');
  });
});
