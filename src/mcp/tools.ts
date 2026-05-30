/**
 * MCP tool definitions: pure handler functions over a (read-only) database,
 * plus the zod input schemas and descriptions the agent reads to decide when to
 * call them. Kept transport-agnostic so they can be unit-tested directly.
 *
 * The `description` strings are effectively prompts for the calling agent —
 * each is framed around *when to reach for the tool*.
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  childSessions,
  filesForSession,
  listSessions,
  recentErrors,
  resolveSession,
  searchReasoning,
  sessionsByFile,
  sessionsByTool,
  statsTotals,
  tokensByModel,
  toolCallsForSession,
  topFiles,
  topTools,
} from '../db/queries.js';
import { estimateCost } from '../utils/pricing.js';
import { windowCutoffIso } from '../utils/time.js';

const lastDesc =
  'Optional time window: a number followed by s/m/h/d/w (e.g. "7d", "24h", "2w"). Omit for all time.';

/** Handlers return heterogeneous JSON-serializable shapes from the query layer. */
type Json = any;

export interface McpTool {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (db: Database.Database, args: Record<string, unknown>) => Json;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_sessions',
    title: 'List recent sessions',
    description:
      'List recent coding-agent sessions (most recent first) with their titles, projects, models, token totals, and sub-agent counts. Use it to get oriented in the history before drilling into a specific session.',
    schema: {
      last: z.string().optional().describe(lastDesc),
      project: z.string().optional().describe('Filter to a project by path or hash substring.'),
      source: z.string().optional().describe('Filter by source: claude-code, cline, or aider.'),
      limit: z.number().int().positive().max(200).optional().describe('Max rows (default 25).'),
    },
    handler: (db, a) =>
      listSessions(db, {
        sinceIso: windowCutoffIso(a.last as string | undefined),
        project: (a.project as string) ?? null,
        source: (a.source as string) ?? null,
        limit: (a.limit as number) ?? 25,
      }),
  },
  {
    name: 'find_sessions_by_file',
    title: 'Find sessions that touched a file',
    description:
      'Before editing a file, find every past session that read, wrote, or edited it — so you can learn what previously changed there and what broke. Matches by full path or bare filename.',
    schema: {
      file: z.string().describe('A file path or bare filename, e.g. "src/auth.ts" or "auth.ts".'),
      last: z.string().optional().describe(lastDesc),
    },
    handler: (db, a) =>
      sessionsByFile(db, a.file as string, windowCutoffIso(a.last as string | undefined)),
  },
  {
    name: 'find_sessions_by_tool',
    title: 'Find sessions that used a tool',
    description:
      'Find past sessions that invoked a specific tool (e.g. Bash, Edit, Agent, WebSearch). Useful for locating where a particular kind of action was performed.',
    schema: {
      tool: z.string().describe('Tool name, e.g. "Bash", "Edit", "Agent".'),
      last: z.string().optional().describe(lastDesc),
    },
    handler: (db, a) =>
      sessionsByTool(db, a.tool as string, windowCutoffIso(a.last as string | undefined)),
  },
  {
    name: 'get_session',
    title: 'Get full detail of one session',
    description:
      'Pull the full record of one past session — every tool call, file touched, error, and sub-agent it spawned — when you need to understand exactly what a prior run did. Accepts any unique id prefix.',
    schema: {
      id: z.string().describe('A session id or unique prefix (e.g. the first 8 characters).'),
    },
    handler: (db, a) => {
      const session = resolveSession(db, a.id as string);
      if (!session) return { error: `No session matches "${a.id}".` };
      return {
        session,
        toolCalls: toolCallsForSession(db, session.id),
        filesTouched: filesForSession(db, session.id),
        subAgents: childSessions(db, session.id),
      };
    },
  },
  {
    name: 'recent_errors',
    title: 'Recent failed tool calls',
    description:
      'Before running a complex or previously-tricky shell command or edit, call this to see whether you (or past sessions) already failed at it — and why — so you do not repeat the mistake. Returns recent failed tool calls with their command/file and error text, newest first.',
    schema: {
      last: z.string().optional().describe(lastDesc),
      tool: z.string().optional().describe('Only failures from this tool, e.g. "Bash".'),
      project: z.string().optional().describe('Filter to a project by path or hash substring.'),
      limit: z.number().int().positive().max(100).optional().describe('Max failures (default 20).'),
    },
    handler: (db, a) =>
      recentErrors(db, {
        sinceIso: windowCutoffIso(a.last as string | undefined),
        tool: (a.tool as string) ?? null,
        project: (a.project as string) ?? null,
        limit: (a.limit as number) ?? 20,
      }),
  },
  {
    name: 'get_stats',
    title: 'Aggregate stats',
    description:
      'Get aggregate statistics over a time window: session count, token totals, estimated cost, error rate, and the most-touched files and most-used tools. Use it to understand overall activity and spend.',
    schema: { last: z.string().optional().describe(lastDesc) },
    handler: (db, a) => {
      const sinceIso = windowCutoffIso(a.last as string | undefined);
      const totals = statsTotals(db, sinceIso);
      let costUsd = 0;
      let hasPriced = false;
      for (const m of tokensByModel(db, sinceIso)) {
        const c = estimateCost(m.model, {
          inputTokens: m.input_tokens,
          outputTokens: m.output_tokens,
          cacheReadTokens: m.cache_read_tokens,
          cacheCreationTokens: m.cache_creation_tokens,
        });
        if (c != null) {
          costUsd += c;
          hasPriced = true;
        }
      }
      return {
        totals,
        estimatedCostUsd: hasPriced ? Number(costUsd.toFixed(4)) : null,
        topFiles: topFiles(db, sinceIso, 10),
        topTools: topTools(db, sinceIso, 10),
      };
    },
  },
  {
    name: 'search_reasoning',
    title: 'Search past reasoning',
    description:
      "Search the *reasoning* behind past decisions (the agent's recorded thinking) by keyword — use it to recall *why* a previous approach was chosen, not just what was done. Returns ranked snippets with their session context. (Empty unless reasoning indexing was enabled during ingest.)",
    schema: {
      query: z.string().describe('Keywords to search for in past reasoning text.'),
      last: z.string().optional().describe(lastDesc),
      limit: z.number().int().positive().max(50).optional().describe('Max matches (default 20).'),
    },
    handler: (db, a) =>
      searchReasoning(db, a.query as string, {
        sinceIso: windowCutoffIso(a.last as string | undefined),
        limit: (a.limit as number) ?? 20,
      }),
  },
];
