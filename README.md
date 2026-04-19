# hatena-blog-mcp

An MCP (Model Context Protocol) server that wraps the [Hatena Blog AtomPub API](https://developer.hatena.ne.jp/ja/documents/blog/apis/atom) with **read and write** support, designed to run on **Cloudflare Workers** with a **BYOK (Bring Your Own Key)** model.

> Status: under active development. Not ready for use yet.

## Features (planned)

- List / get / create / update / delete blog entries
- List / get / create / update / delete fixed pages
- List categories used in a blog
- **Safe partial updates**: `update_entry` preserves existing title, body, syntax, publish date, and URL unless explicitly told to change them — ideal for bulk category re-tagging with an LLM
- Stateless & credentials-free on the server side (BYOK via `Authorization` header)
- Ships as a single Cloudflare Workers script; reusable across deployment targets

## Transport

- **MCP Streamable HTTP** only
- No stdio (use `mcp-remote` if you need a local-looking transport)
- No SSE

## Authentication (BYOK)

This server stores **no credentials**. Clients supply their Hatena ID and AtomPub API key on every request via:

```
Authorization: Basic base64(hatena_id:api_key)
```

Get the API key from *Hatena Blog → Settings → Advanced → AtomPub*.

Because the same deployed Worker can be shared by multiple users with their own keys, please read the security notes before hosting a public instance.

## Development

```sh
pnpm install
pnpm dev          # wrangler dev
pnpm test         # vitest
pnpm lint         # biome check
pnpm typecheck    # tsc --noEmit
```

## Tools (planned)

| Name | Kind | Description |
| --- | --- | --- |
| `list_entries` | read | List blog entries (7 per page) |
| `get_entry` | read | Get a single entry |
| `create_entry` | write | Create a new entry |
| `update_entry` | write | Partial update — preserves unspecified fields |
| `delete_entry` | write | Delete an entry |
| `list_pages` | read | List fixed pages (10 per page) |
| `get_page` | read | Get a single fixed page |
| `create_page` | write | Create a fixed page |
| `update_page` | write | Partial update a fixed page |
| `delete_page` | write | Delete a fixed page |
| `list_categories` | read | List categories used in the blog |

## Security

*(to be filled in before release)*

- The server relays `Authorization` as-is; don't host it on untrusted infrastructure.
- Hosting a shared Worker means other users' API keys pass through your deployment. Consider whether that matches your trust model.
- Keys are never logged; error messages never include credentials.

## License

MIT © Keisuke Nishitani
