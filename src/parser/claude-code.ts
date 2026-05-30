/**
 * Streaming parser for a single Claude Code JSONL session transcript.
 *
 * Reads the file line-by-line (never loading the whole file into memory),
 * tolerates corrupt lines, and produces a normalized {@link ParsedSession}.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  RawEvent,
  ContentBlock,
  ParsedSession,
  ParsedToolCall,
  ParsedFileTouched,
} from './types.js';

/** Tools whose file path is found at input.file_path. */
const FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']);
/** Tools whose file path is found at input.path. */
const SEARCH_PATH_TOOLS = new Set(['Grep', 'Glob']);
/** Tools that carry a shell command instead of a file path. */
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

const MAX_COMMAND_LEN = 500;
const MAX_ERROR_LEN = 2000;

/** Normalize a filesystem path to POSIX separators for stable storage/querying. */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/** Coerce a tool_result `content` field (string or array of blocks) to text. */
function stringifyResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('\n');
  }
  return String(content);
}

/** Extract the file path for a tool_use block, or null for command/other tools. */
function extractFilePath(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  if (FILE_PATH_TOOLS.has(toolName)) {
    const fp = input.file_path;
    return typeof fp === 'string' ? normalizePath(fp) : null;
  }
  if (SEARCH_PATH_TOOLS.has(toolName)) {
    const p = input.path;
    return typeof p === 'string' ? normalizePath(p) : null;
  }
  return null;
}

/** Extract the (truncated) command string for shell tools, else null. */
function extractCommand(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input || !COMMAND_TOOLS.has(toolName)) return null;
  const cmd = input.command;
  if (typeof cmd !== 'string') return null;
  return cmd.slice(0, MAX_COMMAND_LEN);
}

/**
 * Parse a single JSONL transcript at `filePath`.
 *
 * @param filePath Absolute path to the `.jsonl` file.
 * @param projectHash The directory name under `~/.claude/projects/`.
 * @returns The normalized session, or null if the file contained no
 *          identifiable session events (e.g. empty or fully corrupt).
 */
export async function parseSessionFile(
  filePath: string,
  projectHash: string
): Promise<ParsedSession | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | null = null;
  let aiTitle: string | null = null;
  let model: string | null = null;
  let ccVersion: string | null = null;
  let gitBranch: string | null = null;
  let projectPath: string | null = null;

  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  let inputTokens = 0;
  let outputTokens = 0;
  let lastInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  let errorCount = 0;
  let userTurnCount = 0;

  // Sidechain detection: sub-agent transcripts are stored in their own file
  // but every event carries the PARENT session's sessionId. If we indexed them
  // they would collide with (and overwrite) the canonical parent session row.
  // We distinguish them two ways and skip the file if it is a sidechain:
  //   - events carry isSidechain: true, and
  //   - the file's basename UUID does not match the content sessionId.
  let sidechainEvents = 0;
  let mainEvents = 0;

  let sequenceNum = 0;
  const toolCalls: ParsedToolCall[] = [];
  /** Maps tool_use id -> index in toolCalls, so results can flip success. */
  const toolCallIndexById = new Map<string, number>();
  /** Aggregated file activity keyed by normalized path. */
  const files = new Map<string, ParsedFileTouched>();

  const bumpFile = (fp: string, kind: 'read' | 'write' | 'edit') => {
    let entry = files.get(fp);
    if (!entry) {
      entry = { filePath: fp, readCount: 0, writeCount: 0, editCount: 0 };
      files.set(fp, entry);
    }
    if (kind === 'read') entry.readCount++;
    else if (kind === 'write') entry.writeCount++;
    else entry.editCount++;
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: RawEvent;
    try {
      event = JSON.parse(trimmed) as RawEvent;
    } catch (err) {
      // Corrupt / partially-written line: skip silently, never throw.
      if (err instanceof SyntaxError) continue;
      continue;
    }

    const type = event.type;
    if (event.sessionId && !sessionId) sessionId = event.sessionId;

    // Tally sidechain vs main events (only message events carry the flag).
    if (type === 'user' || type === 'assistant') {
      if (event.isSidechain === true) sidechainEvents++;
      else mainEvents++;
    }

    // Capture session-level metadata from any event that carries it.
    if (typeof event.cwd === 'string') projectPath = event.cwd;
    if (typeof event.gitBranch === 'string') gitBranch = event.gitBranch;
    if (typeof event.version === 'string') ccVersion = event.version;

    // Track first/last timestamps across all timestamped events.
    if (typeof event.timestamp === 'string') {
      if (!firstTimestamp) firstTimestamp = event.timestamp;
      lastTimestamp = event.timestamp;
    }

    if (type === 'ai-title' && typeof event.aiTitle === 'string') {
      // Multiple ai-title events can appear; the last one wins.
      aiTitle = event.aiTitle;
      continue;
    }

    if (type === 'user') {
      const content = event.message?.content;
      if (typeof content === 'string') {
        // A real user text turn.
        userTurnCount++;
      } else if (Array.isArray(content)) {
        // May be tool_result blocks, or user content blocks.
        let hasToolResult = false;
        for (const block of content as ContentBlock[]) {
          if (block.type === 'tool_result') {
            hasToolResult = true;
            const id = block.tool_use_id;
            const isError = block.is_error === true;
            if (isError) errorCount++;
            if (id && toolCallIndexById.has(id)) {
              const idx = toolCallIndexById.get(id)!;
              const tc = toolCalls[idx];
              tc.success = !isError;
              if (isError) {
                tc.errorText = stringifyResultContent(block.content).slice(0, MAX_ERROR_LEN);
              }
            }
          }
        }
        if (!hasToolResult) userTurnCount++;
      }
      continue;
    }

    if (type === 'assistant') {
      const msg = event.message;
      if (msg?.model) model = msg.model;

      const usage = msg?.usage;
      if (usage) {
        // Accumulate every usage block for total billed tokens.
        const ut = usage.input_tokens ?? 0;
        inputTokens += ut;
        outputTokens += usage.output_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        // Peak context window = input_tokens of the LAST assistant message.
        lastInputTokens = ut;
      }

      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block.type !== 'tool_use') continue;
          const toolName = block.name ?? 'unknown';
          const filePath2 = extractFilePath(toolName, block.input);
          const command = extractCommand(toolName, block.input);

          const tc: ParsedToolCall = {
            id: block.id ?? randomUUID(),
            sequenceNum: sequenceNum++,
            toolName,
            calledAt: typeof event.timestamp === 'string' ? event.timestamp : null,
            success: true,
            filePath: filePath2,
            command,
            errorText: null,
          };
          toolCallIndexById.set(tc.id, toolCalls.length);
          toolCalls.push(tc);

          // Aggregate file-touch counts by tool category.
          if (filePath2) {
            if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
              bumpFile(filePath2, 'read');
            } else if (toolName === 'Write') {
              bumpFile(filePath2, 'write');
            } else if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
              bumpFile(filePath2, 'edit');
            }
          }
        }
      }
      continue;
    }

    // All other event types (queue-operation, attachment, system, mode,
    // last-prompt, etc.) are ignored for indexing purposes.
  }

  const fileBase = path.basename(filePath, '.jsonl');

  // Skip sub-agent (sidechain) transcripts. They carry the parent's sessionId,
  // so indexing them would overwrite the canonical parent session row. A file
  // is a sidechain when its events are predominantly sidechain AND its filename
  // does not match the sessionId it reports (canonical files are named by their
  // own sessionId, e.g. "<uuid>.jsonl"; sub-agent files are "agent-<hash>.jsonl").
  const isSidechainFile =
    sidechainEvents > 0 && mainEvents === 0 && sessionId !== null && sessionId !== fileBase;
  if (isSidechainFile) {
    return null;
  }

  // A usable session needs at least an id and a start timestamp.
  if (!sessionId) {
    // Fall back to the file name (sessionId UUID) if no event carried it.
    sessionId = fileBase;
  }
  if (!firstTimestamp) {
    // No timestamped events at all — nothing meaningful to index.
    return null;
  }

  const startedAt = firstTimestamp;
  const endedAt = lastTimestamp;
  let durationMs: number | null = null;
  if (startedAt && endedAt) {
    const d = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    durationMs = Number.isFinite(d) && d >= 0 ? d : null;
  }

  return {
    id: sessionId,
    projectHash,
    projectPath,
    aiTitle,
    model,
    ccVersion,
    gitBranch,
    startedAt,
    endedAt,
    durationMs,
    inputTokens,
    outputTokens,
    lastInputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    toolCallCount: toolCalls.length,
    errorCount,
    userTurnCount,
    rawPath: filePath,
    toolCalls,
    filesTouched: [...files.values()],
  };
}
