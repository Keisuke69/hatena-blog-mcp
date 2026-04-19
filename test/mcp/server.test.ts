import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/mcp/context.js";
import { createServer, SERVER_INFO } from "../../src/mcp/server.js";

const creds = { authHeader: "Basic x", hatenaId: "example_user" };

function makeCtx(): ToolContext {
  return {
    credentials: creds,
    fetchImpl: async () => new Response("", { status: 200 }),
    retry: { maxRetries: 0, baseDelayMs: 0 },
  };
}

describe("createServer", () => {
  it("登録する11ツールがすべて揃っている", () => {
    const server = createServer(makeCtx());
    // McpServer stores registered tools on a private field; reaching into it
    // via the `server` object is brittle, so instead we list them through the
    // public Server's request-handler registry indirectly — the simplest way
    // is to call the underlying Server and ask it to dispatch `tools/list`.
    // But that requires a running transport. Cheaper: rely on the fact that
    // McpServer exposes registered tools on a private `_registeredTools`
    // keyed by name. Probe it with a bracket access + cast.
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const names = Object.keys(registered).sort();
    expect(names).toEqual(
      [
        "create_entry",
        "create_page",
        "delete_entry",
        "delete_page",
        "get_entry",
        "get_page",
        "list_categories",
        "list_entries",
        "list_pages",
        "update_entry",
        "update_page",
      ].sort(),
    );
  });

  it("サーバ名とバージョンを公開している", () => {
    expect(SERVER_INFO.name).toBe("hatena-blog-mcp");
    expect(SERVER_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
