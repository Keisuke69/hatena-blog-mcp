import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeClient, type ToolContext } from "../context.js";
import { ok, type ToolTextResult, toolError } from "../response.js";

interface ListCategoriesArgs {
  blog_id: string;
  hatena_id?: string | undefined;
}

export async function listCategoriesHandler(
  args: ListCategoriesArgs,
  ctx: ToolContext,
): Promise<ToolTextResult> {
  try {
    const client = makeClient(ctx, args.blog_id, args.hatena_id);
    const doc = await client.listCategories();
    return ok({ categories: doc.categories, fixed: doc.fixed });
  } catch (err) {
    return toolError(err);
  }
}

export function registerCategoryTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_categories",
    {
      description:
        "ブログのカテゴリ一覧を取得します。fixed=true の場合は新規カテゴリの追加が禁止されています。",
      inputSchema: {
        blog_id: z.string().min(1).describe("Blog ID, e.g. example.hatenablog.com"),
        hatena_id: z
          .string()
          .min(1)
          .optional()
          .describe("Override the Hatena ID derived from the Authorization header"),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => listCategoriesHandler(args, ctx),
  );
}
