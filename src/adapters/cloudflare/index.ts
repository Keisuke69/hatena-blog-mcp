import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { ToolContext } from "../../mcp/context.js";
import { createServer } from "../../mcp/server.js";
import { MissingCredentialsError, parseBasicAuth } from "../../utils/auth.js";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// Web/モバイルから直接叩けるよう `*` で開けつつ、BYOK の Authorization ヘッダを
// 通すために preflight で明示する。credentials は使わない (Authorization だけで
// 認証する設計) ので `Access-Control-Allow-Credentials` は付けない。
// 一般的なリモート MCP サーバの構成に合わせている。
//
// 将来ドメインを絞りたくなったら ALLOWED_ORIGINS (カンマ区切り) をセットし、
// 一致した Origin のみエコーバックする形に切り替えられる。

const DEFAULT_ALLOW_HEADERS = "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version";
const DEFAULT_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const DEFAULT_EXPOSE_HEADERS = "Mcp-Session-Id";

function resolveAllowedOrigin(requestOrigin: string | null, allowlist?: string[]): string {
  if (!allowlist || allowlist.length === 0) return "*";
  if (requestOrigin && allowlist.includes(requestOrigin)) return requestOrigin;
  // No match: still echo the first allowed origin so browsers at least see a
  // deterministic value (the request will be blocked client-side anyway).
  return allowlist[0] ?? "*";
}

function parseAllowedOrigins(env: Env | undefined): string[] | undefined {
  const raw = env?.ALLOWED_ORIGINS;
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  /** Optional comma-separated allowlist. When unset, CORS responds with `*`. */
  ALLOWED_ORIGINS?: string;
}

// ---------------------------------------------------------------------------
// App factory (exported for tests; default export is the one-shot instance)
// ---------------------------------------------------------------------------

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    const allowlist = parseAllowedOrigins(c.env);
    const origin = resolveAllowedOrigin(c.req.header("origin") ?? null, allowlist);

    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": DEFAULT_ALLOW_METHODS,
          "Access-Control-Allow-Headers": DEFAULT_ALLOW_HEADERS,
          "Access-Control-Expose-Headers": DEFAULT_EXPOSE_HEADERS,
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }

    await next();

    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Expose-Headers", DEFAULT_EXPOSE_HEADERS);
    c.res.headers.set("Vary", "Origin");
    return;
  });

  app.get("/", (c) =>
    c.json({
      name: "hatena-blog-mcp",
      ok: true,
      transport: "streamable-http",
      endpoint: "/mcp",
    }),
  );

  app.all("/mcp", async (c) => {
    // Parse BYOK credentials once per request; the MCP server closes over them
    // so every tool invocation inside this request relays the same header.
    let ctx: ToolContext;
    try {
      const credentials = parseBasicAuth(c.req.header("authorization") ?? null);
      ctx = { credentials };
    } catch (err) {
      if (err instanceof MissingCredentialsError) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Authorization header (Basic <base64(hatena_id:api_key)>) is required.",
            },
            id: null,
          },
          401,
          { "WWW-Authenticate": 'Basic realm="hatena-blog-mcp"' },
        );
      }
      throw err;
    }

    const server = createServer(ctx);
    // Stateless: omit sessionIdGenerator entirely (per SDK docs, this disables
    // session management). Every request is independent.
    const transport = new WebStandardStreamableHTTPServerTransport({
      // JSON responses (no SSE) — Claude Desktop / Web / mobile all accept this
      // and it's the simpler path for a stateless server on Workers.
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      // Fire-and-forget: closing is best-effort; we don't want cleanup errors
      // to mask a successful response.
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    }
  });

  return app;
}

const app = createApp();
export default app;
