import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, writeSession } from '../src/db/index.js';
import {
  aggregateWindow,
  firstAgentslogUseIso,
  getMeta,
  setMeta,
  setMetaIfAbsent,
} from '../src/db/queries.js';
import type { ParsedSession, ParsedToolCall } from '../src/parser/types.js';

let dir: string;
let dbFile: string;

function tool(seq: number, name: string): ParsedToolCall {
  return {
    id: String(seq),
    sequenceNum: seq,
    toolName: name,
    calledAt: '2026-02-01T00:01:00Z',
    success: true,
    filePath: null,
    command: null,
    errorText: null,
  };
}

function session(over: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 's',
    parentSessionId: null,
    source: 'claude-code',
    projectHash: 'h',
    projectPath: '/repo',
    aiTitle: 'run',
    model: 'claude-opus-4-8',
    ccVersion: null,
    gitBranch: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:10:00Z',
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-impact-'));
  dbFile = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('meta store', () => {
  it('get/set/round-trips and setMetaIfAbsent does not overwrite', () => {
    const db = openDb(dbFile);
    expect(getMeta(db, 'setup_at')).toBeNull();
    setMeta(db, 'setup_at', 'first');
    expect(getMeta(db, 'setup_at')).toBe('first');
    expect(setMetaIfAbsent(db, 'setup_at', 'second')).toBe('first');
    expect(getMeta(db, 'setup_at')).toBe('first');
    db.close();
  });
});

describe('firstAgentslogUseIso', () => {
  it('is null until a session calls an agentslog MCP tool', () => {
    const db = openDb(dbFile);
    writeNormal(db);
    expect(firstAgentslogUseIso(db)).toBeNull();
    db.close();
  });

  it('returns the start time of the first agentslog-using session', () => {
    const db = openDb(dbFile);
    writeNormal(db);
    writeSession(
      db,
      session({
        id: 'after',
        startedAt: '2026-02-01T00:00:00Z',
        toolCallCount: 1,
        toolCalls: [tool(0, 'mcp__agentslog__recent_errors')],
      }),
    );
    expect(firstAgentslogUseIso(db)).toBe('2026-02-01T00:00:00Z');
    db.close();
  });
});

describe('aggregateWindow cohorts', () => {
  it('splits sessions into before/after a cutover (half-open)', () => {
    const db = openDb(dbFile);
    // Before: 1 session, 10 tool calls, 2 errors, 1000 tokens.
    writeSession(
      db,
      session({
        id: 'before',
        startedAt: '2026-01-01T00:00:00Z',
        toolCallCount: 10,
        errorCount: 2,
        inputTokens: 600,
        outputTokens: 400,
      }),
    );
    // After: 1 session, 4 tool calls, 0 errors, 500 tokens.
    writeSession(
      db,
      session({
        id: 'after',
        startedAt: '2026-02-01T00:00:00Z',
        toolCallCount: 4,
        errorCount: 0,
        inputTokens: 300,
        outputTokens: 200,
      }),
    );

    const cut = '2026-01-15T00:00:00Z';
    const before = aggregateWindow(db, { toIso: cut });
    const after = aggregateWindow(db, { fromIso: cut });

    expect(before.session_count).toBe(1);
    expect(before.tool_calls).toBe(10);
    expect(before.errors).toBe(2);
    expect(before.tokens).toBe(1000);

    expect(after.session_count).toBe(1);
    expect(after.tool_calls).toBe(4);
    expect(after.tokens).toBe(500);
    db.close();
  });
});

function writeNormal(db: ReturnType<typeof openDb>): void {
  writeSession(db, session({ id: 'plain', toolCallCount: 1, toolCalls: [tool(0, 'Bash')] }));
}
