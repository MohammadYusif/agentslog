import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import {
  insertLesson,
  type LessonInput,
  lessonsForContext,
  listLessons,
  recordLessonHit,
  removeLesson,
} from '../src/db/queries.js';

let dir: string;
let dbFile: string;
function db() {
  return openDb(dbFile);
}
function add(d: ReturnType<typeof openDb>, over: Partial<LessonInput> & { rule: string }) {
  return insertLesson(d, over);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentslog-les-'));
  dbFile = path.join(dir, 'db.sqlite');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lessons store', () => {
  it('inserts, lists, and removes lessons', () => {
    const d = db();
    const id = add(d, { rule: 'Use Get-ChildItem on Windows', tool: 'Bash', source: 'user' });
    expect(listLessons(d, {})).toHaveLength(1);
    expect(removeLesson(d, id)).toBe(true);
    expect(listLessons(d, {})).toHaveLength(0);
    d.close();
  });

  it('de-duplicates on (scope, rule), keeping the higher confidence', () => {
    const d = db();
    const id1 = add(d, { rule: 'X', scope: 'global', confidence: 0.5 });
    const id2 = add(d, { rule: 'X', scope: 'global', confidence: 0.9 });
    expect(id1).toBe(id2);
    const rows = listLessons(d, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe(0.9);
    // Same rule, different scope → distinct row.
    add(d, { rule: 'X', scope: '/repo-a' });
    expect(listLessons(d, {})).toHaveLength(2);
    d.close();
  });

  it('scopes lessons to a project plus global', () => {
    const d = db();
    add(d, { rule: 'global one', scope: 'global' });
    add(d, { rule: 'project one', scope: '/repo-a' });
    add(d, { rule: 'other project', scope: '/repo-b' });
    const scoped = listLessons(d, { scope: '/repo-a' })
      .map((l) => l.rule)
      .sort();
    expect(scoped).toEqual(['global one', 'project one']);
    d.close();
  });
});

describe('lessonsForContext (recall)', () => {
  it('matches by trigger substring of the imminent command', () => {
    const d = db();
    add(d, { rule: 'avoid ls -Recurse', scope: 'global', tool: 'Bash', trigger: 'ls -Recurse' });
    add(d, { rule: 'about git', scope: 'global', tool: 'Bash', trigger: 'git push' });
    const hits = lessonsForContext(d, {
      project: '/repo',
      tool: 'Bash',
      command: 'ls -Recurse src',
    });
    expect(hits.map((l) => l.rule)).toEqual(['avoid ls -Recurse']);
    // A non-matching command surfaces nothing trigger-specific.
    expect(
      lessonsForContext(d, { project: '/repo', tool: 'Bash', command: 'echo hi' }),
    ).toHaveLength(0);
    d.close();
  });

  it('returns top scoped lessons trigger-agnostically when no action is given (session start)', () => {
    const d = db();
    add(d, { rule: 'a', scope: 'global', trigger: 'x' });
    add(d, { rule: 'b', scope: '/repo' });
    const all = lessonsForContext(d, { project: '/repo' });
    expect(all.map((l) => l.rule).sort()).toEqual(['a', 'b']);
    d.close();
  });

  it('ranks by hits then confidence and respects the limit', () => {
    const d = db();
    const lowId = add(d, { rule: 'low', scope: 'global', confidence: 0.9 });
    add(d, { rule: 'high-hits', scope: 'global', confidence: 0.1 });
    const highId = listLessons(d, {}).find((l) => l.rule === 'high-hits')!.id;
    recordLessonHit(d, [highId, highId, highId]);
    const top = lessonsForContext(d, { project: '/repo', limit: 1 });
    expect(top).toHaveLength(1);
    expect(top[0].rule).toBe('high-hits'); // 3 hits beats higher confidence
    expect(lowId).toBeGreaterThan(0);
    d.close();
  });

  it('recordLessonHit increments hits', () => {
    const d = db();
    const id = add(d, { rule: 'r', scope: 'global' });
    recordLessonHit(d, [id, id]);
    expect(listLessons(d, {})[0].hits).toBe(2);
    d.close();
  });
});
