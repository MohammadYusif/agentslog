import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdvisory } from '../src/cli/commands/hook.js';
import { openDb, writeSession } from '../src/db/index.js';
import type { ParsedSession } from '../src/parser/types.js';

let dir: string;
let dbFile: string;

function sessionWithFailure(command: string | null, filePath: string | null): ParsedSession {
  return {
    id: 'sess-1',
    parentSessionId: null,
    source: 'claude-code',
    projectHash: 'h',
    projectPath: '/repo',
    aiTitle: 'A run',
    model: null,
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
    toolCallCount: 1,
    errorCount: 1,
    userTurnCount: 1,
    rawPath: '/x.jsonl',
    toolCalls: [
      {
        id: 'f',
        sequenceNum: 0,
        toolName: command ? 'Bash' : 'Edit',
        calledAt: '2026-01-05T00:01:00Z',
        success: false,
        filePath,
        command,
        errorText: 'unknown option -- e',
      },
    ],
    filesTouched: [],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-hook-'));
  dbFile = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hook check — buildAdvisory', () => {
  it('warns on a similar shell command (shared program + flag)', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithFailure('ls "C:/x" -Recurse -Name', null));
    const adv = buildAdvisory(db, {
      tool_name: 'Bash',
      tool_input: { command: 'ls -Recurse src' },
    });
    expect(adv).not.toBeNull();
    expect(adv?.hookSpecificOutput.additionalContext).toContain('similar Bash failure');
    expect(adv?.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    db.close();
  });

  it('does NOT warn on a different command with the same program', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithFailure('git push --force', null));
    const adv = buildAdvisory(db, {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(adv).toBeNull(); // same program, no shared flag, different head → no false positive
    db.close();
  });

  it('warns on a repeated failure to the same file', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithFailure(null, 'src/auth.ts'));
    const adv = buildAdvisory(db, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' },
    });
    expect(adv).not.toBeNull();
    db.close();
  });

  it('returns null when the tool has no past failures', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithFailure('ls -Recurse', null));
    expect(buildAdvisory(db, { tool_name: 'WebSearch', tool_input: {} })).toBeNull();
    db.close();
  });
});
