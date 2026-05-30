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
import type { ParsedSession, ParsedToolCall, ParsedFileTouched } from '../types.js';
import type { SourceAdapter, DiscoveredUnit } from './types.js';

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
function mapClineTool(
  tool: string
): { name: string; kind: 'read' | 'write' | 'edit' | null } {
  switch (tool) {
    case 'readFile':
      return { name: 'read_file', kind: 'read' };
    case 'editedExistingFile':
      return { name: 'replace_in_file', kind: 'edit' };
    case 'newFileCreated':
      return { name: 'write_to_file', kind: 'write' };
    default:
      // listFilesTopLevel, listFilesRecursive, searchFiles, listCodeDefinitions…
      return { name: tool, kind: null };
  }
}

/** Parse one Cline task directory into a normalized session. */
export function parseClineTask(taskDir: string): ParsedSession | null {
  const uiPath = path.join(taskDir, 'ui_messages.json');
  const messages = tryParse<ClineUiMessage[]>(safeRead(uiPath));
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const taskId = path.basename(taskDir);
  let title: string | null = null;
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

    if (m.say === 'task') {
      if (!title && m.text) title = m.text.replace(/\s+/g, ' ').trim().slice(0, 120);
      userTurnCount++;
      continue;
    }
    if (m.say === 'user_feedback') {
      userTurnCount++;
      continue;
    }
    if (m.say === 'api_req_started' || m.say === 'api_req_finished') {
      const info = tryParse<{
        tokensIn?: number;
        tokensOut?: number;
        cacheReads?: number;
        cacheWrites?: number;
        cwd?: string;
      }>(m.text);
      if (info) {
        const ti = Number(info.tokensIn) || 0;
        inputTokens += ti;
        outputTokens += Number(info.tokensOut) || 0;
        cacheReadTokens += Number(info.cacheReads) || 0;
        cacheCreationTokens += Number(info.cacheWrites) || 0;
        if (ti > 0) lastInputTokens = ti;
        if (!projectPath && typeof info.cwd === 'string') projectPath = info.cwd;
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
    if (m.say === 'error' || m.ask === 'mistake_limit_reached') {
      errorCount++;
      // Attribute to the most recent tool call when possible.
      const last = toolCalls[toolCalls.length - 1];
      if (last && last.success) {
        last.success = false;
        last.errorText = (m.text ?? '').replace(/\s+/g, ' ').slice(0, 2000);
      }
      continue;
    }
  }

  if (firstTs == null) return null;
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
