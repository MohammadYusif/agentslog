import { describe, expect, it } from 'vitest';
import {
  assertValidSession,
  defineAdapter,
  validateParsedSession,
} from '../src/parser/sources/contract.js';
import type { ParsedSession } from '../src/parser/types.js';

function valid(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 's1',
    parentSessionId: null,
    source: 'test',
    projectHash: 'hash',
    projectPath: '/repo',
    aiTitle: 'A session',
    model: 'claude-opus-4-8',
    ccVersion: null,
    gitBranch: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:10:00Z',
    durationMs: 600000,
    inputTokens: 100,
    outputTokens: 20,
    lastInputTokens: 80,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 1,
    errorCount: 0,
    userTurnCount: 1,
    rawPath: '/repo/x.jsonl',
    toolCalls: [
      {
        id: 't',
        sequenceNum: 0,
        toolName: 'read_file',
        calledAt: null,
        success: true,
        filePath: 'src/a.ts',
        command: null,
        errorText: null,
      },
    ],
    filesTouched: [{ filePath: 'src/a.ts', readCount: 1, writeCount: 0, editCount: 0 }],
    ...overrides,
  };
}

describe('adapter contract', () => {
  it('accepts a well-formed session', () => {
    expect(validateParsedSession(valid())).toEqual([]);
    expect(() => assertValidSession(valid())).not.toThrow();
  });

  it('flags missing/empty required fields', () => {
    const issues = validateParsedSession(valid({ id: '', source: '', startedAt: '' }));
    expect(issues.some((i) => i.startsWith('id:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('source:'))).toBe(true);
    expect(issues.some((i) => i.startsWith('startedAt:'))).toBe(true);
  });

  it('flags negative or non-finite counters', () => {
    expect(validateParsedSession(valid({ inputTokens: -1 }))).toContainEqual(
      expect.stringContaining('inputTokens'),
    );
    expect(validateParsedSession(valid({ errorCount: Number.NaN }))).toContainEqual(
      expect.stringContaining('errorCount'),
    );
  });

  it('flags non-POSIX file paths (backslashes)', () => {
    const issues = validateParsedSession(
      valid({
        filesTouched: [{ filePath: 'src\\a.ts', readCount: 1, writeCount: 0, editCount: 0 }],
      }),
    );
    expect(issues.some((i) => i.includes('POSIX'))).toBe(true);
  });

  it('flags a self-referential parent', () => {
    expect(validateParsedSession(valid({ parentSessionId: 's1' }))).toContainEqual(
      expect.stringContaining('parentSessionId'),
    );
  });

  it('assertValidSession throws with a descriptive message', () => {
    expect(() => assertValidSession(valid({ id: '' }))).toThrow(/invalid ParsedSession/);
  });

  it('defineAdapter returns the adapter unchanged (type-only helper)', () => {
    const a = defineAdapter({
      name: 'noop',
      label: 'Noop',
      experimental: true,
      isAvailable: () => false,
      discover: () => [],
      parse: async () => [],
    });
    expect(a.name).toBe('noop');
  });
});
