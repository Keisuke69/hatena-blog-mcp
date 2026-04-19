import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerEntryTools } from "./tools/entries.js";
import { registerPageTools } from "./tools/pages.js";

/**
 * Server metadata reported via the MCP `initialize` handshake.
 *
 * Kept as a constant so the Workers adapter and any future test harnesses
 * see the same name/version without having to repeat string literals.
 */
export const SERVER_INFO = {
  name: "hatena-blog-mcp",
  version: "0.1.0",
} as const;

/**
 * Build a fresh {@link McpServer} scoped to one request's credentials.
 *
 * We deliberately instantiate a new server per request rather than holding
 * a long-lived singleton: tool handlers close over `ctx.credentials`, and
 * the BYOK model means every request brings its own Authorization header.
 * Re-using a server across requests would leak credentials between callers.
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
    },
  });
  registerEntryTools(server, ctx);
  registerPageTools(server, ctx);
  registerCategoryTools(server, ctx);
  return server;
}
