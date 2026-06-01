import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, writeSession } from '../src/db/index.js';
import {
  computeFlags,
  type EfficiencyMetrics,
  repeatedFailures,
  reviewCandidates,
  sessionEfficiency,
} from '../src/db/queries.js';
import type { ParsedSession, ParsedToolCall } from '../src/parser/types.js';

let dir: string;
let dbFile: string;

function metrics(over: Partial<EfficiencyMetrics> = {}): EfficiencyMetrics {
  return {
    toolCalls: 0,
    errors: 0,
    errorRate: 0,
    reads: 0,
    writes: 0,
    edits: 0,
    tokens: 0,
    durationMs: null,
    maxRepeat: 0,
    ...over,
  };
}

function session(over: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 's1',
    parentSessionId: null,
    source: 'claude-code',
    projectHash: 'h',
    projectPath: '/repo',
    aiTitle: 'A run',
    model: 'claude-opus-4-8',
    ccVersion: null,
    gitBranch: null,
    startedAt: '2026-01-05T00:00:00Z',
    endedAt: '2026-01-05T00:10:00Z',
    durationMs: 600000,
    inputTokens: 0,
    outputTokens: 0,
    lastInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 0,
    errorCount: 0,
    userTurnCount: 1,
    rawPath: '/x.jsonl',
    toolCalls: [],
    filesTouched: [],
    ...over,
  };
}

function failCall(seq: number, command: string): ParsedToolCall {
  return {
    id: String(seq),
    sequenceNum: seq,
    toolName: 'Bash',
    calledAt: '2026-01-05T00:01:00Z',
    success: false,
    filePath: null,
    command,
    errorText: 'boom',
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-rev-'));
  dbFile = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeFlags', () => {
  it('high_error_rate needs >=5 calls and >=30% errors', () => {
    expect(computeFlags(metrics({ toolCalls: 10, errors: 4, errorRate: 0.4 }))).toContain(
      'high_error_rate',
    );
    expect(computeFlags(metrics({ toolCalls: 4, errors: 4, errorRate: 1 }))).not.toContain(
      'high_error_rate',
    );
  });

  it('does NOT flag a deep research session (high tokens, lots of reads, no edits)', () => {
    // 80k tokens, 60 reads, 0 changes — legitimate research, must not flag.
    expect(computeFlags(metrics({ tokens: 80_000, reads: 60 }))).toEqual([]);
  });

  it('flags high_spend_no_activity only when there are no reads AND no changes', () => {
    expect(computeFlags(metrics({ tokens: 40_000 }))).toContain('high_spend_no_activity');
    expect(computeFlags(metrics({ tokens: 40_000, reads: 1 }))).not.toContain(
      'high_spend_no_activity',
    );
  });

  it('flags high_tokens_per_change once there is at least one change', () => {
    expect(computeFlags(metrics({ tokens: 100_000, edits: 1 }))).toContain(
      'high_tokens_per_change',
    );
    expect(computeFlags(metrics({ tokens: 100_000 }))).not.toContain('high_tokens_per_change');
  });

  it('flags repeated_failure at >=3 identical failures', () => {
    expect(computeFlags(metrics({ maxRepeat: 3 }))).toContain('repeated_failure');
    expect(computeFlags(metrics({ maxRepeat: 2 }))).not.toContain('repeated_failure');
  });
});

describe('repeatedFailures + sessionEfficiency', () => {
  it('detects an identical command that kept failing', () => {
    const db = openDb(dbFile);
    writeSession(
      db,
      session({
        toolCallCount: 4,
        errorCount: 3,
        toolCalls: [
          failCall(0, 'ls -Recurse'),
          failCall(1, 'ls -Recurse'),
          failCall(2, 'ls -Recurse'),
          {
            id: '3',
            sequenceNum: 3,
            toolName: 'Bash',
            calledAt: null,
            success: true,
            filePath: null,
            command: 'echo ok',
            errorText: null,
          },
        ],
      }),
    );
    const rf = repeatedFailures(db, 's1');
    expect(rf).toHaveLength(1);
    expect(rf[0]).toMatchObject({ command: 'ls -Recurse', count: 3 });

    const eff = sessionEfficiency(db, 's1')!;
    expect(eff.maxRepeat).toBe(3);
    expect(eff.flags).toContain('repeated_failure');
    db.close();
  });

  it('computes reads/writes/edits from files_touched', () => {
    const db = openDb(dbFile);
    writeSession(
      db,
      session({
        inputTokens: 100_000,
        outputTokens: 0,
        toolCallCount: 2,
        filesTouched: [{ filePath: 'a.ts', readCount: 0, writeCount: 0, editCount: 1 }],
      }),
    );
    const eff = sessionEfficiency(db, 's1')!;
    expect(eff.edits).toBe(1);
    expect(eff.tokens).toBe(100_000);
    expect(eff.flags).toContain('high_tokens_per_change');
    db.close();
  });
});

describe('reviewCandidates', () => {
  it('returns only flagged sessions, most-flagged first', () => {
    const db = openDb(dbFile);
    // Clean session — should not appear.
    writeSession(db, session({ id: 'clean', toolCallCount: 2, errorCount: 0 }));
    // Flagged: high error rate + repeated failure (2 flags).
    writeSession(
      db,
      session({
        id: 'bad',
        toolCallCount: 10,
        errorCount: 5,
        toolCalls: [failCall(0, 'x'), failCall(1, 'x'), failCall(2, 'x')],
      }),
    );
    const out = reviewCandidates(db, null);
    expect(out.map((c) => c.session_id)).toEqual(['bad']);
    expect(out[0].flags).toContain('high_error_rate');
    expect(out[0].flags).toContain('repeated_failure');
    db.close();
  });
});
