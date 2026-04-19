import type { RetryOptions } from "../utils/retry.js";
import { fetchWithRetry } from "../utils/retry.js";
import { AtomPubError } from "./errors.js";
import type {
  CategoryDocument,
  Entry,
  EntryList,
  EntryWritePayload,
  Page,
  PageList,
  PageWritePayload,
} from "./types.js";
import {
  buildEntryXml,
  buildPageXml,
  parseCategories,
  parseEntry,
  parseFeed,
  parsePage,
  parsePageFeed,
} from "./xml.js";

export interface AtomPubCredentials {
  /**
   * The full `Basic <base64>` header value from the MCP client. Relayed to
   * Hatena unchanged — we never store the decoded secret on our side.
   */
  authHeader: string;
  /** Hatena ID used as the first path segment of the AtomPub URL. */
  hatenaId: string;
}

export interface AtomPubClientOptions {
  credentials: AtomPubCredentials;
  /**
   * The blog identifier, e.g. `example_user.hatenablog.com`. This appears as
   * the second path segment in every AtomPub URL.
   */
  blogId: string;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

const ATOMPUB_BASE = "https://blog.hatena.ne.jp";
const CONTENT_TYPE_XML = "application/xml; charset=utf-8";

export class AtomPubClient {
  private readonly credentials: AtomPubCredentials;
  private readonly blogId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryOptions;

  constructor(opts: AtomPubClientOptions) {
    this.credentials = opts.credentials;
    this.blogId = opts.blogId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retry = opts.retry ?? {};
  }

  // ------------------------------------------------------------------ URLs

  private collectionUrl(kind: "entry" | "page"): string {
    return `${ATOMPUB_BASE}/${encode(this.credentials.hatenaId)}/${encode(this.blogId)}/atom/${kind}`;
  }

  private memberUrl(kind: "entry" | "page", id: string): string {
    return `${this.collectionUrl(kind)}/${encode(id)}`;
  }

  private categoryUrl(): string {
    return `${ATOMPUB_BASE}/${encode(this.credentials.hatenaId)}/${encode(this.blogId)}/atom/category`;
  }

  // ------------------------------------------------------------------ Entries

  async listEntries(opts: { page?: string } = {}): Promise<EntryList> {
    const url = buildUrlWithPage(this.collectionUrl("entry"), opts.page);
    const xml = await this.requestXml("GET", url);
    return parseFeed(xml);
  }

  async getEntry(entryId: string): Promise<Entry> {
    const xml = await this.requestXml("GET", this.memberUrl("entry", entryId));
    return parseEntry(xml);
  }

  async createEntry(payload: EntryWritePayload): Promise<Entry> {
    const body = buildEntryXml(payload, { creating: true });
    const xml = await this.requestXml("POST", this.collectionUrl("entry"), body);
    return parseEntry(xml);
  }

  async updateEntry(entryId: string, payload: EntryWritePayload): Promise<Entry> {
    const body = buildEntryXml(payload, { creating: false });
    const xml = await this.requestXml("PUT", this.memberUrl("entry", entryId), body);
    return parseEntry(xml);
  }

  async deleteEntry(entryId: string): Promise<void> {
    await this.request("DELETE", this.memberUrl("entry", entryId));
  }

  // ------------------------------------------------------------------ Pages

  async listPages(opts: { page?: string } = {}): Promise<PageList> {
    const url = buildUrlWithPage(this.collectionUrl("page"), opts.page);
    const xml = await this.requestXml("GET", url);
    return parsePageFeed(xml);
  }

  async getPage(pageId: string): Promise<Page> {
    const xml = await this.requestXml("GET", this.memberUrl("page", pageId));
    return parsePage(xml);
  }

  async createPage(payload: PageWritePayload): Promise<Page> {
    const body = buildPageXml(payload, { creating: true });
    const xml = await this.requestXml("POST", this.collectionUrl("page"), body);
    return parsePage(xml);
  }

  async updatePage(pageId: string, payload: PageWritePayload): Promise<Page> {
    const body = buildPageXml(payload, { creating: false });
    const xml = await this.requestXml("PUT", this.memberUrl("page", pageId), body);
    return parsePage(xml);
  }

  async deletePage(pageId: string): Promise<void> {
    await this.request("DELETE", this.memberUrl("page", pageId));
  }

  // ------------------------------------------------------------------ Categories

  async listCategories(): Promise<CategoryDocument> {
    const xml = await this.requestXml("GET", this.categoryUrl());
    return parseCategories(xml);
  }

  // ------------------------------------------------------------------ Core

  private async request(method: string, url: string, body?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: this.credentials.authHeader,
      Accept: "application/xml",
    };
    if (body !== undefined) {
      headers["Content-Type"] = CONTENT_TYPE_XML;
    }
    const response = await fetchWithRetry(
      url,
      {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      },
      { ...this.retry, fetchImpl: this.fetchImpl },
    );
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new AtomPubError(describeStatus(response.status), {
        status: response.status,
        body: text,
      });
    }
    return response;
  }

  private async requestXml(method: string, url: string, body?: string): Promise<string> {
    const response = await this.request(method, url, body);
    return await response.text();
  }
}

// ---------------------------------------------------------------------------

function buildUrlWithPage(base: string, page: string | undefined): string {
  if (page === undefined) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}page=${encode(page)}`;
}

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function describeStatus(status: number): string {
  if (status === 401) return "Hatena AtomPub authentication failed (401)";
  if (status === 403) return "Hatena AtomPub forbade the request (403)";
  if (status === 404) return "Hatena AtomPub resource not found (404)";
  if (status === 429) return "Hatena AtomPub rate limit exceeded (429)";
  if (status >= 500) return `Hatena AtomPub server error (${status})`;
  return `Hatena AtomPub returned ${status}`;
}
