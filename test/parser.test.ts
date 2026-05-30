import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePath, parseSessionFile } from '../src/parser/claude-code.js';

/** Build a JSONL fixture file from an array of event objects. */
function writeFixture(events: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-test-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  return file;
}

let createdDirs: string[] = [];
function fixture(events: unknown[]): string {
  const f = writeFixture(events);
  createdDirs.push(path.dirname(f));
  return f;
}

afterEach(() => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
  createdDirs = [];
});

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\x\\CLAUDE.md')).toBe('C:/Users/x/CLAUDE.md');
  });
});

describe('parseSessionFile', () => {
  it('accumulates input_tokens across ALL assistant messages but last_input_tokens from the last', async () => {
    const file = fixture([
      {
        type: 'user',
        sessionId: 's1',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: 'C:\\proj',
        message: { role: 'user', content: 'hi' },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 2,
          },
          content: [],
        },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 300,
            output_tokens: 20,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 3,
          },
          content: [],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashA'))!;
    expect(s.inputTokens).toBe(400); // 100 + 300, total billed
    expect(s.outputTokens).toBe(30);
    expect(s.lastInputTokens).toBe(300); // peak context = last message input
    expect(s.cacheReadTokens).toBe(12);
    expect(s.cacheCreationTokens).toBe(5);
  });

  it('skips corrupt JSON lines without throwing', async () => {
    const file = fixture([
      {
        type: 'user',
        sessionId: 's2',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'hi' },
      },
    ]);
    // Append a broken line + a valid assistant line.
    fs.appendFileSync(file, '{ this is not json \n');
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 's2',
        timestamp: '2026-01-01T00:00:01Z',
        message: { usage: { input_tokens: 50, output_tokens: 5 }, content: [] },
      })}\n`,
    );
    const s = (await parseSessionFile(file, 'hashB'))!;
    expect(s).not.toBeNull();
    expect(s.inputTokens).toBe(50); // valid line still counted
  });

  it('extracts file_path only for Read/Write/Edit/Grep/Glob and normalizes separators', async () => {
    const file = fixture([
      {
        type: 'assistant',
        sessionId: 's3',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\a\\b.ts' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { path: 'C:\\a', pattern: 'x' } },
            { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
          ],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashC'))!;
    const byName = Object.fromEntries(s.toolCalls.map((t) => [t.toolName, t]));
    expect(byName.Read.filePath).toBe('C:/a/b.ts');
    expect(byName.Grep.filePath).toBe('C:/a');
    expect(byName.Bash.filePath).toBeNull();
  });

  it('stores command for Bash/PowerShell truncated to 500 chars, with null file_path', async () => {
    const longCmd = 'x'.repeat(600);
    const file = fixture([
      {
        type: 'assistant',
        sessionId: 's4',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: longCmd } },
            { type: 'tool_use', id: 't2', name: 'PowerShell', input: { command: 'Get-ChildItem' } },
          ],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashD'))!;
    const bash = s.toolCalls.find((t) => t.toolName === 'Bash')!;
    const ps = s.toolCalls.find((t) => t.toolName === 'PowerShell')!;
    expect(bash.command!.length).toBe(500);
    expect(bash.filePath).toBeNull();
    expect(ps.command).toBe('Get-ChildItem');
  });

  it('assigns incrementing sequence_num starting at 0 across the session', async () => {
    const file = fixture([
      {
        type: 'assistant',
        sessionId: 's5',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x' } },
            { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/y' } },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId: 's5',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashE'))!;
    expect(s.toolCalls.map((t) => t.sequenceNum)).toEqual([0, 1, 2]);
  });

  it('marks a tool call failed and captures error text when its result is_error', async () => {
    const file = fixture([
      {
        type: 'assistant',
        sessionId: 's6',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [{ type: 'tool_use', id: 'tool-x', name: 'Bash', input: { command: 'false' } }],
        },
      },
      {
        type: 'user',
        sessionId: 's6',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-x',
              is_error: true,
              content: 'Exit code 1: boom',
            },
          ],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashF'))!;
    expect(s.errorCount).toBe(1);
    const tc = s.toolCalls[0];
    expect(tc.success).toBe(false);
    expect(tc.errorText).toContain('boom');
  });

  it('uses the LAST ai-title event as the session title', async () => {
    const file = fixture([
      { type: 'ai-title', sessionId: 's7', aiTitle: 'First Guess' },
      {
        type: 'user',
        sessionId: 's7',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'hi' },
      },
      { type: 'ai-title', sessionId: 's7', aiTitle: 'Final Title' },
    ]);
    const s = (await parseSessionFile(file, 'hashG'))!;
    expect(s.aiTitle).toBe('Final Title');
  });

  it('aggregates files_touched read/write/edit counts', async () => {
    const file = fixture([
      {
        type: 'assistant',
        sessionId: 's8',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          content: [
            { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: '2', name: 'Read', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: '3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
            { type: 'tool_use', id: '4', name: 'Write', input: { file_path: '/repo/b.ts' } },
          ],
        },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashH'))!;
    const a = s.filesTouched.find((f) => f.filePath === '/repo/a.ts')!;
    const b = s.filesTouched.find((f) => f.filePath === '/repo/b.ts')!;
    expect(a.readCount).toBe(2);
    expect(a.editCount).toBe(1);
    expect(b.writeCount).toBe(1);
  });

  it('computes duration from first and last timestamps', async () => {
    const file = fixture([
      {
        type: 'user',
        sessionId: 's9',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'hi' },
      },
      {
        type: 'assistant',
        sessionId: 's9',
        timestamp: '2026-01-01T00:00:10Z',
        message: { content: [] },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashI'))!;
    expect(s.durationMs).toBe(10_000);
    expect(s.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(s.endedAt).toBe('2026-01-01T00:00:10Z');
  });

  it('indexes a sub-agent sidechain transcript as its own row linked to the parent', async () => {
    // Simulate an agent-*.jsonl file: events carry the PARENT sessionId and
    // isSidechain: true, while the file is named differently. It must be indexed
    // under its OWN id (the filename) and linked to the parent, not skipped.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-test-'));
    createdDirs.push(dir);
    const file = path.join(dir, 'agent-deadbeef.jsonl');
    fs.writeFileSync(
      file,
      `${[
        {
          type: 'user',
          isSidechain: true,
          sessionId: 'parent-uuid',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'sub task' },
        },
        {
          type: 'assistant',
          isSidechain: true,
          sessionId: 'parent-uuid',
          timestamp: '2026-01-01T00:00:01Z',
          message: { usage: { input_tokens: 40, output_tokens: 8 }, content: [] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
      'utf-8',
    );
    const s = await parseSessionFile(file, 'hashSC');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('agent-deadbeef'); // own unique id (the filename)
    expect(s!.parentSessionId).toBe('parent-uuid'); // linked to the parent
    expect(s!.source).toBe('claude-code');
    expect(s!.inputTokens).toBe(40); // sub-agent tokens captured for rollup
  });

  it('treats a canonical file (basename matches sessionId) as a top-level session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-test-'));
    createdDirs.push(dir);
    const file = path.join(dir, 'parent-uuid.jsonl');
    fs.writeFileSync(
      file,
      `${[
        {
          type: 'user',
          isSidechain: false,
          sessionId: 'parent-uuid',
          timestamp: '2026-01-01T00:00:00Z',
          message: { role: 'user', content: 'main' },
        },
        {
          type: 'assistant',
          isSidechain: false,
          sessionId: 'parent-uuid',
          timestamp: '2026-01-01T00:00:01Z',
          message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n')}\n`,
      'utf-8',
    );
    const s = await parseSessionFile(file, 'hashMain');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('parent-uuid');
    expect(s!.parentSessionId).toBeNull(); // top-level
  });

  it('counts only real user text turns, not tool_result envelopes', async () => {
    const file = fixture([
      {
        type: 'user',
        sessionId: 's10',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'question one' },
      },
      {
        type: 'assistant',
        sessionId: 's10',
        timestamp: '2026-01-01T00:00:01Z',
        message: {
          content: [{ type: 'tool_use', id: 'q', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        sessionId: 's10',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'q', content: 'ok' }],
        },
      },
      {
        type: 'user',
        sessionId: 's10',
        timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'user', content: 'question two' },
      },
    ]);
    const s = (await parseSessionFile(file, 'hashJ'))!;
    expect(s.userTurnCount).toBe(2);
  });
});
