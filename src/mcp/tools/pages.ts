import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContentType, Page, PageWritePayload } from "../../atompub/types.js";
import { makeClient, type ToolContext } from "../context.js";
import { ok, type ToolTextResult, toolError } from "../response.js";

// ---------------------------------------------------------------------------
// Page view
// ---------------------------------------------------------------------------

export function pageView(page: Page, includeHtml: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: page.id,
    title: page.title,
    author: page.authorName,
    content: page.content,
    content_type: page.contentType,
    draft: page.control.draft,
    preview: page.control.preview,
    updated: page.updated,
  };
  if (page.published !== undefined) view.published = page.published;
  if (page.edited !== undefined) view.edited = page.edited;
  if (page.url !== undefined) view.url = page.url;
  if (page.customUrl !== undefined) view.custom_url = page.customUrl;
  if (includeHtml && page.formattedContent !== undefined) {
    view.formatted_content = page.formattedContent;
  }
  return view;
}

// ---------------------------------------------------------------------------
// mergePage — same shape as mergeEntry but without categories/scheduled
// ---------------------------------------------------------------------------

export interface PagePatch {
  title?: string;
  content?: string;
  draft?: boolean;
  preview?: boolean;
  customUrl?: string;
  touchUpdated?: boolean;
}

export function mergePage(existing: Page, patch: PagePatch): PageWritePayload {
  const payload: PageWritePayload = {
    title: patch.title ?? existing.title,
    content: patch.content ?? existing.content,
    control: {
      draft: patch.draft ?? existing.control.draft,
      preview: patch.preview ?? existing.control.preview,
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
// Zod shapes
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
// Handlers
// ---------------------------------------------------------------------------

interface ListPagesArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  page?: string | undefined;
  include_html?: boolean | undefined;
}

export async function listPagesHandler(
  args: ListPagesArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const listOpts: { page?: string } = {};
    if (args.page !== undefined) listOpts.page = args.page;
    const feed = await client.listPages(listOpts);
    return ok({
      pages: feed.pages.map((p) => pageView(p, args.include_html ?? false)),
      next_page: feed.nextPage,
    });
  } catch (err) {
    return toolError(err);
  }
}

interface GetPageArgs {
  blog_id: string;
  page_id: string;
  hatena_id?: string | undefined;
  include_html?: boolean | undefined;
}

export async function getPageHandler(args: GetPageArgs, ctx: ToolContext): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const page = await client.getPage(args.page_id);
    return ok(pageView(page, args.include_html ?? false));
  } catch (err) {
    return toolError(err);
  }
}

interface CreatePageArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  title: string;
  content: string;
  content_type?: ContentType | undefined;
  draft?: boolean | undefined;
  preview?: boolean | undefined;
  custom_url: string;
}

export async function createPageHandler(
  args: CreatePageArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const payload: PageWritePayload = {
      title: args.title,
      content: args.content,
      customUrl: args.custom_url,
      control: {
        draft: args.draft ?? false,
        preview: args.preview ?? false,
      },
    };
    if (args.content_type !== undefined) payload.contentType = args.content_type;
    const page = await client.createPage(payload);
    return ok(pageView(page, false));
  } catch (err) {
    return toolError(err);
  }
}

interface UpdatePageArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  page_id: string;
  title?: string | undefined;
  content?: string | undefined;
  draft?: boolean | undefined;
  preview?: boolean | undefined;
  custom_url?: string | undefined;
  touch_updated?: boolean | undefined;
}

export async function updatePageHandler(
  args: UpdatePageArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const existing = await client.getPage(args.page_id);
    const patch: PagePatch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.draft !== undefined) patch.draft = args.draft;
    if (args.preview !== undefined) patch.preview = args.preview;
    if (args.custom_url !== undefined) patch.customUrl = args.custom_url;
    if (args.touch_updated !== undefined) patch.touchUpdated = args.touch_updated;
    const payload = mergePage(existing, patch);
    const updated = await client.updatePage(args.page_id, payload);
    return ok(pageView(updated, false));
  } catch (err) {
    return toolError(err);
  }
}

interface DeletePageArgs {
  blog_id: string;
  hatena_id?: string | undefined;
  page_id: string;
}

export async function deletePageHandler(
  args: DeletePageArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    await client.deletePage(args.page_id);
    return ok({ ok: true });
  } catch (err) {
    return toolError(err);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPageTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_pages",
    {
      description:
        "固定ページの一覧を取得します。続きは返り値の next_page を page に渡して再取得してください。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        page: z.string().optional().describe("next_page token from a previous response"),
        include_html: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => listPagesHandler(args, ctx),
  );

  server.registerTool(
    "get_page",
    {
      description: "固定ページを1件取得します。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        page_id: z.string().min(1),
        include_html: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => getPageHandler(args, ctx),
  );

  server.registerTool(
    "create_page",
    {
      description: "新規の固定ページを作成します。custom_url はページのスラッグで必須です。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        title: z.string().min(1),
        content: z.string(),
        content_type: contentTypeSchema.optional(),
        draft: z.boolean().optional(),
        preview: z.boolean().optional(),
        custom_url: z.string().min(1).describe("ページのスラッグ (例: about)"),
      },
    },
    (args) => createPageHandler(args, ctx),
  );

  server.registerTool(
    "update_page",
    {
      description:
        "固定ページを部分更新します。指定したフィールドのみ書き換え、未指定のフィールドは既存値を維持します (投稿日時・URL・本文の記法を含む)。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        page_id: z.string().min(1),
        title: z.string().optional(),
        content: z.string().optional(),
        draft: z.boolean().optional(),
        preview: z.boolean().optional(),
        custom_url: z.string().optional(),
        touch_updated: z
          .boolean()
          .optional()
          .describe("true を指定した場合のみ現在時刻で updated を送信します (デフォルト false)"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => updatePageHandler(args, ctx),
  );

  server.registerTool(
    "delete_page",
    {
      description: "固定ページを削除します。",
      inputSchema: {
        blog_id: blogId,
        hatena_id: hatenaIdOverride,
        page_id: z.string().min(1),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    (args) => deletePageHandler(args, ctx),
  );
}
