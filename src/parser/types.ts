/**
 * Type definitions for Claude Code JSONL transcript events and the
 * normalized session model produced by the parser.
 */

/** A single usage block as emitted on an assistant message. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A content block inside an assistant or user message. */
export interface ContentBlock {
  type: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  // text / thinking
  text?: string;
  thinking?: string;
}

export interface Message {
  role?: string;
  model?: string;
  usage?: Usage;
  content?: string | ContentBlock[];
}

/**
 * A raw JSONL line. Only the fields the parser inspects are typed; the rest
 * are permitted via the index signature so unknown event types parse cleanly.
 */
export interface RawEvent {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  message?: Message;
  aiTitle?: string;
  [key: string]: unknown;
}

/** A normalized tool call extracted from the transcript. */
export interface ParsedToolCall {
  id: string;
  sequenceNum: number;
  toolName: string;
  calledAt: string | null;
  success: boolean;
  filePath: string | null;
  command: string | null;
  errorText: string | null;
}

/** Aggregated per-file activity within a session. */
export interface ParsedFileTouched {
  filePath: string;
  readCount: number;
  writeCount: number;
  editCount: number;
}

/** A captured reasoning ("thinking") block, indexed for full-text search. */
export interface ParsedReasoning {
  sequenceNum: number;
  text: string;
}

/** The fully normalized representation of one session transcript. */
export interface ParsedSession {
  id: string;
  /** The top-level session that spawned this one, or null if top-level. */
  parentSessionId: string | null;
  /** Originating agent tool: 'claude-code', 'aider', 'cline', … */
  source: string;
  projectHash: string;
  projectPath: string | null;
  aiTitle: string | null;
  model: string | null;
  ccVersion: string | null;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  lastInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCallCount: number;
  errorCount: number;
  userTurnCount: number;
  rawPath: string;
  toolCalls: ParsedToolCall[];
  filesTouched: ParsedFileTouched[];
  /** Reasoning blocks — only populated when reasoning indexing is enabled. */
  reasoning?: ParsedReasoning[];
}
