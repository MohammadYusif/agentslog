import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClineTask } from '../src/parser/sources/cline.js';
import { parseAiderHistory } from '../src/parser/sources/aider.js';

let tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-src-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

describe('Cline adapter', () => {
  it('parses a task directory: tokens, tools, files, title', () => {
    const dir = tmp();
    const taskDir = path.join(dir, '1699900000000');
    fs.mkdirSync(taskDir);
    const ui = [
      { ts: 1699900000000, type: 'say', say: 'task', text: 'Fix the auth bug' },
      {
        ts: 1699900001000,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 1200, tokensOut: 300, cacheReads: 50, cacheWrites: 20, cwd: 'C:\\repo' }),
      },
      { ts: 1699900002000, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'readFile', path: 'src/auth.ts' }) },
      { ts: 1699900003000, type: 'say', say: 'tool', text: JSON.stringify({ tool: 'editedExistingFile', path: 'src/auth.ts' }) },
      { ts: 1699900004000, type: 'say', say: 'command', text: 'npm test' },
      {
        ts: 1699900005000,
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 800, tokensOut: 100, cacheReads: 10, cacheWrites: 0 }),
      },
    ];
    fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), JSON.stringify(ui), 'utf-8');

    const s = parseClineTask(taskDir)!;
    expect(s).not.toBeNull();
    expect(s.source).toBe('cline');
    expect(s.id).toBe('cline-1699900000000');
    expect(s.aiTitle).toBe('Fix the auth bug');
    expect(s.inputTokens).toBe(2000); // 1200 + 800
    expect(s.outputTokens).toBe(400);
    expect(s.cacheReadTokens).toBe(60);
    expect(s.projectPath).toBe('C:/repo');
    // read_file + replace_in_file + execute_command
    expect(s.toolCalls.map((t) => t.toolName)).toEqual([
      'read_file',
      'replace_in_file',
      'execute_command',
    ]);
    const auth = s.filesTouched.find((f) => f.filePath === 'src/auth.ts')!;
    expect(auth.readCount).toBe(1);
    expect(auth.editCount).toBe(1);
  });

  it('returns null when ui_messages.json is missing or empty', () => {
    const dir = tmp();
    const taskDir = path.join(dir, 'empty');
    fs.mkdirSync(taskDir);
    expect(parseClineTask(taskDir)).toBeNull();
    fs.writeFileSync(path.join(taskDir, 'ui_messages.json'), '[]', 'utf-8');
    expect(parseClineTask(taskDir)).toBeNull();
  });
});

describe('Aider adapter', () => {
  it('splits a history file into per-session chunks with tokens and edits', () => {
    const dir = tmp();
    const file = path.join(dir, '.aider.chat.history.md');
    const content = [
      '# aider chat started at 2024-05-01 12:00:00',
      '',
      '> Model: gpt-4o',
      '',
      '#### add a logout endpoint',
      '',
      'Sure, here is the change.',
      '',
      '> Applied edit to src/server.py',
      '> Tokens: 3.2k sent, 412 received. Cost: $0.01',
      '',
      '# aider chat started at 2024-05-02 09:30:00',
      '',
      '#### fix the failing test',
      '',
      '> Added tests/test_server.py to the chat',
      '> Applied edit to tests/test_server.py',
      '> Tokens: 1,500 sent, 200 received',
      '',
    ].join('\n');
    fs.writeFileSync(file, content, 'utf-8');

    const sessions = parseAiderHistory(file);
    expect(sessions).toHaveLength(2);

    const [a, b] = sessions;
    expect(a.source).toBe('aider');
    expect(a.model).toBe('gpt-4o');
    expect(a.aiTitle).toBe('add a logout endpoint');
    expect(a.inputTokens).toBe(3200); // 3.2k
    expect(a.outputTokens).toBe(412);
    expect(a.filesTouched.find((f) => f.filePath === 'src/server.py')!.editCount).toBe(1);
    expect(a.startedAt).toBe(new Date('2024-05-01 12:00:00').toISOString());

    expect(b.inputTokens).toBe(1500); // 1,500 parsed
    expect(b.outputTokens).toBe(200);
    const t = b.filesTouched.find((f) => f.filePath === 'tests/test_server.py')!;
    expect(t.readCount).toBe(1);
    expect(t.editCount).toBe(1);

    // Stable, unique ids across re-parses (idempotent ingest).
    expect(a.id).not.toBe(b.id);
    expect(parseAiderHistory(file)[0].id).toBe(a.id);
  });

  it('handles a history file with no session headers', () => {
    const dir = tmp();
    const file = path.join(dir, '.aider.chat.history.md');
    fs.writeFileSync(file, '#### just a prompt\n> Tokens: 100 sent, 50 received\n', 'utf-8');
    const sessions = parseAiderHistory(file);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].inputTokens).toBe(100);
    expect(sessions[0].userTurnCount).toBe(1);
  });
});
