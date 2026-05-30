/**
 * `agentslog mcp` — run as an MCP (Model Context Protocol) server so a coding
 * agent can query its own history mid-task: past errors, file history, stats,
 * and reasoning. Communicates over stdio, so nothing may be written to stdout
 * except the protocol itself.
 */
import { openDbReadonly } from '../../db/index.js';
import { startStdioServer } from '../../mcp/server.js';
import { runIngest } from './ingest.js';

export interface McpOptions {
  /** Refresh the index before serving so the agent sees current history. */
  ingest?: boolean;
}

/** Optionally refresh, then serve the read tools over stdio. */
export async function runMcp(options: McpOptions = {}): Promise<void> {
  if (options.ingest !== false) {
    // Silent: stdout is the MCP channel — any stray output corrupts JSON-RPC.
    await runIngest({ quiet: true, silent: true });
  }
  const db = openDbReadonly();
  await startStdioServer(db);
}
