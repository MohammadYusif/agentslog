/**
 * Cline (saoudrizwan.claude-dev) source adapter — EXPERIMENTAL.
 *
 * Cline stores each task under VS Code's globalStorage in its own directory
 * containing `ui_messages.json` (the timeline, including token usage and tool
 * activity) and `api_conversation_history.json` (the raw model messages). We
 * read the timeline, which carries everything we index, and tolerate format
 * drift across Cline versions by parsing each entry defensively.
 *
 * This adapter is unvalidated against a live Cline install; the fixture tests
 * encode the documented shape. Report format mismatches as issues.
 */
import fs from 'node:fs';
import path from 'node:path';
import { clineTasksDir } from '../../utils/paths.js';
import { normalizePath } from '../claude-code.js';
import type { ParsedFileTouched, ParsedSession, ParsedToolCall } from '../types.js';
import type { DiscoveredUnit, SourceAdapter } from './types.js';

interface ClineUiMessage {
  ts?: number;
  type?: string; // 'say' | 'ask'
  say?: string; // 'task' | 'text' | 'api_req_started' | 'tool' | 'command' | 'error' | …
  ask?: string;
  text?: string;
}

/** Safely JSON.parse a string, returning null on failure. */
function tryParse<T>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Map a Cline `tool` say-message to a (toolName, file, kind) triple. */
function mapClineTool(tool: string): { name: string; kind: 'read' | 'write' | 'edit' | null } {
  switch (tool) {
    case 'readFile':
      return { name: 'read_file', kind: 'read' };
    case 'editedExistingFile':
      return { name: 'replace_in_file', kind: 'edit' };
    case 'newFileCreated':
      return { name: 'write_to_file', kind: 'write' };
    case 'fileDeleted':
      return { name: 'delete_file', kind: 'edit' };
    default:
      // listFilesTopLevel, listFilesRecursive, searchFiles, listCodeDefinitions…
      return { name: tool, kind: null };
  }
}

/** Map an XML/native tool name (used in api_conversation_history) to a kind. */
function mapApiTool(name: string): 'read' | 'write' | 'edit' | 'command' | null {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'write_to_file':
      return 'write';
    case 'replace_in_file':
    case 'apply_diff':
    case 'insert_content':
      return 'edit';
    case 'execute_command':
      return 'command';
    default:
      return null; // search_files, list_files, ask_followup_question, …
  }
}

/** Tool tags recognised inside assistant text in older Cline transcripts. */
const API_TOOL_NAMES = [
  'read_file',
  'write_to_file',
  'replace_in_file',
  'apply_diff',
  'insert_content',
  'execute_command',
  'search_files',
  'list_files',
] as const;

interface ApiToolHit {
  name: string;
  path: string | null;
  command: string | null;
}

/** Pull tool invocations out of one assistant text blob's XML tags. */
function extractXmlTools(text: string): ApiToolHit[] {
  const hits: ApiToolHit[] = [];
  for (const name of API_TOOL_NAMES) {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
    for (const m of text.matchAll(re)) {
      const inner = m[1];
      const pathM = /<path>([\s\S]*?)<\/path>/.exec(inner);
      const cmdM = /<command>([\s\S]*?)<\/command>/.exec(inner);
      hits.push({
        name,
        path: pathM ? pathM[1].trim() : null,
        command: cmdM ? cmdM[1].trim() : null,
      });
    }
  }
  return hits;
}

/**
 * Fallback tool extraction for older Cline transcripts whose `ui_messages.json`
 * carries no `say:"tool"` entries: the tool activity lives in the sibling
 * `api_conversation_history.json`, either as native Anthropic `tool_use` blocks
 * or as XML tags embedded in assistant text. Returns [] if unavailable.
 */
function extractToolsFromApiHistory(taskDir: string): ApiToolHit[] {
  const file = path.join(taskDir, 'api_conversation_history.json');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  // Guard against pathological sizes (these can grow large).
  if (stat.size > 25 * 1024 * 1024) return [];

  const messages = tryParse<{ role?: string; content?: unknown }[]>(safeRead(file));
  if (!Array.isArray(messages)) return [];

  const hits: ApiToolHit[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const content = m.content;
    if (typeof content === 'string') {
      hits.push(...extractXmlTools(content));
    } else if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          hits.push({
            name: block.name,
            path:
              typeof input.path === 'string'
                ? input.path
                : typeof input.file_path === 'string'
                  ? input.file_path
                  : null,
            command: typeof input.command === 'string' ? input.command : null,
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          hits.push(...extractXmlTools(block.text));
        }
      }
    }
  }
  return hits;
}

/** Parse one Cline task directory into a normalized session. */
export function parseClineTask(taskDir: string): ParsedSession | null {
  const uiPath = path.join(taskDir, 'ui_messages.json');
  const messages = tryParse<ClineUiMessage[]>(safeRead(uiPath));
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const taskId = path.basename(taskDir);
  let title: string | null = null;
  // Real Cline tasks frequently omit a say:"task" message — the user's initial
  // prompt is then the first say:"text". Capture the first user-facing text so
  // we can fall back to it for the title.
  let firstUserText: string | null = null;
  let projectPath: string | null = null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let lastInputTokens = 0;

  let errorCount = 0;
  let userTurnCount = 0;

  let firstTs: number | null = null;
  let lastTs: number | null = null;

  let sequenceNum = 0;
  const toolCalls: ParsedToolCall[] = [];
  const files = new Map<string, ParsedFileTouched>();
  const bumpFile = (fp: string, kind: 'read' | 'write' | 'edit') => {
    const key = normalizePath(fp);
    let e = files.get(key);
    if (!e) {
      e = { filePath: key, readCount: 0, writeCount: 0, editCount: 0 };
      files.set(key, e);
    }
    if (kind === 'read') e.readCount++;
    else if (kind === 'write') e.writeCount++;
    else e.editCount++;
  };

  for (const m of messages) {
    if (typeof m.ts === 'number') {
      if (firstTs == null) firstTs = m.ts;
      lastTs = m.ts;
    }
    const isoAt = typeof m.ts === 'number' ? new Date(m.ts).toISOString() : null;

    // Remember the first plain user/assistant text (the task lives here when
    // there is no dedicated say:"task").
    if (!firstUserText && (m.say === 'task' || m.say === 'text') && typeof m.text === 'string') {
      const t = m.text.replace(/\s+/g, ' ').trim();
      if (t) firstUserText = t;
    }

    if (m.say === 'task') {
      if (!title && m.text) title = m.text.replace(/\s+/g, ' ').trim().slice(0, 120);
      userTurnCount++;
      continue;
    }
    if (m.say === 'user_feedback' || m.say === 'user_feedback_diff') {
      userTurnCount++;
      continue;
    }
    if (m.say === 'api_req_started' || m.say === 'api_req_finished') {
      const info = tryParse<{
        tokensIn?: number;
        tokensOut?: number;
        cacheReads?: number;
        cacheWrites?: number;
        cost?: number;
        cwd?: string;
        request?: string;
        cancelReason?: string;
      }>(m.text);
      if (info) {
        const ti = Number(info.tokensIn) || 0;
        inputTokens += ti;
        outputTokens += Number(info.tokensOut) || 0;
        cacheReadTokens += Number(info.cacheReads) || 0;
        cacheCreationTokens += Number(info.cacheWrites) || 0;
        if (ti > 0) lastInputTokens = ti;
        // The cwd is sometimes a field, but more often embedded in the request
        // prompt as "# Current Working Directory (PATH) Files".
        if (!projectPath) {
          if (typeof info.cwd === 'string') projectPath = info.cwd;
          else if (typeof info.request === 'string') {
            const m2 = /# Current Working Directory \(([^)]+)\)/.exec(info.request);
            if (m2) projectPath = m2[1].trim();
          }
        }
      }
      continue;
    }
    if (m.say === 'tool') {
      const info = tryParse<{ tool?: string; path?: string }>(m.text);
      if (info?.tool) {
        const mapped = mapClineTool(info.tool);
        const fp = info.path ? normalizePath(info.path) : null;
        toolCalls.push({
          id: `${taskId}:${sequenceNum}`,
          sequenceNum: sequenceNum++,
          toolName: mapped.name,
          calledAt: isoAt,
          success: true,
          filePath: fp,
          command: null,
          errorText: null,
        });
        if (fp && mapped.kind) bumpFile(fp, mapped.kind);
      }
      continue;
    }
    if (m.say === 'command') {
      toolCalls.push({
        id: `${taskId}:${sequenceNum}`,
        sequenceNum: sequenceNum++,
        toolName: 'execute_command',
        calledAt: isoAt,
        success: true,
        filePath: null,
        command: (m.text ?? '').slice(0, 500),
        errorText: null,
      });
      continue;
    }
    if (
      m.say === 'error' ||
      m.say === 'error_retry' ||
      m.ask === 'api_req_failed' ||
      m.ask === 'mistake_limit_reached'
    ) {
      errorCount++;
      // Attribute to the most recent tool call when possible.
      const last = toolCalls[toolCalls.length - 1];
      if (last?.success) {
        last.success = false;
        last.errorText = (m.text ?? '').replace(/\s+/g, ' ').slice(0, 2000);
      }
    }
  }

  if (firstTs == null) return null;

  // Older Cline transcripts have no say:"tool" entries; recover tool and file
  // activity from the sibling api_conversation_history.json.
  if (toolCalls.length === 0) {
    for (const hit of extractToolsFromApiHistory(taskDir)) {
      const kind = mapApiTool(hit.name);
      const fp = hit.path ? normalizePath(hit.path) : null;
      toolCalls.push({
        id: `${taskId}:${sequenceNum}`,
        sequenceNum: sequenceNum++,
        toolName: hit.name,
        calledAt: null,
        success: true,
        filePath: fp,
        command: hit.command ? hit.command.slice(0, 500) : null,
        errorText: null,
      });
      if (fp && (kind === 'read' || kind === 'write' || kind === 'edit')) bumpFile(fp, kind);
    }
  }

  // Fall back to the first user text when no say:"task" was present, and ensure
  // at least one user turn is counted for a non-empty task.
  if (!title && firstUserText) title = firstUserText.slice(0, 120);
  if (userTurnCount === 0) userTurnCount = 1;
  const startedAt = new Date(firstTs).toISOString();
  const endedAt = lastTs != null ? new Date(lastTs).toISOString() : startedAt;
  const durationMs = lastTs != null ? Math.max(0, lastTs - firstTs) : null;

  const hash = projectPath ? normalizePath(projectPath) : `cline-task-${taskId}`;

  return {
    id: `cline-${taskId}`,
    parentSessionId: null,
    source: 'cline',
    projectHash: hash,
    projectPath: projectPath ? normalizePath(projectPath) : null,
    aiTitle: title,
    model: null, // Cline's model id is not reliably recorded in the timeline
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
    toolCallCount: toolCalls.length,
    errorCount,
    userTurnCount,
    rawPath: taskDir,
    toolCalls,
    filesTouched: [...files.values()],
  };
}

function safeRead(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

export const clineAdapter: SourceAdapter = {
  name: 'cline',
  label: 'Cline',
  experimental: true,

  isAvailable() {
    return fs.existsSync(clineTasksDir());
  },

  discover(): DiscoveredUnit[] {
    const root = clineTasksDir();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: DiscoveredUnit[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      if (fs.existsSync(path.join(dir, 'ui_messages.json'))) {
        out.push({ filePath: dir, projectHash: `cline-task-${e.name}` });
      }
    }
    return out;
  },

  async parse(unit: DiscoveredUnit) {
    const s = parseClineTask(unit.filePath);
    return s ? [s] : [];
  },
};
