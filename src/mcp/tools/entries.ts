import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AtomPubClient } from "../../atompub/client.js";
import type { ContentType, Entry, EntryWritePayload } from "../../atompub/types.js";
import { makeClient, type ToolContext } from "../context.js";
import { ok, type ToolTextResult, toolError } from "../response.js";

// ---------------------------------------------------------------------------
// Entry view shape (how we present entries back to the MCP client)
// ---------------------------------------------------------------------------

/**
 * Strip internals (atomId, empty strings, optional html) before shipping an
 * entry to the MCP client. Keeps the wire shape stable even if the XML layer
 * grows new fields.
 */
export function entryView(entry: Entry, includeHtml: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: entry.id,
    title: entry.title,
    author: entry.authorName,
    content: entry.content,
    content_type: entry.contentType,
    categories: entry.categories,
    draft: entry.control.draft,
    preview: entry.control.preview,
    scheduled: entry.control.scheduled,
    updated: entry.updated,
  };
  if (entry.published !== undefined) view.published = entry.published;
  if (entry.edited !== undefined) view.edited = entry.edited;
  if (entry.url !== undefined) view.url = entry.url;
  if (entry.customUrl !== undefined) view.custom_url = entry.customUrl;
  if (includeHtml && entry.formattedContent !== undefined) {
    view.formatted_content = entry.formattedContent;
  }
  return view;
}

// ---------------------------------------------------------------------------
// mergeEntry — the heart of update_entry's partial-update semantics
// ---------------------------------------------------------------------------

export interface EntryPatch {
  title?: string;
  content?: string;
  categories?: string[];
  draft?: boolean;
  preview?: boolean;
  customUrl?: string;
  touchUpdated?: boolean;
}

/**
 * Merge a user-supplied patch onto the existing entry, producing a payload
 * safe to PUT. Unspecified fields fall back to existing values — except for
 * `updated` (omitted unless `touchUpdated` is true) and `customUrl` (only
 * sent if the patch explicitly provides one, since omitting it preserves
 * the existing slug).
 *
 * **content_type MUST be taken from the existing entry** — Hatena will coerce
 * the body's syntax mode to match whatever we send, so changing it silently
 * flips Markdown into plain text (or vice versa).
 */
export function mergeEntry(existing: Entry, patch: EntryPatch): EntryWritePayload {
  const payload: EntryWritePayload = {
    title: patch.title ?? existing.title,
    content: patch.content ?? existing.content,
    categories: patch.categories ?? existing.categories,
    control: {
      draft: patch.draft ?? existing.control.draft,
      preview: patch.preview ?? existing.control.preview,
      scheduled: existing.control.scheduled,
    },
  };
  if (existing.contentType !== undefined) payload.contentType = existing.contentType;
  if (existing.authorName) payload.authorName = existing.authorName;
  if (patch.customUrl !== undefined) {
    payload.customUrl = patch.customUrl;
  }
  if (patch.touchUpdated === true) {
    payload.updated = new Date().toISOString();
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Zod shapes (shared shape fragments keep tool definitions DRY)
// ---------------------------------------------------------------------------

const blogId = z.string().min(1).describe("Blog ID, e.g. example.hatenablog.com");
const hatenaIdOverride = z
  .string()
  .min(1)
  .optional()
  .describe("Override the Hatena ID derived from the Authorization header");
const contentTypeSchema = z
  .enum(["text/x-markdown", "text/x-hatena-syntax", "text/html"])
  .describe("Body syntax. Omit on create to use the blog's default.");

// ---------------------------------------------------------------------------
// Handlers (exported for direct unit testing without the MCP framework)
// ---------------------------------------------------------------------------

interface ListEntriesArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  page?: string | undefined;
  include_html?: boolean | undefined;
}

export async function listEntriesHandler(
  args: ListEntriesArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const listOpts: { page?: string } = {};
    if (args.page !== undefined) listOpts.page = args.page;
    const feed = await client.listEntries(listOpts);
    return ok({
      entries: feed.entries.map((e) => entryView(e, args.include_html ?? false)),
      next_page: feed.nextPage,
    });
  } catch (err) {
    return toolError(err);
  }
}

interface GetEntryArgs {
  blog_id: string;
  entry_id: string;
  hatena_id?: string | undefined;
  include_html?: boolean | undefined;
}

export async function getEntryHandler(
  args: GetEntryArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const entry = await client.getEntry(args.entry_id);
    return ok(entryView(entry, args.include_html ?? false));
  } catch (err) {
    return toolError(err);
  }
}

interface CreateEntryArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  title: string;
  content: string;
  content_type?: ContentType | undefined;
  categories?: string[] | undefined;
  draft?: boolean | undefined;
  preview?: boolean | undefined;
  scheduled?: boolean | undefined;
  updated?: string | undefined;
  custom_url?: string | undefined;
}

export async function createEntryHandler(
  args: CreateEntryArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    if (args.scheduled === true && args.updated === undefined) {
      return toolError(
        new Error("scheduled=true の場合は updated (ISO8601 の公開日時) を指定してください。"),
      );
    }
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const payload: EntryWritePayload = {
      title: args.title,
      content: args.content,
      control: {
        draft: args.draft ?? false,
        preview: args.preview ?? false,
        scheduled: args.scheduled ?? false,
      },
    };
    if (args.content_type !== undefined) payload.contentType = args.content_type;
    if (args.categories !== undefined) payload.categories = args.categories;
    if (args.updated !== undefined) payload.updated = args.updated;
    if (args.custom_url !== undefined) payload.customUrl = args.custom_url;
    const entry = await client.createEntry(payload);
    return ok(entryView(entry, false));
  } catch (err) {
    return toolError(err);
  }
}

interface UpdateEntryArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  entry_id: string;
  title?: string | undefined;
  content?: string | undefined;
  categories?: string[] | undefined;
  draft?: boolean | undefined;
  preview?: boolean | undefined;
  custom_url?: string | undefined;
  touch_updated?: boolean | undefined;
}

export async function updateEntryHandler(
  args: UpdateEntryArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const existing = await client.getEntry(args.entry_id);
    const patch: EntryPatch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.categories !== undefined) patch.categories = args.categories;
    if (args.draft !== undefined) patch.draft = args.draft;
    if (args.preview !== undefined) patch.preview = args.preview;
    if (args.custom_url !== undefined) patch.customUrl = args.custom_url;
    if (args.touch_updated !== undefined) patch.touchUpdated = args.touch_updated;
    const payload = mergeEntry(existing, patch);
    const updated = await client.updateEntry(args.entry_id, payload);
    return ok(entryView(updated, false));
  } catch (err) {
    return toolError(err);
  }
}

interface DeleteEntryArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  entry_id: string;
}

export async function deleteEntryHandler(
  args: DeleteEntryArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    await client.deleteEntry(args.entry_id);
    return ok({ ok: true });
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerEntryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_entries",
    {
      description:
        "ブログエントリの一覧を取得します。1ページ7件。続きは返り値の next_page を page に渡して再取得してください。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        page: z.string().optional().describe("next_page token from a previous response"),
        include_html: z
          .boolean()
          .optional()
          .describe("Include the rendered HTML (hatena:formatted-content) in each entry"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => listEntriesHandler(args, ctx),
  );

  server.registerTool(
    "get_entry",
    {
      description: "エントリを1件取得します。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        entry_id: z.string().min(1),
        include_html: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => getEntryHandler(args, ctx),
  );

  server.registerTool(
    "create_entry",
    {
      description: "新規エントリを投稿します。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        title: z.string().min(1),
        content: z.string(),
        content_type: contentTypeSchema.optional(),
        categories: z.array(z.string()).optional(),
        draft: z.boolean().optional(),
        preview: z.boolean().optional(),
        scheduled: z.boolean().optional(),
        updated: z.string().optional().describe("ISO-8601. Required when scheduled=true."),
        custom_url: z.string().optional(),
      },
    },
    (args) => createEntryHandler(args, ctx),
  );

  server.registerTool(
    "update_entry",
    {
      description:
        "エントリを部分更新します。指定したフィールドのみ書き換え、未指定のフィールドは既存値を維持します (投稿日時・URL・本文の記法を含む)。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        entry_id: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
        categories: z
          .array(z.string())
          .optional()
          .describe("空配列 [] を渡すとカテゴリを空にします"),
        draft: z.boolean().optional(),
        preview: z.boolean().optional(),
        custom_url: z.string().optional(),
        touch_updated: z
          .boolean()
          .optional()
          .describe(
            "true を指定した場合のみ現在時刻で updated を送信します (デフォルト false = 投稿日時を保持)",
          ),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => updateEntryHandler(args, ctx),
  );

  server.registerTool(
    "delete_entry",
    {
      description: "エントリを削除します。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        entry_id: z.string().min(1),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => deleteEntryHandler(args, ctx),
  );
}

// Re-export for convenience when other modules want the same client factory.
export type { AtomPubClient };
