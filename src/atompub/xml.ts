import { XMLParser } from "fast-xml-parser";
import { AtomPubError } from "./errors.js";
import type {
  CategoryDocument,
  ContentType,
  Entry,
  EntryList,
  EntryWritePayload,
  Page,
  PageList,
  PageWritePayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ARRAY_TAGS = new Set(["entry", "category", "link"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  textNodeName: "#text",
  isArray: (name) => ARRAY_TAGS.has(name),
});

type XmlNode = Record<string, unknown>;

function parse(xml: string): XmlNode {
  try {
    return parser.parse(xml) as XmlNode;
  } catch (cause) {
    throw new AtomPubError("Failed to parse AtomPub XML", {
      status: 0,
      code: "parse_error",
      body: xml.slice(0, 500),
      cause,
    });
  }
}

function asObject(value: unknown): XmlNode {
  if (value === null || value === undefined || typeof value !== "object") {
    return {};
  }
  return value as XmlNode;
}

function asString(value: unknown): string | undefined {
  // The parser is configured with parseTagValue/parseAttributeValue:false, so
  // every value we see is either a string, a nested object, or undefined.
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const text = (value as XmlNode)["#text"];
    if (typeof text === "string") return text;
  }
  return undefined;
}

function asBool(value: unknown): boolean {
  return asString(value)?.toLowerCase() === "yes";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function extractLinks(entry: XmlNode): {
  editUrl: string | undefined;
  publicUrl: string | undefined;
} {
  const links = asArray(entry["link"] as XmlNode | XmlNode[] | undefined);
  let editUrl: string | undefined;
  let publicUrl: string | undefined;
  for (const link of links) {
    const rel = link["@_rel"];
    const href = link["@_href"];
    const type = link["@_type"];
    if (typeof href !== "string") continue;
    if (rel === "edit") editUrl = href;
    if (rel === "alternate" && type === "text/html") publicUrl = href;
  }
  return { editUrl, publicUrl };
}

function extractIdFromEditUrl(editUrl: string | undefined): string | undefined {
  if (!editUrl) return undefined;
  const match = /\/atom\/(?:entry|page)\/([^/?#]+)/.exec(editUrl);
  return match?.[1];
}

function extractControl(entry: XmlNode): {
  draft: boolean;
  preview: boolean;
  scheduled: boolean;
} {
  const control = asObject(entry["app:control"]);
  return {
    draft: asBool(control["app:draft"]),
    preview: asBool(control["app:preview"]),
    scheduled: asBool(control["hatenablog:scheduled"]),
  };
}

function extractCategories(entry: XmlNode): string[] {
  const cats = asArray(entry["category"] as XmlNode | XmlNode[] | undefined);
  const terms: string[] = [];
  for (const c of cats) {
    const term = c["@_term"];
    if (typeof term === "string") terms.push(term);
  }
  return terms;
}

function extractContentBody(entry: XmlNode): {
  content: string;
  contentType: ContentType | undefined;
} {
  const node = entry["content"];
  if (typeof node === "string") {
    return { content: node, contentType: undefined };
  }
  const obj = asObject(node);
  const text = asString(obj) ?? "";
  const type = obj["@_type"];
  return {
    content: text,
    contentType: typeof type === "string" ? (type as ContentType) : undefined,
  };
}

function extractFormattedContent(entry: XmlNode): string | undefined {
  const node = entry["hatena:formatted-content"];
  if (node === undefined) return undefined;
  if (typeof node === "string") return node;
  return asString(node);
}

function toEntry(entryNode: XmlNode): Entry {
  const { editUrl, publicUrl } = extractLinks(entryNode);
  const id = extractIdFromEditUrl(editUrl);
  if (!id) {
    throw new AtomPubError("Entry is missing edit link — cannot determine id", {
      status: 0,
      code: "parse_error",
    });
  }
  const { content, contentType } = extractContentBody(entryNode);
  const formatted = extractFormattedContent(entryNode);

  const authorName = asString(asObject(entryNode["author"])["name"]) ?? "";
  const customUrl = asString(entryNode["hatenablog:custom-url"]);
  const edited = asString(entryNode["app:edited"]);

  return {
    id,
    atomId: asString(entryNode["id"]) ?? "",
    title: asString(entryNode["title"]) ?? "",
    authorName,
    content,
    contentType,
    ...(formatted !== undefined ? { formattedContent: formatted } : {}),
    categories: extractCategories(entryNode),
    control: extractControl(entryNode),
    updated: asString(entryNode["updated"]) ?? "",
    ...(asString(entryNode["published"]) !== undefined
      ? { published: asString(entryNode["published"]) as string }
      : {}),
    ...(edited !== undefined ? { edited } : {}),
    ...(publicUrl !== undefined ? { url: publicUrl } : {}),
    ...(editUrl !== undefined ? { editUrl } : {}),
    ...(customUrl !== undefined ? { customUrl } : {}),
  };
}

function toPage(pageNode: XmlNode): Page {
  // Pages share most of the entry shape; they just drop categories + scheduled.
  const entry = toEntry(pageNode);
  const { scheduled: _unused, ...control } = entry.control;
  const page: Page = {
    id: entry.id,
    atomId: entry.atomId,
    title: entry.title,
    authorName: entry.authorName,
    content: entry.content,
    contentType: entry.contentType,
    control,
    updated: entry.updated,
  };
  if (entry.formattedContent !== undefined) page.formattedContent = entry.formattedContent;
  if (entry.published !== undefined) page.published = entry.published;
  if (entry.edited !== undefined) page.edited = entry.edited;
  if (entry.url !== undefined) page.url = entry.url;
  if (entry.editUrl !== undefined) page.editUrl = entry.editUrl;
  if (entry.customUrl !== undefined) page.customUrl = entry.customUrl;
  return page;
}

function extractNextPageToken(feed: XmlNode): string | null {
  const links = asArray(feed["link"] as XmlNode | XmlNode[] | undefined);
  for (const link of links) {
    if (link["@_rel"] !== "next") continue;
    const href = link["@_href"];
    if (typeof href !== "string") continue;
    const match = /[?&]page=([^&]+)/.exec(href);
    if (match?.[1]) return decodeURIComponent(match[1]);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public parse API
// ---------------------------------------------------------------------------

function unwrapRootEntry(doc: XmlNode, kind: "entry" | "page"): XmlNode {
  // `isArray` forces <entry> into an array even at the document root, so
  // unwrap the first element for member documents.
  const raw = doc["entry"];
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry || typeof entry !== "object") {
    throw new AtomPubError(`Expected <entry> root element for ${kind}`, {
      status: 0,
      code: "parse_error",
    });
  }
  return entry as XmlNode;
}

export function parseEntry(xml: string): Entry {
  return toEntry(unwrapRootEntry(parse(xml), "entry"));
}

export function parsePage(xml: string): Page {
  return toPage(unwrapRootEntry(parse(xml), "page"));
}

export function parseFeed(xml: string): EntryList {
  const doc = parse(xml);
  const feed = asObject(doc["feed"]);
  const entries = asArray(feed["entry"] as XmlNode | XmlNode[] | undefined).map(toEntry);
  return { entries, nextPage: extractNextPageToken(feed) };
}

export function parsePageFeed(xml: string): PageList {
  const doc = parse(xml);
  const feed = asObject(doc["feed"]);
  const pages = asArray(feed["entry"] as XmlNode | XmlNode[] | undefined).map(toPage);
  return { pages, nextPage: extractNextPageToken(feed) };
}

export function parseCategories(xml: string): CategoryDocument {
  const doc = parse(xml);
  const cats = asObject(doc["app:categories"]);
  const items = asArray(cats["category"] as XmlNode | XmlNode[] | undefined);
  const categories: string[] = [];
  for (const c of items) {
    const term = c["@_term"];
    if (typeof term === "string") categories.push(term);
  }
  const fixedAttr = asString(cats["@_fixed"]);
  return { categories, fixed: fixedAttr === "yes" };
}

// ---------------------------------------------------------------------------
// XML builders
// ---------------------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

// RFC 5023 §4.1: atom/app text content uses XML 1.0 escaping. & < > must be
// escaped everywhere; " and ' must be escaped inside attribute values.
function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;");
}

export interface BuildEntryOptions {
  /**
   * When true, a new entry is being created — sends every writable field,
   * defaulting booleans to "no" when omitted.
   *
   * When false (default), a partial update is being built — fields the
   * caller didn't provide are omitted entirely so the server keeps the
   * existing value. (Only meaningful in combination with a pre-merged
   * payload — the tool layer handles GET-then-merge.)
   */
  creating?: boolean;
  /** Internal: pages never carry <hatenablog:scheduled>. */
  includeScheduled?: boolean;
}

/**
 * Build the XML body for POST (create) or PUT (update) of an entry.
 *
 * Update-mode semantics worth noting:
 *   - Omitting `updated` preserves the original publish date.
 *   - Omitting `customUrl` preserves the existing slug.
 *   - `contentType` must be passed through unchanged from the GET response,
 *     or the blog's syntax mode will flip.
 */
export function buildEntryXml(payload: EntryWritePayload, opts: BuildEntryOptions = {}): string {
  const parts: string[] = [];
  parts.push(XML_DECL);
  parts.push(
    '<entry xmlns="http://www.w3.org/2005/Atom"' +
      ' xmlns:app="http://www.w3.org/2007/app"' +
      ' xmlns:hatenablog="http://www.hatena.ne.jp/info/xmlns#hatenablog">',
  );

  if (payload.title !== undefined) {
    parts.push(`  <title>${escapeXmlText(payload.title)}</title>`);
  }
  if (payload.authorName !== undefined) {
    parts.push(`  <author><name>${escapeXmlText(payload.authorName)}</name></author>`);
  }
  if (payload.content !== undefined) {
    const typeAttr = payload.contentType ? ` type="${escapeAttr(payload.contentType)}"` : "";
    parts.push(`  <content${typeAttr}>${escapeXmlText(payload.content)}</content>`);
  }
  if (payload.updated !== undefined) {
    parts.push(`  <updated>${escapeXmlText(payload.updated)}</updated>`);
  }
  if (payload.categories !== undefined) {
    for (const term of payload.categories) {
      parts.push(`  <category term="${escapeAttr(term)}" />`);
    }
  }

  const control = payload.control;
  const creating = opts.creating === true;
  const includeScheduled = opts.includeScheduled !== false;
  if (control !== undefined || creating) {
    const draft = control?.draft;
    const preview = control?.preview;
    const scheduled = control?.scheduled;
    const controlLines: string[] = [];
    if (draft !== undefined || creating) {
      controlLines.push(`    <app:draft>${draft ? "yes" : "no"}</app:draft>`);
    }
    if (preview !== undefined || creating) {
      controlLines.push(`    <app:preview>${preview ? "yes" : "no"}</app:preview>`);
    }
    if (includeScheduled && (scheduled !== undefined || creating)) {
      controlLines.push(
        `    <hatenablog:scheduled>${scheduled ? "yes" : "no"}</hatenablog:scheduled>`,
      );
    }
    if (controlLines.length > 0) {
      parts.push("  <app:control>");
      parts.push(...controlLines);
      parts.push("  </app:control>");
    }
  }

  if (payload.customUrl !== undefined) {
    parts.push(
      `  <hatenablog:custom-url>${escapeXmlText(payload.customUrl)}</hatenablog:custom-url>`,
    );
  }

  parts.push("</entry>");
  return parts.join("\n");
}

export interface BuildPageOptions {
  creating?: boolean;
}

export function buildPageXml(payload: PageWritePayload, opts: BuildPageOptions = {}): string {
  // Pages use the same `<entry>` element in AtomPub; they just don't carry
  // categories or scheduling. We reuse buildEntryXml by projecting the page
  // payload into the entry shape.
  const entryPayload: EntryWritePayload = {};
  if (payload.title !== undefined) entryPayload.title = payload.title;
  if (payload.authorName !== undefined) entryPayload.authorName = payload.authorName;
  if (payload.content !== undefined) entryPayload.content = payload.content;
  if (payload.contentType !== undefined) entryPayload.contentType = payload.contentType;
  if (payload.updated !== undefined) entryPayload.updated = payload.updated;
  if (payload.customUrl !== undefined) entryPayload.customUrl = payload.customUrl;
  if (payload.control !== undefined) {
    entryPayload.control = {
      ...(payload.control.draft !== undefined ? { draft: payload.control.draft } : {}),
      ...(payload.control.preview !== undefined ? { preview: payload.control.preview } : {}),
    };
  }
  return buildEntryXml(entryPayload, { ...opts, includeScheduled: false });
}
