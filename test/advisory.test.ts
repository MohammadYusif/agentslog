import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { advisoryFireStats, recordAdvisoryFires } from '../src/db/queries.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  migrate(db);
  return db;
}

describe('advisory_fires', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('starts empty', () => {
    const stats = advisoryFireStats(db);
    expect(stats.total).toBe(0);
    expect(stats.byKind).toEqual([]);
    expect(stats.byTool).toEqual([]);
    expect(stats.firstFiredAt).toBeNull();
    expect(stats.lastFiredAt).toBeNull();
  });

  it('records fires and aggregates by kind and tool', () => {
    recordAdvisoryFires(db, [
      { tool: 'Bash', kind: 'lesson', detail: 'cd then git' },
      { tool: 'Bash', kind: 'similar_failure', detail: '2 failures' },
      { tool: 'Edit', kind: 'not_read', detail: 'read first' },
      { tool: 'Edit', kind: 'lesson', detail: 'read first' },
    ]);

    const stats = advisoryFireStats(db);
    expect(stats.total).toBe(4);
    // byKind: lesson (2) first, then the singles ordered by count then name.
    expect(stats.byKind[0]).toEqual({ kind: 'lesson', count: 2 });
    expect(stats.byKind.find((k) => k.kind === 'not_read')?.count).toBe(1);
    // byTool: Bash (2) and Edit (2), tie broken alphabetically.
    expect(stats.byTool).toEqual([
      { tool: 'Bash', count: 2 },
      { tool: 'Edit', count: 2 },
    ]);
    expect(stats.firstFiredAt).not.toBeNull();
  });

  it('no-ops on an empty batch', () => {
    recordAdvisoryFires(db, []);
    expect(advisoryFireStats(db).total).toBe(0);
  });

  it('honors a since cutoff', () => {
    // Backdate one row, keep one current, then window to the recent slice.
    recordAdvisoryFires(db, [{ tool: 'Bash', kind: 'lesson' }]);
    db.prepare("UPDATE advisory_fires SET fired_at = '2000-01-01T00:00:00.000Z'").run();
    recordAdvisoryFires(db, [{ tool: 'Read', kind: 'frequency' }]);

    const recent = advisoryFireStats(db, '2020-01-01T00:00:00.000Z');
    expect(recent.total).toBe(1);
    expect(recent.byTool).toEqual([{ tool: 'Read', count: 1 }]);
  });
});
