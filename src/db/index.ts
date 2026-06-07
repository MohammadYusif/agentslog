/**
 * Database connection management and the per-session write transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ParsedSession } from '../parser/types.js';
import { dbPath } from '../utils/paths.js';
import { migrate } from './migrate.js';
import { insertLesson, type LessonInput, recordLessonHit } from './queries.js';

let singleton: Database.Database | null = null;

/**
 * Open (or reuse) the application database, enabling WAL mode and a busy
 * timeout so concurrent readers/writers (e.g. `watch` + `query`) cooperate.
 */
export function openDb(customPath?: string): Database.Database {
  if (singleton && !customPath) return singleton;

  const file = customPath ?? dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new Database(file);
  // Improve concurrency for the watcher daemon + ad-hoc query commands.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  migrate(db);

  if (!customPath) singleton = db;
  return db;
}

/**
 * Open a **read-only** connection to the application database. Used by the MCP
 * server so its reads never lock out a concurrent writer (e.g. the `Stop` hook
 * running `ingest`) — WAL mode plus a read-only handle avoids `SQLITE_BUSY`.
 * Ensures the schema is current first via a short-lived writable connection.
 */
export function openDbReadonly(): Database.Database {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Guarantee the schema exists / is migrated before opening read-only
  // (a read-only handle can't create tables).
  const rw = new Database(file);
  rw.pragma('journal_mode = WAL');
  migrate(rw);
  rw.close();

  const db = new Database(file, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Record a lesson over a **short-lived** writable connection, then close it
 * immediately. Used by the MCP `record_lesson` tool so the server's main handle
 * stays read-only and never holds a write lock (WAL tolerates the brief writer).
 */
export function recordLessonStandalone(input: LessonInput): number {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  try {
    return insertLesson(db, input);
  } finally {
    db.close();
  }
}

/**
 * Bump recall counters for the given lesson ids over a **short-lived** writable
 * connection, then close immediately. Used by the MCP `list_lessons` tool so
 * the server's main read-only handle never holds a write lock.
 */
export function recordLessonHitStandalone(ids: number[]): void {
  if (ids.length === 0) return;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  try {
    recordLessonHit(db, ids);
  } finally {
    db.close();
  }
}

/** Close the shared connection (used by tests and on watch shutdown). */
export function closeDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}

interface PreparedWrites {
  insertSession: Database.Statement;
  deleteToolCalls: Database.Statement;
  deleteFiles: Database.Statement;
  deleteReasoning: Database.Statement;
  insertToolCall: Database.Statement;
  insertFile: Database.Statement;
  insertReasoning: Database.Statement;
}

const writesCache = new WeakMap<Database.Database, PreparedWrites>();

function prepareWrites(db: Database.Database): PreparedWrites {
  const cached = writesCache.get(db);
  if (cached) return cached;

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, parent_session_id, source,
      project_hash, project_path, ai_title, model, cc_version, git_branch,
      started_at, ended_at, duration_ms,
      input_tokens, output_tokens, last_input_tokens,
      cache_read_tokens, cache_creation_tokens,
      tool_call_count, error_count, user_turn_count,
      raw_path, ingested_at
    ) VALUES (
      @id, @parentSessionId, @source,
      @projectHash, @projectPath, @aiTitle, @model, @ccVersion, @gitBranch,
      @startedAt, @endedAt, @durationMs,
      @inputTokens, @outputTokens, @lastInputTokens,
      @cacheReadTokens, @cacheCreationTokens,
      @toolCallCount, @errorCount, @userTurnCount,
      @rawPath, @ingestedAt
    )
  `);

  const deleteToolCalls = db.prepare('DELETE FROM tool_calls WHERE session_id = ?');
  const deleteFiles = db.prepare('DELETE FROM files_touched WHERE session_id = ?');
  const deleteReasoning = db.prepare('DELETE FROM reasoning_fts WHERE session_id = ?');

  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (
      id, session_id, sequence_num, tool_name, called_at, success,
      file_path, command, error_text
    ) VALUES (
      @id, @sessionId, @sequenceNum, @toolName, @calledAt, @success,
      @filePath, @command, @errorText
    )
  `);

  const insertFile = db.prepare(`
    INSERT INTO files_touched (
      session_id, file_path, read_count, write_count, edit_count
    ) VALUES (
      @sessionId, @filePath, @readCount, @writeCount, @editCount
    )
  `);

  const insertReasoning = db.prepare(`
    INSERT INTO reasoning_fts (session_id, sequence_num, text)
    VALUES (@sessionId, @sequenceNum, @text)
  `);

  const prepared: PreparedWrites = {
    insertSession,
    deleteToolCalls,
    deleteFiles,
    deleteReasoning,
    insertToolCall,
    insertFile,
    insertReasoning,
  };
  writesCache.set(db, prepared);
  return prepared;
}

/**
 * Persist one parsed session and all of its children atomically.
 *
 * Flow (single transaction): upsert session, delete prior tool_calls and
 * files_touched, then batch-insert the fresh rows. Re-ingesting a session is
 * therefore idempotent. Tool-call ids are namespaced by session to avoid
 * PRIMARY KEY collisions when transcripts reuse a `toolu_…` id.
 */
export function writeSession(db: Database.Database, session: ParsedSession): void {
  const w = prepareWrites(db);
  const ingestedAt = new Date().toISOString();

  const tx = db.transaction((s: ParsedSession) => {
    w.insertSession.run({
      id: s.id,
      parentSessionId: s.parentSessionId,
      source: s.source,
      projectHash: s.projectHash,
      projectPath: s.projectPath,
      aiTitle: s.aiTitle,
      model: s.model,
      ccVersion: s.ccVersion,
      gitBranch: s.gitBranch,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      lastInputTokens: s.lastInputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      toolCallCount: s.toolCallCount,
      errorCount: s.errorCount,
      userTurnCount: s.userTurnCount,
      rawPath: s.rawPath,
      ingestedAt,
    });

    w.deleteToolCalls.run(s.id);
    w.deleteFiles.run(s.id);
    w.deleteReasoning.run(s.id);

    for (const tc of s.toolCalls) {
      w.insertToolCall.run({
        id: `${s.id}:${tc.sequenceNum}`,
        sessionId: s.id,
        sequenceNum: tc.sequenceNum,
        toolName: tc.toolName,
        calledAt: tc.calledAt,
        success: tc.success ? 1 : 0,
        filePath: tc.filePath,
        command: tc.command,
        errorText: tc.errorText,
      });
    }

    for (const f of s.filesTouched) {
      w.insertFile.run({
        sessionId: s.id,
        filePath: f.filePath,
        readCount: f.readCount,
        writeCount: f.writeCount,
        editCount: f.editCount,
      });
    }

    if (s.reasoning) {
      for (const r of s.reasoning) {
        w.insertReasoning.run({
          sessionId: s.id,
          sequenceNum: r.sequenceNum,
          text: r.text,
        });
      }
    }
  });

  tx(session);
}
