# hatena-blog-mcp

[日本語 README](./README.md) | English

An MCP (Model Context Protocol) server that wraps the [Hatena Blog AtomPub API](https://developer.hatena.ne.jp/ja/documents/blog/apis/atom) with **read and write** support, designed to run on **Cloudflare Workers** with a **BYOK (Bring Your Own Key)** model.

Built for the canonical use case of asking Claude to bulk re-tag categories across every entry in a blog — without accidentally rewriting titles, bodies, or publish dates along the way.

## Features

- Entries: `list_entries`, `get_entry`, `create_entry`, `update_entry`, `delete_entry`
- Pages: `list_pages`, `get_page`, `create_page`, `update_page`, `delete_page`
- Categories: `list_categories`
- **Safe partial updates**: `update_entry` / `update_page` keep existing title, body, syntax, publish date, and slug unless you explicitly change them. The body's `content_type` is always taken from the existing entry so Markdown never silently flips to plain text.
- Zero state on the server — credentials live only in the `Authorization` header of each request.

## Transport

- **MCP Streamable HTTP** only (`POST /mcp`, JSON response mode)
- No stdio — use [`mcp-remote`](https://github.com/geelen/mcp-remote) if your client can only speak stdio
- No SSE

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/mcp` | MCP Streamable HTTP entry point |
| `OPTIONS` | `/mcp` | CORS preflight |
| `GET` | `/` | Health / identification JSON |

---

## Quick start: Deploy to Cloudflare Workers

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler deploy
```

That's it. No secrets, no KV, no Durable Objects — clients supply credentials on each request. Your URL will look like `https://hatena-blog-mcp.<your-subdomain>.workers.dev`.

### Optional env var

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | _unset_ → `*` | Comma-separated CORS allowlist (e.g. `https://claude.ai,https://chatgpt.com`). When unset, the server responds with `Access-Control-Allow-Origin: *` — safe because authentication is done per-request via the `Authorization` header, not cookies. |

Set it with:

```sh
pnpm exec wrangler deploy --var ALLOWED_ORIGINS:"https://claude.ai,https://chatgpt.com"
```

---

## Authentication (BYOK)

This server stores **no credentials**. Every request must carry:

```
Authorization: Basic base64(hatena_id:api_key)
```

Get your API key from **Hatena Blog → Settings → Advanced → AtomPub**. The Hatena ID is the left side of your blog URL (`<hatena_id>.hatenablog.com`).

The same deployed Worker can be shared by multiple users — each supplies their own key.

---

## Client setup

### Claude Desktop / Claude.ai Web / mobile (native remote MCP)

Add a new remote MCP server and point it at your Worker URL:

- **URL**: `https://hatena-blog-mcp.<your-subdomain>.workers.dev/mcp`
- **Auth**: Basic, username = your Hatena ID, password = your AtomPub API key

### Claude Code (or any stdio-only client) via `mcp-remote`

`mcp-remote` bridges stdio → Streamable HTTP locally:

```jsonc
// ~/.claude.json or the equivalent per-client config
{
  "mcpServers": {
    "hatena-blog": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://hatena-blog-mcp.<your-subdomain>.workers.dev/mcp",
        "--header",
        "Authorization: Basic ${BASIC_AUTH}"
      ],
      "env": {
        "BASIC_AUTH": "<base64(hatena_id:api_key)>"
      }
    }
  }
}
```

Generate the base64 value with `printf '%s' 'hatena_id:api_key' | base64`.

### MCP Inspector (for quick manual testing)

```sh
pnpm exec wrangler dev  # in one terminal
npx @modelcontextprotocol/inspector
```

In the inspector, choose **Streamable HTTP**, URL `http://localhost:8787/mcp`, and set a custom header `Authorization: Basic <base64>`.

---

## Tool reference

Every tool takes a required `blog_id` (e.g. `example.hatenablog.com`) and an optional `hatena_id` to override the username from the `Authorization` header (useful for group blogs).

### Entries

| Name | Purpose | Required | Key options |
| --- | --- | --- | --- |
| `list_entries` | List entries (7 per page) | `blog_id` | `page`, `include_html` |
| `get_entry` | Fetch one entry | `blog_id`, `entry_id` | `include_html` |
| `create_entry` | Post a new entry | `blog_id`, `title`, `content` | `content_type`, `categories`, `draft`, `preview`, `scheduled`+`updated`, `custom_url` |
| `update_entry` | **Partial update** | `blog_id`, `entry_id` | `title`, `content`, `categories` (`[]` to clear), `draft`, `preview`, `custom_url`, `touch_updated` |
| `delete_entry` | Delete an entry | `blog_id`, `entry_id` | — |

`update_entry` semantics:
- Any field you omit is kept from the existing entry.
- `content_type` is **always** taken from the existing entry — you cannot change Markdown ↔ plain text via this tool.
- `updated` is only sent when `touch_updated: true` (default: keep the original publish date).
- `custom_url` is only sent when you specify it (default: keep the existing slug).

### Pages

Same shape as entries minus `categories` / `scheduled`. `create_page` requires `custom_url` (Hatena treats it as the page's permanent slug).

### Categories

- `list_categories` → `{ categories: string[], fixed: boolean }`. `fixed: true` means new categories can't be added to this blog.

---

## Example: bulk category re-tagging (the original motivation)

Once the MCP server is connected, ask Claude something like:

> "私のブログ `example.hatenablog.com` の全エントリを `list_entries` で列挙して、各エントリの本文を読んだうえで既存カテゴリを整理し直してください。タイトル・本文・投稿日時は絶対に変更しないでください。"

Because `update_entry` only sends the fields you pass, Claude can safely call:

```json
{
  "name": "update_entry",
  "arguments": {
    "blog_id": "example.hatenablog.com",
    "entry_id": "3000000000000000010",
    "categories": ["技術", "TypeScript", "Cloudflare"]
  }
}
```

…without rewriting the body, flipping Markdown to plain text, or nudging the publish date to today.

---

## Development

```sh
pnpm install
pnpm dev                  # wrangler dev on http://localhost:8787
pnpm test                 # vitest
pnpm test:coverage        # coverage report (overall >= 60%, xml.ts >= 90%)
pnpm lint                 # biome check
pnpm lint:fix             # biome check --write
pnpm typecheck            # tsc --noEmit
pnpm exec wrangler deploy --dry-run --outdir /tmp/out  # bundle sanity check
```

### Layout

```
src/
  atompub/     — stateless HTTP client for the Hatena AtomPub API
  mcp/
    tools/     — entries.ts, pages.ts, categories.ts (one tool group per file)
    server.ts  — createServer() registers all 11 tools onto a fresh McpServer
    context.ts — per-request credentials + client factory
    response.ts — ToolTextResult + Japanese error mapping
  adapters/cloudflare/
    index.ts   — Hono app: CORS → BYOK auth → Streamable HTTP transport
  utils/
    auth.ts    — parseBasicAuth
    retry.ts   — exponential backoff + jitter, honours Retry-After
test/
  fixtures/    — real AtomPub response samples
  ...
```

---

## Security notes

- **This server relays `Authorization` verbatim.** Credentials reach the Worker decoded from the header, then flow through to Hatena on each AtomPub call. They are never written to any durable storage, but you should still host this somewhere you trust. A malicious or compromised Worker could log or misuse every key that passes through it.
- **Logs intentionally omit credentials and response bodies.** Only status codes and error categories reach `console.*`. If you add logging, keep it that way.
- **CORS is wide open by default.** This is safe because authentication is done via `Authorization` rather than cookies (no CSRF surface), and `Access-Control-Allow-Credentials` is never set. If you'd rather narrow it, set `ALLOWED_ORIGINS`.
- **No DNS-rebinding protection.** The Streamable HTTP transport's built-in checks are deprecated; if you expose this to untrusted networks, front it with a proxy that enforces `Host` / `Origin`.
- **Rate limits and abuse.** A public deployment can be hammered by anyone who knows the URL. Cloudflare's free plan already enforces global limits, but consider Wrangler's `[limits]` block and a WAF rate-limit rule if this becomes a problem.
- **If an API key leaks**, revoke it from *Hatena Blog → Settings → Advanced → AtomPub* and rotate. This server has nothing to purge.

---

## License

MIT © Keisuke Nishitani
