import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAdvisory, reflectOnSession } from '../src/cli/commands/hook.js';
import { openDb, writeSession } from '../src/db/index.js';
import { insertLesson, listLessons } from '../src/db/queries.js';
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

/** Session with N Edit failures using the real "file not read" error text. */
function sessionWithEditUnreadErrors(id: string, filePath: string, count: number): ParsedSession {
  return {
    id,
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
    toolCallCount: count,
    errorCount: count,
    userTurnCount: 1,
    rawPath: '/x.jsonl',
    toolCalls: Array.from({ length: count }, (_, i) => ({
      id: `${id}-tc-${i}`,
      sequenceNum: i,
      toolName: 'Edit' as const,
      calledAt: '2026-01-05T00:01:00Z',
      success: false,
      filePath,
      command: null,
      errorText: 'File has not been read yet. Read it first before writing to it.',
    })),
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

  it('warns Edit on a NEW file when past sessions had "file not read" errors on other files', () => {
    const db = openDb(dbFile);
    // Past failure on a different file.
    writeSession(db, sessionWithEditUnreadErrors('old-sess', 'src/auth.ts', 1));
    // Now editing a completely new file — should still warn via pattern.
    const adv = buildAdvisory(db, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/new-file.ts' },
    });
    expect(adv).not.toBeNull();
    expect(adv?.hookSpecificOutput.additionalContext).toContain('has not been read');
    expect(adv?.hookSpecificOutput.additionalContext).toContain('new-file.ts');
    db.close();
  });

  it('does NOT double-warn when the per-file match already covers the "not read" pattern', () => {
    const db = openDb(dbFile);
    // Failure on the SAME file we are about to edit.
    writeSession(db, sessionWithEditUnreadErrors('old-sess', 'src/auth.ts', 1));
    const adv = buildAdvisory(db, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts' },
    });
    expect(adv).not.toBeNull();
    const ctx = adv?.hookSpecificOutput.additionalContext ?? '';
    // Should mention the pattern once, not twice.
    const countMatches = (ctx.match(/has not been read/g) ?? []).length;
    expect(countMatches).toBe(1);
    db.close();
  });

  it('surfaces a matching recorded lesson alongside (or without) past errors', () => {
    const db = openDb(dbFile);
    insertLesson(db, {
      rule: 'Use Get-ChildItem on Windows',
      scope: 'global',
      tool: 'Bash',
      trigger: 'ls -Recurse',
      source: 'user',
    });
    const adv = buildAdvisory(db, {
      tool_name: 'Bash',
      tool_input: { command: 'ls -Recurse build' },
      cwd: '/repo',
    });
    expect(adv?.hookSpecificOutput.additionalContext).toContain('Get-ChildItem');
    expect(adv?.hookSpecificOutput.additionalContext).toContain('Lesson');
    db.close();
  });
});

describe('reflectOnSession — auto-lessons', () => {
  it('records a lesson for a command that failed 3+ times, and dedupes', () => {
    const db = openDb(dbFile);
    writeSession(
      db,
      sessionWithFailure('ls -Recurse', null), // helper makes 1 failure; add more below
    );
    // Replace with a session that has 3 identical failures.
    writeSession(db, {
      ...sessionWithFailure('ls -Recurse', null),
      id: 'sess-1',
      toolCallCount: 3,
      errorCount: 3,
      toolCalls: [0, 1, 2].map((i) => ({
        id: String(i),
        sequenceNum: i,
        toolName: 'Bash' as const,
        calledAt: '2026-01-05T00:01:00Z',
        success: false,
        filePath: null,
        command: 'ls -Recurse',
        errorText: 'unknown option -- e',
      })),
    });

    const n = reflectOnSession(db, 'sess-1');
    expect(n).toBe(1);
    const lessons = listLessons(db, {});
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe('auto');
    expect(lessons[0].rule).toContain('failed 3×');

    // Re-reflecting does not duplicate.
    reflectOnSession(db, 'sess-1');
    expect(listLessons(db, {})).toHaveLength(1);
    db.close();
  });

  it('records a global lesson for Edit "file not read" failures >=2x', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithEditUnreadErrors('sess-edit', 'src/foo.ts', 3));
    const n = reflectOnSession(db, 'sess-edit');
    expect(n).toBe(1);
    const lessons = listLessons(db, {});
    expect(lessons).toHaveLength(1);
    expect(lessons[0].source).toBe('auto');
    expect(lessons[0].tool).toBe('Edit');
    expect(lessons[0].scope).toBe('global');
    expect(lessons[0].rule).toContain('has not been read');
    db.close();
  });

  it('does not duplicate Edit "file not read" lesson across sessions', () => {
    const db = openDb(dbFile);
    writeSession(db, sessionWithEditUnreadErrors('sess-a', 'src/foo.ts', 2));
    writeSession(db, sessionWithEditUnreadErrors('sess-b', 'src/bar.ts', 2));
    reflectOnSession(db, 'sess-a');
    reflectOnSession(db, 'sess-b'); // second session should not create a duplicate
    expect(listLessons(db, {})).toHaveLength(1);
    db.close();
  });

  it('does not record a lesson when failures are below the threshold', () => {
    const db = openDb(dbFile);
    writeSession(db, {
      ...sessionWithFailure('x', null),
      id: 'few',
      toolCallCount: 1,
      errorCount: 1,
      toolCalls: [
        {
          id: '0',
          sequenceNum: 0,
          toolName: 'Bash' as const,
          calledAt: null,
          success: false,
          filePath: null,
          command: 'flaky',
          errorText: 'e',
        },
      ],
    });
    expect(reflectOnSession(db, 'few')).toBe(0);
    db.close();
  });
});
