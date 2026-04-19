import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/adapters/cloudflare/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const readFixture = (name: string) => readFileSync(resolve(fixturesDir, name), "utf-8");

const basicAuth = `Basic ${btoa("example_user:apikey")}`;

function jsonRpc(method: string, params: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

/**
 * The adapter creates its AtomPubClient internally, so to intercept outbound
 * Hatena calls we stub `globalThis.fetch` for the duration of each test.
 * The ToolContext's `fetchImpl` is only used when explicitly provided;
 * the cloudflare adapter does not set one, so default fetch is what runs.
 */
function withStubbedFetch<T>(
  plan: Array<Response | Error>,
  body: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const step = plan[i];
    i += 1;
    if (!step) throw new Error(`fetch stub exhausted (call ${i})`);
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return body(calls).finally(() => {
    globalThis.fetch = original;
  });
}

async function mcpCall(
  app: ReturnType<typeof createApp>,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: basicAuth,
      ...headers,
    },
    body,
  });
}

describe("cloudflare adapter — CORS", () => {
  const app = createApp();

  it("OPTIONS preflight returns 204 with Allow-Headers including Authorization", async () => {
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "mcp-session-id",
    );
  });

  it("ALLOWED_ORIGINS allowlist echoes back the matched origin", async () => {
    const res = await app.request(
      "/mcp",
      {
        method: "OPTIONS",
        headers: { Origin: "https://claude.ai" },
      },
      { ALLOWED_ORIGINS: "https://claude.ai,https://chatgpt.com" },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
  });

  it("non-preflight responses also carry the CORS header", async () => {
    const res = await app.request("/");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("cloudflare adapter — auth", () => {
  const app = createApp();

  it("missing Authorization → 401 JSON-RPC error", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: jsonRpc("tools/list", {}),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Authorization");
  });

  it("non-Basic scheme → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer xxx",
      },
      body: jsonRpc("tools/list", {}),
    });
    expect(res.status).toBe(401);
  });
});

describe("cloudflare adapter — MCP protocol", () => {
  const app = createApp();

  async function initializeAndListTools(): Promise<{ tools: string[] }> {
    // initialize first
    const initRes = await mcpCall(
      app,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0.0.0" },
        },
      }),
    );
    expect(initRes.status).toBe(200);
    const initBody = (await initRes.json()) as { result: { serverInfo: { name: string } } };
    expect(initBody.result.serverInfo.name).toBe("hatena-blog-mcp");

    const listRes = await mcpCall(app, jsonRpc("tools/list", {}, 2));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    return { tools: listBody.result.tools.map((t) => t.name) };
  }

  it("initialize + tools/list exposes all 11 tools", async () => {
    const { tools } = await initializeAndListTools();
    expect(tools.sort()).toEqual(
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

  it("tools/call list_entries relays the BYOK header to Hatena AtomPub", async () => {
    await withStubbedFetch(
      [new Response(readFixture("entry-list.xml"), { status: 200 })],
      async (calls) => {
        const res = await mcpCall(
          app,
          jsonRpc(
            "tools/call",
            {
              name: "list_entries",
              arguments: { blog_id: "example_user.hatenablog.com" },
            },
            3,
          ),
        );
        expect(res.status).toBe(200);
        expect(calls[0]).toContain("/example_user/example_user.hatenablog.com/atom/entry");
        const body = (await res.json()) as {
          result: { structuredContent?: { entries?: unknown[] } };
        };
        expect(body.result.structuredContent?.entries).toBeDefined();
      },
    );
  });

  it("tools/call propagates Hatena 401 as isError result (no HTTP 500)", async () => {
    await withStubbedFetch([new Response("nope", { status: 401 })], async () => {
      const res = await mcpCall(
        app,
        jsonRpc(
          "tools/call",
          {
            name: "list_entries",
            arguments: { blog_id: "example_user.hatenablog.com" },
          },
          4,
        ),
      );
      // JSON-RPC wraps tool errors as a successful response with isError:true,
      // so the HTTP status stays 200.
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("認証");
    });
  });
});

describe("cloudflare adapter — misc", () => {
  const app = createApp();

  it("GET / returns a health payload", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; ok: boolean };
    expect(body.name).toBe("hatena-blog-mcp");
    expect(body.ok).toBe(true);
  });
});
