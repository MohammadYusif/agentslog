/**
 * MCP server wiring: registers the {@link MCP_TOOLS} on an `McpServer` and
 * serves them over stdio. The DB handle is injected so tests can build a server
 * over an in-memory database.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type Database from 'better-sqlite3';
import { MCP_TOOLS } from './tools.js';

/** Build an MCP server exposing the agentslog read tools over `db`. */
export function createServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'agentslog', version: '0.3.0' });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>) => {
        const result = tool.handler(db, args ?? {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }

  return server;
}

/** Start the server on stdio (blocks until the transport closes). */
export async function startStdioServer(db: Database.Database): Promise<void> {
  const server = createServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
