import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/mcp/context.js";
import { listCategoriesHandler } from "../../src/mcp/tools/categories.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const readFixture = (name: string) => readFileSync(resolve(fixturesDir, name), "utf-8");

const creds = { authHeader: "Basic x", hatenaId: "example_user" };

function makeCtx(plan: Array<Response | Error>): { ctx: ToolContext; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const step = plan[i];
    i += 1;
    if (!step) throw new Error("fetchSpy exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return {
    ctx: { credentials: creds, fetchImpl, retry: { maxRetries: 0, baseDelayMs: 0 } },
    urls,
  };
}

describe("listCategoriesHandler", () => {
  it("/atom/category を取得し categories と fixed を返す", async () => {
    const { ctx, urls } = makeCtx([
      new Response(readFixture("category-document.xml"), { status: 200 }),
    ]);
    const res = await listCategoriesHandler({ blog_id: "example_user.hatenablog.com" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.categories).toEqual(expect.arrayContaining(["技術"]));
    expect(res.structuredContent?.fixed).toBe(false);
    expect(urls[0]).toContain("/atom/category");
  });

  it("401はisError:trueで日本語メッセージ", async () => {
    const { ctx } = makeCtx([new Response("nope", { status: 401 })]);
    const res = await listCategoriesHandler({ blog_id: "example_user.hatenablog.com" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("認証");
  });

  it("hatena_id override が URL パスに反映される", async () => {
    const { ctx, urls } = makeCtx([
      new Response(readFixture("category-document.xml"), { status: 200 }),
    ]);
    await listCategoriesHandler(
      { blog_id: "group.hatenablog.com", hatena_id: "another_user" },
      ctx,
    );
    expect(urls[0]).toContain("/another_user/group.hatenablog.com/atom/category");
  });
});
