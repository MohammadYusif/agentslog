import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, writeSession } from '../src/db/index.js';
import { createServer } from '../src/mcp/server.js';
import { MCP_TOOLS } from '../src/mcp/tools.js';
import type { ParsedSession } from '../src/parser/types.js';

let dir: string;
let dbFile: string;
function db() {
  return openDb(dbFile);
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    id: 'sess-1',
    parentSessionId: null,
    source: 'claude-code',
    projectHash: 'h',
    projectPath: '/repo',
    aiTitle: 'Fix the parser',
    model: 'claude-opus-4-8',
    ccVersion: null,
    gitBranch: null,
    startedAt: '2026-01-05T00:00:00Z',
    endedAt: '2026-01-05T00:10:00Z',
    durationMs: 600000,
    inputTokens: 1000,
    outputTokens: 200,
    lastInputTokens: 800,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: 1,
    errorCount: 1,
    userTurnCount: 2,
    rawPath: '/x.jsonl',
    toolCalls: [
      {
        id: 'b',
        sequenceNum: 0,
        toolName: 'Bash',
        calledAt: '2026-01-05T00:01:00Z',
        success: false,
        filePath: null,
        command: 'npm run build',
        errorText: 'TS2345 boom',
      },
    ],
    filesTouched: [{ filePath: 'src/auth.ts', readCount: 1, writeCount: 0, editCount: 0 }],
    reasoning: [{ sequenceNum: 0, text: 'Chose a streaming parser to keep memory flat.' }],
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-mcp-'));
  dbFile = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP tool registry', () => {
  it('exposes all 7 tools, each with a non-empty description (the agent reads these)', () => {
    const names = MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'find_sessions_by_file',
        'find_sessions_by_tool',
        'get_session',
        'get_stats',
        'list_sessions',
        'recent_errors',
        'search_reasoning',
      ].sort(),
    );
    for (const t of MCP_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it('handlers return real data against a seeded db', () => {
    const d = db();
    writeSession(d, makeSession());
    const byName = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t]));

    expect((byName.recent_errors.handler(d, {}) as unknown[]).length).toBe(1);
    expect((byName.find_sessions_by_file.handler(d, { file: 'auth.ts' }) as unknown[]).length).toBe(
      1,
    );
    const detail = byName.get_session.handler(d, { id: 'sess-1' }) as { session: { id: string } };
    expect(detail.session.id).toBe('sess-1');
    const reasoning = byName.search_reasoning.handler(d, { query: 'streaming' }) as unknown[];
    expect(reasoning.length).toBe(1);
    d.close();
  });
});

describe('MCP server round-trip (in-memory transport)', () => {
  it('lists tools and answers a tool call over a real client/server pair', async () => {
    const d = db();
    writeSession(d, makeSession());

    const server = createServer(d);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('recent_errors');

    const res = (await client.callTool({ name: 'recent_errors', arguments: {} })) as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].tool_name).toBe('Bash');

    await client.close();
    await server.close();
    d.close();
  });
});
