/**
 * Odysseus source adapter — EXPERIMENTAL.
 *
 * Odysseus (https://github.com/pewdiepie-archdaemon/odysseus) is a self-hosted
 * AI workspace that stores chat sessions in a SQLite database (`data/app.db`).
 * Unlike the file-based adapters, we open the database directly (read-only) and
 * emit one {@link ParsedSession} per non-archived chat session that has at least
 * one message.
 *
 * Token usage and tool activity live in two places: aggregate token columns on
 * the `sessions` row, and a per-message `metadata` JSON blob on assistant
 * messages that carries token counts and a `tool_events` array. We prefer the
 * session columns for totals and fall back to summing the per-message metadata
 * when those columns are zero (older / partially-written rows).
 *
 * The user points us at the database via AGENTSLOG_ODYSSEUS_DB; there is no
 * central registry. This adapter is unvalidated against real-world databases
 * and is best-effort.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { odysseusDbPath } from '../../utils/paths.js';
import { normalizePath } from '../claude-code.js';
import type { ParsedFileTouched, ParsedSession, ParsedToolCall } from '../types.js';
import type { DiscoveredUnit, SourceAdapter } from './types.js';

/** A single tool invocation recorded on an assistant message's metadata. */
interface ToolEvent {
  round?: number;
  tool?: string;
  command?: string;
  output?: string;
  exit_code?: number | null;
  doc_id?: string;
  doc_title?: string;
}

/** The assistant-message metadata blob (all fields optional). */
interface MessageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  model?: string;
  tool_events?: ToolEvent[];
}

interface SessionRow {
  id: string;
  name: string | null;
  model: string | null;
  owner: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_message_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
}

interface MessageRow {
  id: string;
  role: string | null;
  content: string | null;
  metadata: string | null;
  timestamp: string | null;
}

/** sha256 hex digest of `input`, truncated to 32 chars. */
function hash32(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** Parse a datetime string to ISO, or null if missing/unparseable. */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Epoch milliseconds for a datetime string, or null. */
function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Coerce a value to a non-negative finite integer, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Safely parse a message's metadata JSON, returning null on any failure. */
function parseMetadata(raw: string | null): MessageMetadata | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as MessageMetadata) : null;
  } catch {
    return null;
  }
}

/** The file-operation kind a tool maps to, or null if it touches no file. */
type FileKind = 'read' | 'write' | 'edit';

/** First line of a string, trimmed; '' when empty/missing. */
function firstLine(s: string | undefined | null): string {
  if (!s) return '';
  return s.split(/\r?\n/, 1)[0].trim();
}

/** Looks like a path if it contains a separator. */
function looksLikePath(s: string): boolean {
  return s.includes('/') || s.includes('\\');
}

/**
 * Derive the (kind, filePath) a tool event maps to. `filePath` is
 * POSIX-normalized, or null when the tool doesn't target a determinable file.
 */
function resolveFileOp(ev: ToolEvent): { kind: FileKind; filePath: string | null } | null {
  const tool = ev.tool ?? '';
  const docPath = ev.doc_title ? normalizePath(`odysseus-docs/${ev.doc_title}`) : null;
  switch (tool) {
    case 'read_file':
    case 'write_file': {
      const candidate = firstLine(ev.command);
      const filePath = candidate && looksLikePath(candidate) ? normalizePath(candidate) : null;
      return { kind: tool === 'read_file' ? 'read' : 'write', filePath };
    }
    case 'create_document':
    case 'update_document':
      return { kind: 'write', filePath: docPath };
    case 'edit_document':
      return { kind: 'edit', filePath: docPath };
    case 'suggest_document':
      return { kind: 'read', filePath: docPath };
    default:
      return null;
  }
}

/**
 * Build one {@link ParsedSession} from a session row and its messages, or null
 * if the session has no messages.
 */
function buildSession(
  session: SessionRow,
  messages: MessageRow[],
  dbAbsPath: string,
  rawPath: string,
): ParsedSession | null {
  if (messages.length === 0) return null;

  const odysseusId = session.id;
  const projectHash = hash32(`${dbAbsPath}:${session.owner ?? ''}`);
  const projectPath = normalizePath(path.dirname(path.resolve(dbAbsPath)));

  const startedAt = toIso(session.created_at) ?? new Date(0).toISOString();
  const endedAt = toIso(session.last_message_at) ?? toIso(session.updated_at);
  const startMs = toMs(session.created_at);
  const endMs = toMs(session.last_message_at) ?? toMs(session.updated_at);
  const durationMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null;

  let userTurnCount = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let metaInputMax = 0;
  let metaOutputSum = 0;
  let lastInputTokens = 0;

  let sequenceNum = 0;
  const toolCalls: ParsedToolCall[] = [];
  const files = new Map<string, ParsedFileTouched>();
  const bumpFile = (filePath: string, kind: FileKind) => {
    let entry = files.get(filePath);
    if (!entry) {
      entry = { filePath, readCount: 0, writeCount: 0, editCount: 0 };
      files.set(filePath, entry);
    }
    if (kind === 'read') entry.readCount++;
    else if (kind === 'write') entry.writeCount++;
    else entry.editCount++;
  };

  let toolCallCount = 0;
  let errorCount = 0;

  for (const message of messages) {
    if (message.role === 'user') userTurnCount++;
    if (message.role !== 'assistant') continue;

    const meta = parseMetadata(message.metadata);
    if (!meta) continue;

    cacheReadTokens += num(meta.cache_read_tokens);
    cacheCreationTokens += num(meta.cache_creation_tokens);
    if (typeof meta.input_tokens === 'number' && Number.isFinite(meta.input_tokens)) {
      metaInputMax = Math.max(metaInputMax, num(meta.input_tokens));
      lastInputTokens = num(meta.input_tokens);
    }
    metaOutputSum += num(meta.output_tokens);

    const calledAt = toIso(message.timestamp);
    const events = Array.isArray(meta.tool_events) ? meta.tool_events : [];
    for (const ev of events) {
      toolCallCount++;
      const exit = ev.exit_code;
      const success = exit === 0 || exit == null;
      if (!success) errorCount++;

      const op = resolveFileOp(ev);
      const filePath = op?.filePath ?? null;
      const commandLine = firstLine(ev.command);
      const command = commandLine.length > 0 ? commandLine.slice(0, 500) : null;
      const errorText = !success && ev.output ? ev.output.slice(-500) : null;

      toolCalls.push({
        id: `${odysseusId}-tc-${sequenceNum}`,
        sequenceNum,
        toolName: ev.tool ?? 'unknown',
        calledAt,
        success,
        filePath,
        command,
        errorText,
      });
      sequenceNum++;

      if (op && filePath) bumpFile(filePath, op.kind);
    }
  }

  const colInput = num(session.total_input_tokens);
  const colOutput = num(session.total_output_tokens);
  const inputTokens = colInput > 0 ? colInput : metaInputMax;
  const outputTokens = colOutput > 0 ? colOutput : metaOutputSum;

  const name = session.name?.trim() ?? '';
  const model = session.model?.trim() ?? '';

  return {
    id: `odysseus-${odysseusId}`,
    parentSessionId: null,
    source: 'odysseus',
    projectHash,
    projectPath,
    aiTitle: name.length > 0 ? name : null,
    model: model.length > 0 ? model : null,
    ccVersion: null,
    gitBranch: null,
    startedAt,
    endedAt,
    durationMs,
    inputTokens,
    outputTokens,
    lastInputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    toolCallCount,
    errorCount,
    userTurnCount,
    rawPath,
    toolCalls,
    filesTouched: [...files.values()],
  };
}

/**
 * Parse every non-archived session in an Odysseus database into a
 * {@link ParsedSession}. Sessions with no messages are skipped silently, and
 * any single session that fails to parse is skipped (never throws). Exported
 * for testing.
 */
export async function parseOdysseusDb(dbPath: string): Promise<ParsedSession[]> {
  const dbAbsPath = path.resolve(dbPath);
  const rawPath = normalizePath(dbAbsPath);

  let db: Database.Database;
  try {
    db = new Database(dbAbsPath, { readonly: true });
  } catch {
    return [];
  }

  const out: ParsedSession[] = [];
  try {
    const sessions = db
      .prepare(
        `SELECT id, name, model, owner, created_at, updated_at, last_message_at,
                total_input_tokens, total_output_tokens
           FROM sessions
          WHERE archived = 0 OR archived IS NULL`,
      )
      .all() as SessionRow[];

    const messageStmt = db.prepare(
      `SELECT id, role, content, metadata, timestamp
         FROM messages
        WHERE session_id = ?
        ORDER BY timestamp ASC, id ASC`,
    );

    for (const session of sessions) {
      try {
        const messages = messageStmt.all(session.id) as MessageRow[];
        const parsed = buildSession(session, messages, dbAbsPath, rawPath);
        if (parsed) out.push(parsed);
      } catch {
        // Skip a single bad session; never let it abort the whole ingest.
      }
    }
  } catch {
    // Schema mismatch or unreadable DB — yield whatever we collected.
  } finally {
    db.close();
  }

  return out;
}

export const odysseusAdapter: SourceAdapter = {
  name: 'odysseus',
  label: 'Odysseus',
  experimental: true,

  isAvailable() {
    const p = odysseusDbPath();
    return p != null && fs.existsSync(p);
  },

  discover(): DiscoveredUnit[] {
    const p = odysseusDbPath();
    if (p == null || !fs.existsSync(p)) return [];
    const dbAbsPath = path.resolve(p);
    return [
      {
        filePath: dbAbsPath,
        projectHash: hash32(`${dbAbsPath}:`),
      },
    ];
  },

  async parse(unit: DiscoveredUnit) {
    return parseOdysseusDb(unit.filePath);
  },
};
