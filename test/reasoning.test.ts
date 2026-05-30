import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, writeSession } from '../src/db/index.js';
import { searchReasoning } from '../src/db/queries.js';
import { parseSessionFile } from '../src/parser/claude-code.js';
import type { ParsedSession } from '../src/parser/types.js';

let tmpDirs: string[] = [];
function fixture(events: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-rsn-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  return file;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  delete process.env.AGENTSLOG_INDEX_REASONING;
});

const events = [
  {
    type: 'user',
    sessionId: 'r1',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'hi' },
  },
  {
    type: 'assistant',
    sessionId: 'r1',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [
        {
          type: 'thinking',
          thinking: 'I should use a streaming parser to avoid memory blowups.',
          signature: 'x',
        },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
      ],
    },
  },
];

describe('reasoning capture (opt-in)', () => {
  it('does NOT capture thinking when the env var is unset', async () => {
    delete process.env.AGENTSLOG_INDEX_REASONING;
    const s = (await parseSessionFile(fixture(events), 'h'))!;
    expect(s.reasoning).toBeUndefined();
  });

  it('captures thinking when AGENTSLOG_INDEX_REASONING is set', async () => {
    process.env.AGENTSLOG_INDEX_REASONING = '1';
    const s = (await parseSessionFile(fixture(events), 'h'))!;
    expect(s.reasoning).toBeDefined();
    expect(s.reasoning).toHaveLength(1);
    expect(s.reasoning?.[0]).toMatchObject({
      sequenceNum: 0,
      text: expect.stringContaining('streaming parser'),
    });
  });
});

describe('searchReasoning (FTS5)', () => {
  function makeSession(id: string, text: string): ParsedSession {
    return {
      id,
      parentSessionId: null,
      source: 'claude-code',
      projectHash: 'h',
      projectPath: '/repo',
      aiTitle: `Session ${id}`,
      model: null,
      ccVersion: null,
      gitBranch: null,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
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
      reasoning: [{ sequenceNum: 0, text }],
    };
  }

  it('finds sessions by reasoning keyword and returns a snippet', () => {
    const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-rdb-')), 'db.sqlite');
    const db = openDb(dbFile);
    writeSession(db, makeSession('a', 'We chose natural sort to fix the chunk ordering bug.'));
    writeSession(db, makeSession('b', 'The token accounting sums every usage block.'));

    const hits = searchReasoning(db, 'ordering');
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBe('a');
    expect(hits[0].snippet).toContain('[ordering]');

    expect(searchReasoning(db, 'token')).toHaveLength(1);
    // Re-ingest is idempotent: reasoning is replaced, not duplicated.
    writeSession(db, makeSession('a', 'We chose natural sort to fix the chunk ordering bug.'));
    expect(searchReasoning(db, 'ordering')).toHaveLength(1);
    db.close();
  });

  it('tolerates punctuation/operators in the query (no FTS5 syntax error)', () => {
    const dbFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-rdb2-')),
      'db.sqlite',
    );
    const db = openDb(dbFile);
    writeSession(db, makeSession('a', 'reasoning about parsers and FTS5'));
    expect(() => searchReasoning(db, 'parsers AND (FTS5) OR "*"')).not.toThrow();
    expect(searchReasoning(db, 'parsers').length).toBe(1);
    db.close();
  });
});
