/**
 * Aider source adapter — EXPERIMENTAL.
 *
 * Aider writes a Markdown chat log (`.aider.chat.history.md`) into each repo it
 * runs in. There is no central registry, so the user points us at repos or
 * files via the AGENTSLOG_AIDER_PATHS env var. A single history file can hold
 * many sessions (delimited by "# aider chat started at …"), each of which we
 * emit as its own session, deriving tokens from the "> Tokens:" summary lines
 * and file activity from Aider's "Applied edit to" / "Added … to the chat".
 *
 * Markdown is fuzzier than JSONL; this adapter is unvalidated against real-world
 * histories and is best-effort. The fixture tests pin the documented shape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { aiderSearchPaths } from '../../utils/paths.js';
import { normalizePath } from '../claude-code.js';
import type { ParsedFileTouched, ParsedSession, ParsedToolCall } from '../types.js';
import type { DiscoveredUnit, SourceAdapter } from './types.js';

const HISTORY_FILENAME = '.aider.chat.history.md';

/** Parse a number like "3.2k", "1.5M", "412", "1,024" into an integer. */
function parseNum(s: string): number {
  const m = /^([\d.,]+)\s*([kKmM]?)/.exec(s.trim());
  if (!m) return 0;
  const base = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return 0;
  const suf = m[2].toLowerCase();
  if (suf === 'k') return Math.round(base * 1_000);
  if (suf === 'm') return Math.round(base * 1_000_000);
  return Math.round(base);
}

/** Parse Aider's header timestamp ("2024-05-01 12:34:56") to ISO, or null. */
function parseHeaderTime(header: string): string | null {
  const m = /aider chat started at\s+(.+?)\s*$/.exec(header);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse one `.aider.chat.history.md` file into zero or more sessions. */
export function parseAiderHistory(filePath: string): ParsedSession[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const repoDir = normalizePath(path.dirname(filePath));
  const fallbackTime = (() => {
    try {
      return fs.statSync(filePath).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();

  // Split into per-session chunks on the "# aider chat started at" header,
  // keeping the header with its chunk.
  const headerRe = /^# aider chat started at .*$/gm;
  const indices: number[] = [];
  for (const m of text.matchAll(headerRe)) {
    if (m.index != null) indices.push(m.index);
  }

  const chunks: string[] = [];
  if (indices.length === 0) {
    chunks.push(text);
  } else {
    for (let i = 0; i < indices.length; i++) {
      const start = indices[i];
      const end = i + 1 < indices.length ? indices[i + 1] : text.length;
      chunks.push(text.slice(start, end));
    }
  }

  const sessions: ParsedSession[] = [];
  chunks.forEach((chunk, index) => {
    const session = parseAiderChunk(chunk, filePath, repoDir, index, fallbackTime);
    if (session) sessions.push(session);
  });
  return sessions;
}

function parseAiderChunk(
  chunk: string,
  filePath: string,
  repoDir: string,
  index: number,
  fallbackTime: string,
): ParsedSession | null {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) return null;

  const headerLine = /^# aider chat started at .*$/m.exec(chunk)?.[0] ?? '';
  const startedAt = parseHeaderTime(headerLine) ?? fallbackTime;

  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  let title: string | null = null;
  let userTurnCount = 0;

  let sequenceNum = 0;
  const toolCalls: ParsedToolCall[] = [];
  const files = new Map<string, ParsedFileTouched>();
  const bumpFile = (fp: string, kind: 'read' | 'edit') => {
    const key = normalizePath(fp);
    let e = files.get(key);
    if (!e) {
      e = { filePath: key, readCount: 0, writeCount: 0, editCount: 0 };
      files.set(key, e);
    }
    if (kind === 'read') e.readCount++;
    else e.editCount++;
  };

  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // First user heading becomes the title; every heading is a user turn.
    const head = /^####\s+(.+)$/.exec(line);
    if (head) {
      userTurnCount++;
      if (!title) title = head[1].replace(/\s+/g, ' ').trim().slice(0, 120);
      continue;
    }

    const tok = /^>\s*Tokens:\s*([\d.,]+\s*[kKmM]?)\s*sent,\s*([\d.,]+\s*[kKmM]?)\s*received/i.exec(
      line,
    );
    if (tok) {
      inputTokens += parseNum(tok[1]);
      outputTokens += parseNum(tok[2]);
      continue;
    }

    const mod = /^>\s*Model:\s*(\S+)/i.exec(line);
    if (mod && !model) {
      model = mod[1];
      continue;
    }

    const edit = /^>\s*Applied edit to\s+(.+)$/i.exec(line);
    if (edit) {
      const fp = edit[1].trim();
      toolCalls.push(mkCall('apply_edit', fp, sequenceNum++, startedAt));
      bumpFile(fp, 'edit');
      continue;
    }

    const added = /^>\s*Added\s+(.+?)\s+to the chat/i.exec(line);
    if (added) {
      const fp = added[1].trim();
      toolCalls.push(mkCall('add_to_chat', fp, sequenceNum++, startedAt));
      bumpFile(fp, 'read');
    }
  }

  // Require some signal that this chunk is a real session.
  if (userTurnCount === 0 && toolCalls.length === 0 && inputTokens === 0) return null;

  return {
    id: `aider:${normalizePath(filePath)}#${index}`,
    parentSessionId: null,
    source: 'aider',
    projectHash: repoDir,
    projectPath: repoDir,
    aiTitle: title,
    model,
    ccVersion: null,
    gitBranch: null,
    startedAt,
    endedAt: startedAt,
    durationMs: null,
    inputTokens,
    outputTokens,
    lastInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCallCount: toolCalls.length,
    errorCount: 0,
    userTurnCount,
    rawPath: filePath,
    toolCalls,
    filesTouched: [...files.values()],
  };
}

function mkCall(
  toolName: string,
  filePath: string,
  sequenceNum: number,
  at: string,
): ParsedToolCall {
  return {
    id: '', // filled in by the writer via session id + sequence
    sequenceNum,
    toolName,
    calledAt: at,
    success: true,
    filePath: normalizePath(filePath),
    command: null,
    errorText: null,
  };
}

/** Recursively find `.aider.chat.history.md` files under a directory. */
function findHistoryFiles(root: string, out: string[], depth = 0): void {
  if (depth > 6) return; // guard against pathological trees
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      findHistoryFiles(full, out, depth + 1);
    } else if (e.isFile() && e.name === HISTORY_FILENAME) {
      out.push(full);
    }
  }
}

export const aiderAdapter: SourceAdapter = {
  name: 'aider',
  label: 'Aider',
  experimental: true,

  isAvailable() {
    return aiderSearchPaths().length > 0;
  },

  discover(): DiscoveredUnit[] {
    const out: string[] = [];
    for (const p of aiderSearchPaths()) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        continue;
      }
      if (stat.isFile()) {
        if (path.basename(p) === HISTORY_FILENAME) out.push(p);
      } else if (stat.isDirectory()) {
        findHistoryFiles(p, out);
      }
    }
    return out.map((filePath) => ({
      filePath,
      projectHash: normalizePath(path.dirname(filePath)),
    }));
  },

  async parse(unit: DiscoveredUnit) {
    return parseAiderHistory(unit.filePath);
  },
};
