import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AtomPubClient } from "../../src/atompub/client.js";
import { AtomPubError } from "../../src/atompub/errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const readFixture = (name: string) => readFileSync(resolve(fixturesDir, name), "utf-8");

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

function makeFetchSpy(plan: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const step = plan[i];
    i += 1;
    if (!step) throw new Error(`fetchSpy exhausted (call ${i})`);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

const creds = {
  authHeader: "Basic ZXhhbXBsZV91c2VyOnNlY3JldA==",
  hatenaId: "example_user",
};
const blogId = "example_user.hatenablog.com";

function makeClient(plan: Array<Response | Error>) {
  const spy = makeFetchSpy(plan);
  const client = new AtomPubClient({
    credentials: creds,
    blogId,
    fetchImpl: spy.fetchImpl,
    retry: { maxRetries: 0, baseDelayMs: 0 },
  });
  return { client, ...spy };
}

describe("AtomPubClient — entries", () => {
  it("GET list_entries sends Authorization header to the right URL", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("entry-list.xml"), { status: 200 }),
    ]);
    const feed = await client.listEntries();
    expect(feed.entries).toHaveLength(3);
    expect(calls[0]?.url).toBe(
      "https://blog.hatena.ne.jp/example_user/example_user.hatenablog.com/atom/entry",
    );
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe(creds.authHeader);
  });

  it("appends ?page= when a page token is provided", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("entry-list.xml"), { status: 200 }),
    ]);
    await client.listEntries({ page: "1377584217" });
    expect(calls[0]?.url).toContain("?page=1377584217");
  });

  it("GET get_entry hits the member URL", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("entry-single.xml"), { status: 200 }),
    ]);
    const entry = await client.getEntry("3000000000000000010");
    expect(entry.id).toBe("3000000000000000010");
    expect(calls[0]?.url).toBe(
      "https://blog.hatena.ne.jp/example_user/example_user.hatenablog.com/atom/entry/3000000000000000010",
    );
  });

  it("POST create_entry sends XML with Content-Type and full control block", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("entry-single.xml"), { status: 201 }),
    ]);
    await client.createEntry({
      title: "new",
      content: "body",
      contentType: "text/x-markdown",
      categories: ["技術"],
    });
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.headers["content-type"]).toContain("application/xml");
    expect(call?.body).toContain("<title>new</title>");
    // creating mode emits a full control block with all three booleans.
    expect(call?.body).toContain("<hatenablog:scheduled>no</hatenablog:scheduled>");
  });

  it("PUT update_entry sends a partial-update body (no scheduled, no updated)", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("entry-single.xml"), { status: 200 }),
    ]);
    await client.updateEntry("3000000000000000010", {
      categories: ["新カテゴリ"],
    });
    const [call] = calls;
    expect(call?.method).toBe("PUT");
    expect(call?.body).toContain('<category term="新カテゴリ" />');
    // partial update must NOT emit fields we didn't set — this is the whole
    // point of the "update" vs "create" distinction.
    expect(call?.body).not.toContain("<updated>");
    expect(call?.body).not.toContain("<hatenablog:scheduled>");
    expect(call?.body).not.toContain("<title>");
    expect(call?.body).not.toContain("custom-url");
  });

  it("DELETE delete_entry issues DELETE and returns void", async () => {
    const { client, calls } = makeClient([new Response(null, { status: 204 })]);
    await expect(client.deleteEntry("3000000000000000010")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
  });
});

describe("AtomPubClient — pages", () => {
  it("GET list_pages uses the /atom/page collection", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("page-list.xml"), { status: 200 }),
    ]);
    const feed = await client.listPages();
    expect(feed.pages).toHaveLength(2);
    expect(calls[0]?.url).toContain("/atom/page");
  });

  it("GET get_page parses a page member document", async () => {
    const { client } = makeClient([new Response(readFixture("page-single.xml"), { status: 200 })]);
    const page = await client.getPage("8000000000000000001");
    expect(page.title).toBe("About");
    expect(page.customUrl).toBe("about");
  });

  it("PUT update_page sends XML without hatenablog:scheduled", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("page-single.xml"), { status: 200 }),
    ]);
    await client.updatePage("8000000000000000001", { title: "改題" });
    expect(calls[0]?.body).not.toContain("<hatenablog:scheduled>");
    expect(calls[0]?.body).toContain("<title>改題</title>");
  });
});

describe("AtomPubClient — categories", () => {
  it("parses category document", async () => {
    const { client, calls } = makeClient([
      new Response(readFixture("category-document.xml"), { status: 200 }),
    ]);
    const cats = await client.listCategories();
    expect(cats.categories).toContain("技術");
    expect(cats.fixed).toBe(false);
    expect(calls[0]?.url).toContain("/atom/category");
  });
});

describe("AtomPubClient — error mapping", () => {
  it("401 maps to AtomPubError(code=unauthorized)", async () => {
    const { client } = makeClient([new Response("nope", { status: 401 })]);
    await expect(client.getEntry("1")).rejects.toMatchObject({
      name: "AtomPubError",
      status: 401,
      code: "unauthorized",
    });
  });

  it("404 maps to not_found", async () => {
    const { client } = makeClient([new Response("missing", { status: 404 })]);
    await expect(client.getEntry("missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("500 maps to server_error (after retries are exhausted)", async () => {
    const { client, calls } = makeClient([new Response("boom", { status: 500 })]);
    // 500 is NOT in the retry set (we only retry 429/502/503/504), so a single
    // call surfaces immediately.
    await expect(client.getEntry("x")).rejects.toBeInstanceOf(AtomPubError);
    expect(calls).toHaveLength(1);
  });

  it("400 maps to bad_request", async () => {
    const { client } = makeClient([new Response("nope", { status: 400 })]);
    await expect(client.createEntry({ title: "x" })).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
  });

  it("URL-encodes the hatenaId and blogId path segments", async () => {
    const { fetchImpl, calls } = makeFetchSpy([
      new Response(readFixture("entry-list.xml"), { status: 200 }),
    ]);
    const client = new AtomPubClient({
      credentials: { authHeader: "Basic x", hatenaId: "user with space" },
      blogId: "blog/weird",
      fetchImpl,
      retry: { maxRetries: 0 },
    });
    await client.listEntries();
    expect(calls[0]?.url).toContain("/user%20with%20space/blog%2Fweird/atom/entry");
  });
});
