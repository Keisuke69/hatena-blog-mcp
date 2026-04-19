import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AtomPubError } from "../../src/atompub/errors.js";
import {
  buildEntryXml,
  buildPageXml,
  parseCategories,
  parseEntry,
  parseFeed,
  parsePage,
  parsePageFeed,
} from "../../src/atompub/xml.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../fixtures");
const readFixture = (name: string) => readFileSync(resolve(fixturesDir, name), "utf-8");

describe("parseFeed", () => {
  const xml = readFixture("entry-list.xml");
  const feed = parseFeed(xml);

  it("extracts every entry", () => {
    expect(feed.entries).toHaveLength(3);
  });

  it("extracts the epoch-only next_page token", () => {
    expect(feed.nextPage).toBe("1377584217");
  });

  it("parses ids from the edit link", () => {
    expect(feed.entries.map((e) => e.id)).toEqual([
      "3000000000000000010",
      "3000000000000000009",
      "3000000000000000008",
    ]);
  });

  it("parses titles, authors, categories", () => {
    const first = feed.entries[0];
    if (!first) throw new Error("missing entry");
    expect(first.title).toBe("MCPサーバーをCloudflare Workersで書く");
    expect(first.authorName).toBe("example_user");
    expect(first.categories).toEqual(["技術", "MCP", "Cloudflare"]);
  });

  it("detects draft entries", () => {
    const [, draft] = feed.entries;
    if (!draft) throw new Error("missing draft entry");
    expect(draft.control.draft).toBe(true);
    expect(draft.control.preview).toBe(false);
  });

  it("preserves the original content type", () => {
    expect(feed.entries.map((e) => e.contentType)).toEqual([
      "text/x-markdown",
      "text/x-hatena-syntax",
      "text/html",
    ]);
  });

  it("extracts custom_url when present", () => {
    const third = feed.entries[2];
    if (!third) throw new Error("missing entry");
    expect(third.customUrl).toBe("old-entry-url");
  });

  it("leaves customUrl undefined when not present", () => {
    const first = feed.entries[0];
    if (!first) throw new Error("missing entry");
    expect(first.customUrl).toBeUndefined();
  });

  it("extracts the formatted (rendered HTML) content", () => {
    const first = feed.entries[0];
    if (!first) throw new Error("missing entry");
    expect(first.formattedContent).toContain("<h2>はじめに</h2>");
  });
});

describe("parseFeed — empty / no next page", () => {
  it("returns nextPage=null when no <link rel='next'> is present", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>no next</title>
</feed>`;
    expect(parseFeed(xml).nextPage).toBeNull();
  });

  it("handles a feed with zero entries", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>empty</title></feed>`;
    expect(parseFeed(xml).entries).toEqual([]);
  });
});

describe("parseEntry", () => {
  const xml = readFixture("entry-single.xml");
  const entry = parseEntry(xml);

  it("parses title and id", () => {
    expect(entry.id).toBe("3000000000000000010");
    expect(entry.title).toBe("MCPサーバーをCloudflare Workersで書く");
  });

  it("decodes XML entities in body content (single-escape layer)", () => {
    // The fixture has the string `"<example>"` escaped as &quot;&lt;example&gt;&quot;
    // in the <content> element. The parser should hand back the literal string.
    expect(entry.content).toContain('"<example>"');
  });

  it("keeps the hatena:formatted-content HTML decoded once", () => {
    // formatted-content is double-encoded in the source; the parser's entity
    // processing handles the outer layer, leaving HTML tags as plain markup.
    expect(entry.formattedContent).toContain("<h2>はじめに</h2>");
  });

  it("extracts the edit URL", () => {
    expect(entry.editUrl).toContain("/atom/entry/3000000000000000010");
  });
});

describe("parseCategories", () => {
  const xml = readFixture("category-document.xml");
  const doc = parseCategories(xml);

  it("returns the list of terms in document order", () => {
    expect(doc.categories).toEqual(["技術", "MCP", "Cloudflare", "雑記", "旅行"]);
  });

  it("honours the fixed attribute (no => false)", () => {
    expect(doc.fixed).toBe(false);
  });
});

describe("buildEntryXml", () => {
  it("omits fields that weren't supplied (partial update)", () => {
    const xml = buildEntryXml({ categories: ["foo", "bar"] });
    expect(xml).not.toContain("<title>");
    expect(xml).not.toContain("<content");
    expect(xml).not.toContain("<updated>");
    expect(xml).not.toContain("<hatenablog:custom-url>");
    expect(xml).not.toContain("<app:control>");
    expect(xml).toContain('<category term="foo" />');
    expect(xml).toContain('<category term="bar" />');
  });

  it("emits the full <app:control> block when creating", () => {
    const xml = buildEntryXml(
      { title: "t", content: "c", contentType: "text/x-markdown" },
      { creating: true },
    );
    expect(xml).toContain("<app:draft>no</app:draft>");
    expect(xml).toContain("<app:preview>no</app:preview>");
    expect(xml).toContain("<hatenablog:scheduled>no</hatenablog:scheduled>");
  });

  it("writes only the control fields the caller supplied (update mode)", () => {
    const xml = buildEntryXml({ control: { draft: true } });
    expect(xml).toContain("<app:draft>yes</app:draft>");
    expect(xml).not.toContain("<app:preview>");
    expect(xml).not.toContain("<hatenablog:scheduled>");
  });

  it("includes the content type when supplied", () => {
    const xml = buildEntryXml({ content: "hello", contentType: "text/x-markdown" });
    expect(xml).toContain('<content type="text/x-markdown">hello</content>');
  });

  it("omits the type attribute when contentType is undefined (let the blog pick its default)", () => {
    const xml = buildEntryXml({ content: "hello" });
    expect(xml).toContain("<content>hello</content>");
    expect(xml).not.toContain('type="');
  });

  it('escapes &, <, > in text content and " in attributes', () => {
    const xml = buildEntryXml({
      title: "a & b <c>",
      content: "1 < 2",
      contentType: "text/html",
      categories: ['weird"term'],
    });
    expect(xml).toContain("<title>a &amp; b &lt;c&gt;</title>");
    expect(xml).toContain("1 &lt; 2");
    expect(xml).toContain('<category term="weird&quot;term" />');
  });

  it("round-trips through parseEntry for the fields we supplied", () => {
    const xml = buildEntryXml(
      {
        title: "新しい記事",
        authorName: "example_user",
        content: "# 見出し\n\n本文",
        contentType: "text/x-markdown",
        categories: ["技術", "テスト"],
        control: { draft: true, preview: false, scheduled: false },
        updated: "2026-04-18T12:00:00+09:00",
        customUrl: "my-slug",
      },
      { creating: true },
    );
    // parseEntry requires an edit link to derive an id. Inject one so we can
    // round-trip purely at the XML layer.
    const withLink = xml.replace(
      "<entry ",
      '<entry xmlns:stub="x"><link rel="edit" href="https://example/atom/entry/99" />',
    );
    const parsed = parseEntry(withLink);
    expect(parsed.title).toBe("新しい記事");
    expect(parsed.content).toBe("# 見出し\n\n本文");
    expect(parsed.contentType).toBe("text/x-markdown");
    expect(parsed.categories).toEqual(["技術", "テスト"]);
    expect(parsed.control.draft).toBe(true);
    expect(parsed.updated).toBe("2026-04-18T12:00:00+09:00");
    expect(parsed.customUrl).toBe("my-slug");
  });

  it("never emits <updated> when the caller doesn't provide it (preserves publish date)", () => {
    const xml = buildEntryXml({
      title: "keep date",
      content: "body",
      contentType: "text/x-markdown",
      categories: ["技術"],
    });
    expect(xml).not.toContain("<updated>");
  });

  it("never emits <hatenablog:custom-url> when the caller doesn't provide it (preserves slug)", () => {
    const xml = buildEntryXml({ categories: ["技術"] });
    expect(xml).not.toContain("custom-url");
  });
});

describe("parsePage", () => {
  const page = parsePage(readFixture("page-single.xml"));

  it("extracts page id, title, customUrl", () => {
    expect(page.id).toBe("8000000000000000001");
    expect(page.title).toBe("About");
    expect(page.customUrl).toBe("about");
  });

  it("does not carry a scheduled field in control", () => {
    expect(page.control).toEqual({ draft: false, preview: false });
    expect("scheduled" in page.control).toBe(false);
  });
});

describe("parsePageFeed", () => {
  const feed = parsePageFeed(readFixture("page-list.xml"));

  it("returns all pages", () => {
    expect(feed.pages).toHaveLength(2);
    expect(feed.pages.map((p) => p.title)).toEqual(["About", "Contact"]);
  });

  it("returns nextPage=null when the fixture has no next link", () => {
    expect(feed.nextPage).toBeNull();
  });

  it("detects draft pages", () => {
    const [, contact] = feed.pages;
    if (!contact) throw new Error("missing page");
    expect(contact.control.draft).toBe(true);
  });
});

describe("parse error handling", () => {
  it("throws AtomPubError with parse_error code on invalid XML", () => {
    expect(() => parseEntry("not xml <<<")).toThrow(AtomPubError);
  });

  it("throws when the root is not an entry", () => {
    expect(() => parseEntry('<?xml version="1.0"?><feed/>')).toThrow(/<entry>/);
  });

  it("throws when no edit link is present", () => {
    const xml = `<?xml version="1.0"?><entry xmlns="http://www.w3.org/2005/Atom"><title>x</title></entry>`;
    expect(() => parseEntry(xml)).toThrow(/edit link/);
  });

  it("parsePage reports page context in its error", () => {
    expect(() => parsePage('<?xml version="1.0"?><feed/>')).toThrow(/page/);
  });

  it("parseCategories with fixed=yes returns fixed:true", () => {
    const xml = `<?xml version="1.0"?>
<app:categories xmlns:app="http://www.w3.org/2007/app" fixed="yes">
  <category term="a"/>
</app:categories>`;
    expect(parseCategories(xml).fixed).toBe(true);
  });

  it("parses an entry with no <app:control> block (defaults to all-false)", () => {
    const xml = `<?xml version="1.0"?>
<entry xmlns="http://www.w3.org/2005/Atom">
  <link rel="edit" href="https://example/atom/entry/42"/>
  <title>no control</title>
  <updated>2026-01-01T00:00:00+09:00</updated>
</entry>`;
    const entry = parseEntry(xml);
    expect(entry.control).toEqual({ draft: false, preview: false, scheduled: false });
  });

  it("parses <content> without a type attribute as a plain string body", () => {
    const xml = `<?xml version="1.0"?>
<entry xmlns="http://www.w3.org/2005/Atom">
  <link rel="edit" href="https://example/atom/entry/42"/>
  <title>untyped content</title>
  <updated>2026-01-01T00:00:00+09:00</updated>
  <content>plain body</content>
</entry>`;
    const entry = parseEntry(xml);
    expect(entry.content).toBe("plain body");
    expect(entry.contentType).toBeUndefined();
  });

  it("parseFeed treats a next link without a page query as nextPage=null", () => {
    const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link rel="next" href="https://example/atom/entry"/>
</feed>`;
    expect(parseFeed(xml).nextPage).toBeNull();
  });
});

describe("buildPageXml", () => {
  it("drops categories and scheduled even if someone sneaks them in via the type system", () => {
    const xml = buildPageXml(
      {
        title: "ページ",
        content: "本文",
        contentType: "text/x-markdown",
        customUrl: "about",
        control: { draft: false, preview: false },
      },
      { creating: true },
    );
    expect(xml).not.toContain("<category ");
    expect(xml).not.toContain("<hatenablog:scheduled>");
    expect(xml).toContain("<hatenablog:custom-url>about</hatenablog:custom-url>");
  });
});
