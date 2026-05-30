/**
 * Database connection management and the per-session write transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dbPath } from '../utils/paths.js';
import { migrate } from './migrate.js';
import type { ParsedSession } from '../parser/types.js';

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
  insertToolCall: Database.Statement;
  insertFile: Database.Statement;
}

const writesCache = new WeakMap<Database.Database, PreparedWrites>();

function prepareWrites(db: Database.Database): PreparedWrites {
  const cached = writesCache.get(db);
  if (cached) return cached;

  const insertSession = db.prepare(`
    INSERT OR REPLACE INTO sessions (
      id, project_hash, project_path, ai_title, model, cc_version, git_branch,
      started_at, ended_at, duration_ms,
      input_tokens, output_tokens, last_input_tokens,
      cache_read_tokens, cache_creation_tokens,
      tool_call_count, error_count, user_turn_count,
      raw_path, ingested_at
    ) VALUES (
      @id, @projectHash, @projectPath, @aiTitle, @model, @ccVersion, @gitBranch,
      @startedAt, @endedAt, @durationMs,
      @inputTokens, @outputTokens, @lastInputTokens,
      @cacheReadTokens, @cacheCreationTokens,
      @toolCallCount, @errorCount, @userTurnCount,
      @rawPath, @ingestedAt
    )
  `);

  const deleteToolCalls = db.prepare('DELETE FROM tool_calls WHERE session_id = ?');
  const deleteFiles = db.prepare('DELETE FROM files_touched WHERE session_id = ?');

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

  const prepared: PreparedWrites = {
    insertSession,
    deleteToolCalls,
    deleteFiles,
    insertToolCall,
    insertFile,
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
  });

  tx(session);
}
