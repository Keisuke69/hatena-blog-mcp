import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Page } from "../../src/atompub/types.js";
import type { ToolContext } from "../../src/mcp/context.js";
import {
  createPageHandler,
  deletePageHandler,
  getPageHandler,
  listPagesHandler,
  mergePage,
  pageView,
  updatePageHandler,
} from "../../src/mcp/tools/pages.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const readFixture = (name: string) => readFileSync(resolve(fixturesDir, name), "utf-8");

const creds = { authHeader: "Basic x", hatenaId: "example_user" };

type RecordedCall = { url: string; method: string; body?: string };

function makeCtx(plan: Array<Response | Error>): { ctx: ToolContext; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(body !== undefined ? { body } : {}),
    });
    const step = plan[i];
    i += 1;
    if (!step) throw new Error("fetchSpy exhausted");
    if (step instanceof Error) throw step;
    return step;
  };
  return {
    ctx: { credentials: creds, fetchImpl, retry: { maxRetries: 0, baseDelayMs: 0 } },
    calls,
  };
}

const basePage: Page = {
  id: "8000000000000000001",
  atomId: "tag:...",
  title: "About",
  authorName: "example_user",
  content: "# About",
  contentType: "text/x-markdown",
  control: { draft: false, preview: false },
  updated: "2026-02-01T09:00:00+09:00",
  published: "2026-02-01T09:00:00+09:00",
  edited: "2026-02-01T09:00:00+09:00",
  url: "https://example_user.hatenablog.com/about",
  customUrl: "about",
};

describe("mergePage", () => {
  it("titleのみの更新で他は既存値を保持する (DoD)", () => {
    const payload = mergePage(basePage, { title: "改題" });
    expect(payload.title).toBe("改題");
    expect(payload.content).toBe("# About");
    expect(payload.contentType).toBe("text/x-markdown");
    expect(payload.control).toEqual({ draft: false, preview: false });
    expect(payload.updated).toBeUndefined();
    // customUrl は patch に無い限り送らない → 既存slugを保つ
    expect(payload.customUrl).toBeUndefined();
  });

  it("touch_updated=true のときだけ updated を送る", () => {
    const before = Date.now();
    const payload = mergePage(basePage, { touchUpdated: true });
    const after = Date.now();
    const ts = Date.parse(payload.updated as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("custom_url を明示したときのみ customUrl を送る", () => {
    const payload = mergePage(basePage, { customUrl: "new-slug" });
    expect(payload.customUrl).toBe("new-slug");
  });

  it("content_type は常に既存値を使う", () => {
    const page: Page = { ...basePage, contentType: "text/x-hatena-syntax" };
    const payload = mergePage(page, { content: "body" });
    expect(payload.contentType).toBe("text/x-hatena-syntax");
  });
});

describe("pageView", () => {
  it("include_html=true で formatted_content を含める", () => {
    const page: Page = { ...basePage, formattedContent: "<h1>About</h1>" };
    expect(pageView(page, true).formatted_content).toBe("<h1>About</h1>");
    expect(pageView(page, false).formatted_content).toBeUndefined();
  });
});

describe("listPagesHandler", () => {
  it("/atom/page を取得する", async () => {
    const { ctx, calls } = makeCtx([new Response(readFixture("page-list.xml"), { status: 200 })]);
    const res = await listPagesHandler({ blog_id: "example_user.hatenablog.com" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.url).toContain("/atom/page");
  });
});

describe("getPageHandler", () => {
  it("ページを1件取得する", async () => {
    const { ctx } = makeCtx([new Response(readFixture("page-single.xml"), { status: 200 })]);
    const res = await getPageHandler(
      { blog_id: "example_user.hatenablog.com", page_id: "8000000000000000001" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.custom_url).toBe("about");
  });
});

describe("createPageHandler", () => {
  it("POSTで新規ページを作成する (custom_url 必須)", async () => {
    const { ctx, calls } = makeCtx([new Response(readFixture("page-single.xml"), { status: 201 })]);
    const res = await createPageHandler(
      {
        blog_id: "example_user.hatenablog.com",
        title: "新ページ",
        content: "body",
        custom_url: "new-page",
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain("<hatenablog:custom-url>new-page</hatenablog:custom-url>");
    // ページには scheduled は無い
    expect(calls[0]?.body).not.toContain("<hatenablog:scheduled>");
  });
});

describe("updatePageHandler", () => {
  it("GET→PUT で部分更新する (DoD)", async () => {
    const { ctx, calls } = makeCtx([
      new Response(readFixture("page-single.xml"), { status: 200 }),
      new Response(readFixture("page-single.xml"), { status: 200 }),
    ]);
    const res = await updatePageHandler(
      {
        blog_id: "example_user.hatenablog.com",
        page_id: "8000000000000000001",
        title: "改題",
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PUT");
    const body = calls[1]?.body ?? "";
    expect(body).toContain("<title>改題</title>");
    expect(body).not.toContain("<updated>");
    expect(body).not.toContain("custom-url");
    expect(body).not.toContain("<hatenablog:scheduled>");
  });
});

describe("deletePageHandler", () => {
  it("DELETE を送信する", async () => {
    const { ctx, calls } = makeCtx([new Response(null, { status: 204 })]);
    const res = await deletePageHandler(
      { blog_id: "example_user.hatenablog.com", page_id: "8000000000000000001" },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });
});
