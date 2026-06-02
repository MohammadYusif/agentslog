import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { odysseusAdapter, parseOdysseusDb } from '../src/parser/sources/odysseus.js';
import { odysseusDbPath } from '../src/utils/paths.js';

interface SessRow {
  id: string;
  name?: string | null;
  model?: string | null;
  owner?: string | null;
  archived?: number;
  mode?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
}

interface MsgRow {
  id: string;
  session_id: string;
  role: string;
  content?: string;
  metadata?: string | null;
  timestamp?: string | null;
}

let tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-ody-'));
  tmpDirs.push(d);
  return d;
}

function makeDb(dir: string, sessions: SessRow[], messages: MsgRow[]): string {
  const dbPath = path.join(dir, 'app.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, model TEXT, owner TEXT,
      archived INTEGER DEFAULT 0, mode TEXT, created_at TEXT, updated_at TEXT,
      last_message_at TEXT, total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0, endpoint_url TEXT DEFAULT '');
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT,
      content TEXT NOT NULL DEFAULT '', metadata TEXT, timestamp TEXT);
  `);
  const insertSess = db.prepare(
    'INSERT INTO sessions (id, name, model, owner, archived, mode, created_at, updated_at, last_message_at, total_input_tokens, total_output_tokens, endpoint_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const s of sessions) {
    insertSess.run(
      s.id,
      s.name ?? null,
      s.model ?? null,
      s.owner ?? null,
      s.archived ?? 0,
      s.mode ?? null,
      s.created_at ?? null,
      s.updated_at ?? null,
      s.last_message_at ?? null,
      s.total_input_tokens ?? 0,
      s.total_output_tokens ?? 0,
      '',
    );
  }
  const insertMsg = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, metadata, timestamp) VALUES (?,?,?,?,?,?)',
  );
  for (const m of messages) {
    insertMsg.run(
      m.id,
      m.session_id,
      m.role,
      m.content ?? '',
      m.metadata ?? null,
      m.timestamp ?? null,
    );
  }
  db.close();
  return dbPath;
}

beforeEach(() => {
  delete process.env.AGENTSLOG_ODYSSEUS_DB;
});

afterEach(() => {
  delete process.env.AGENTSLOG_ODYSSEUS_DB;
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('odysseusDbPath', () => {
  it('returns null when env var unset', () => {
    delete process.env.AGENTSLOG_ODYSSEUS_DB;
    expect(odysseusDbPath()).toBeNull();
  });
});

describe('odysseusAdapter.isAvailable', () => {
  it('returns false when env var unset', () => {
    delete process.env.AGENTSLOG_ODYSSEUS_DB;
    expect(odysseusAdapter.isAvailable()).toBe(false);
  });

  it("returns false when file doesn't exist", () => {
    process.env.AGENTSLOG_ODYSSEUS_DB = path.join(tmp(), 'does-not-exist.db');
    expect(odysseusAdapter.isAvailable()).toBe(false);
  });

  it('returns true when DB exists', () => {
    const dbPath = makeDb(tmp(), [{ id: 's1' }], []);
    process.env.AGENTSLOG_ODYSSEUS_DB = dbPath;
    expect(odysseusAdapter.isAvailable()).toBe(true);
  });
});

describe('odysseusAdapter.discover', () => {
  it('returns empty when unavailable', () => {
    delete process.env.AGENTSLOG_ODYSSEUS_DB;
    expect(odysseusAdapter.discover()).toEqual([]);
  });

  it('returns one unit when available', () => {
    const dbPath = makeDb(tmp(), [{ id: 's1' }], []);
    process.env.AGENTSLOG_ODYSSEUS_DB = dbPath;
    const units = odysseusAdapter.discover();
    expect(units).toHaveLength(1);
    expect(units[0].filePath).toBe(path.resolve(dbPath));
    expect(units[0].projectHash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parseOdysseusDb', () => {
  it('maps basic session fields', async () => {
    const dbPath = makeDb(
      tmp(),
      [
        {
          id: 's1',
          name: 'Fix the auth bug',
          model: 'qwen3:30b',
          created_at: '2024-05-01T12:00:00Z',
          last_message_at: '2024-05-01T12:05:00Z',
          total_input_tokens: 1200,
          total_output_tokens: 350,
        },
      ],
      [
        { id: 'm1', session_id: 's1', role: 'user', timestamp: '2024-05-01T12:00:00Z' },
        {
          id: 'm2',
          session_id: 's1',
          role: 'assistant',
          metadata: JSON.stringify({ input_tokens: 1200, output_tokens: 350 }),
          timestamp: '2024-05-01T12:05:00Z',
        },
      ],
    );
    const sessions = await parseOdysseusDb(dbPath);
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe('odysseus-s1');
    expect(s.source).toBe('odysseus');
    expect(s.aiTitle).toBe('Fix the auth bug');
    expect(s.model).toBe('qwen3:30b');
    expect(s.inputTokens).toBe(1200);
    expect(s.outputTokens).toBe(350);
    expect(s.userTurnCount).toBe(1);
    expect(s.durationMs).toBe(5 * 60 * 1000);
  });

  it('extracts tool events', async () => {
    const dbPath = makeDb(
      tmp(),
      [{ id: 's1', name: 'tools', created_at: '2024-05-01T12:00:00Z' }],
      [
        {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          timestamp: '2024-05-01T12:00:01Z',
          metadata: JSON.stringify({
            tool_events: [
              { round: 1, tool: 'bash', command: 'ls -la /app', output: 'total 12', exit_code: 0 },
              {
                round: 1,
                tool: 'read_file',
                command: '/app/src/auth.py',
                output: 'boom: file not found',
                exit_code: 1,
              },
            ],
          }),
        },
      ],
    );
    const [s] = await parseOdysseusDb(dbPath);
    expect(s.toolCallCount).toBe(2);
    expect(s.errorCount).toBe(1);
    expect(s.toolCalls).toHaveLength(2);
    expect(s.toolCalls[0].toolName).toBe('bash');
    expect(s.toolCalls[0].success).toBe(true);
    expect(s.toolCalls[0].command).toBe('ls -la /app');
    expect(s.toolCalls[0].sequenceNum).toBe(0);
    expect(s.toolCalls[1].toolName).toBe('read_file');
    expect(s.toolCalls[1].success).toBe(false);
    expect(s.toolCalls[1].errorText).toContain('boom');
    expect(s.toolCalls[1].sequenceNum).toBe(1);
  });

  it('aggregates filesTouched', async () => {
    const dbPath = makeDb(
      tmp(),
      [{ id: 's1', name: 'files', created_at: '2024-05-01T12:00:00Z' }],
      [
        {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          timestamp: '2024-05-01T12:00:01Z',
          metadata: JSON.stringify({
            tool_events: [
              {
                round: 1,
                tool: 'read_file',
                command: '/app/src/auth.py',
                output: '...',
                exit_code: 0,
              },
              {
                round: 2,
                tool: 'edit_document',
                command: 'Fix the bug',
                output: 'Document edited',
                exit_code: 0,
                doc_id: 'abc123',
                doc_title: 'auth.py',
              },
            ],
          }),
        },
      ],
    );
    const [s] = await parseOdysseusDb(dbPath);
    const byPath = new Map(s.filesTouched.map((f) => [f.filePath, f]));
    expect(byPath.get('/app/src/auth.py')?.readCount).toBe(1);
    expect(byPath.get('odysseus-docs/auth.py')?.editCount).toBe(1);
  });

  it('skips sessions with no messages', async () => {
    const dbPath = makeDb(
      tmp(),
      [
        { id: 's1', name: 'empty', created_at: '2024-05-01T12:00:00Z' },
        { id: 's2', name: 'has-msg', created_at: '2024-05-01T12:00:00Z' },
      ],
      [{ id: 'm1', session_id: 's2', role: 'user', timestamp: '2024-05-01T12:00:00Z' }],
    );
    const sessions = await parseOdysseusDb(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('odysseus-s2');
  });

  it('handles null/missing metadata gracefully', async () => {
    const dbPath = makeDb(
      tmp(),
      [{ id: 's1', name: 'no-meta', created_at: '2024-05-01T12:00:00Z' }],
      [
        { id: 'm1', session_id: 's1', role: 'user', timestamp: '2024-05-01T12:00:00Z' },
        {
          id: 'm2',
          session_id: 's1',
          role: 'assistant',
          metadata: null,
          timestamp: '2024-05-01T12:00:01Z',
        },
      ],
    );
    const sessions = await parseOdysseusDb(dbPath);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].toolCallCount).toBe(0);
    expect(sessions[0].inputTokens).toBe(0);
  });

  it('uses fallback token accumulation when total columns are 0', async () => {
    const dbPath = makeDb(
      tmp(),
      [
        {
          id: 's1',
          name: 'fallback',
          created_at: '2024-05-01T12:00:00Z',
          total_input_tokens: 0,
          total_output_tokens: 0,
        },
      ],
      [
        {
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          timestamp: '2024-05-01T12:00:01Z',
          metadata: JSON.stringify({ input_tokens: 500, output_tokens: 100 }),
        },
        {
          id: 'm2',
          session_id: 's1',
          role: 'assistant',
          timestamp: '2024-05-01T12:00:02Z',
          metadata: JSON.stringify({ input_tokens: 900, output_tokens: 200 }),
        },
      ],
    );
    const [s] = await parseOdysseusDb(dbPath);
    // input: max across messages; output: sum across messages
    expect(s.inputTokens).toBe(900);
    expect(s.outputTokens).toBe(300);
    expect(s.lastInputTokens).toBe(900);
  });
});
