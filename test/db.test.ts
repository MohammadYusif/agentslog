import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, writeSession, closeDb } from '../src/db/index.js';
import {
  listSessions,
  sessionsByFile,
  sessionsByTool,
  statsTotals,
  resolveSession,
  toolCallsForSession,
} from '../src/db/queries.js';
import type { ParsedSession } from '../src/parser/types.js';

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 'sess-1111',
    projectHash: 'hashX',
    projectPath: 'C:/proj',
    aiTitle: 'Test Session',
    model: 'claude-opus-4-8',
    ccVersion: '2.1.156',
    gitBranch: 'main',
    startedAt: '2026-01-05T00:00:00Z',
    endedAt: '2026-01-05T00:10:00Z',
    durationMs: 600_000,
    inputTokens: 1000,
    outputTokens: 200,
    lastInputTokens: 800,
    cacheReadTokens: 50,
    cacheCreationTokens: 20,
    toolCallCount: 2,
    errorCount: 1,
    userTurnCount: 3,
    rawPath: 'C:/proj/.jsonl',
    toolCalls: [
      { id: 'a', sequenceNum: 0, toolName: 'Read', calledAt: null, success: true, filePath: '/repo/CLAUDE.md', command: null, errorText: null },
      { id: 'b', sequenceNum: 1, toolName: 'Bash', calledAt: null, success: false, filePath: null, command: 'ls', errorText: 'boom' },
    ],
    filesTouched: [
      { filePath: '/repo/CLAUDE.md', readCount: 1, writeCount: 0, editCount: 0 },
    ],
    ...overrides,
  };
}

let dbFile: string;
let dbDir: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-db-'));
  dbFile = path.join(dbDir, 'test.db');
});

afterEach(() => {
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('db write + query', () => {
  it('writes a session and lists it back', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession());
    const rows = listSessions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].ai_title).toBe('Test Session');
    expect(rows[0].input_tokens).toBe(1000);
    db.close();
  });

  it('re-ingesting the same session is idempotent (no duplicate tool_calls)', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession());
    writeSession(db, makeSession()); // second time
    const rows = listSessions(db);
    expect(rows).toHaveLength(1);
    const tcs = toolCallsForSession(db, 'sess-1111');
    expect(tcs).toHaveLength(2); // not 4
    expect(tcs.map((t) => t.sequence_num)).toEqual([0, 1]);
    db.close();
  });

  it('finds sessions by file basename', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession());
    const rows = sessionsByFile(db, 'CLAUDE.md');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('sess-1111');
    db.close();
  });

  it('finds sessions by tool name case-insensitively', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession());
    expect(sessionsByTool(db, 'bash')).toHaveLength(1);
    expect(sessionsByTool(db, 'Read')).toHaveLength(1);
    expect(sessionsByTool(db, 'Glob')).toHaveLength(0);
    db.close();
  });

  it('aggregates stats totals', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession());
    writeSession(db, makeSession({ id: 'sess-2222', inputTokens: 500, outputTokens: 100, toolCallCount: 1, errorCount: 0 }));
    const totals = statsTotals(db);
    expect(totals.session_count).toBe(2);
    expect(totals.input_tokens).toBe(1500);
    expect(totals.output_tokens).toBe(300);
    expect(totals.tool_calls).toBe(3);
    expect(totals.errors).toBe(1);
    db.close();
  });

  it('resolves a session by id prefix and reports ambiguity', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession({ id: 'abcd-1' }));
    writeSession(db, makeSession({ id: 'abcd-2' }));
    expect(resolveSession(db, 'abcd-1')!.id).toBe('abcd-1');
    expect(() => resolveSession(db, 'abcd')).toThrow(/Ambiguous/);
    expect(resolveSession(db, 'zzzz')).toBeNull();
    db.close();
  });

  it('applies time-window filter', () => {
    const db = openDb(dbFile);
    writeSession(db, makeSession({ id: 'old', startedAt: '2020-01-01T00:00:00Z' }));
    writeSession(db, makeSession({ id: 'new', startedAt: '2026-01-05T00:00:00Z' }));
    const rows = listSessions(db, { sinceIso: '2026-01-01T00:00:00Z' });
    expect(rows.map((r) => r.id)).toEqual(['new']);
    db.close();
  });
});
