/**
 * Content type recognised by Hatena AtomPub.
 *
 * NOTE: On update, the existing value MUST be preserved — the API will coerce
 * the body to match whatever `type` you send, so changing it silently rewrites
 * the content's rendering rules.
 */
export type ContentType = "text/x-markdown" | "text/x-hatena-syntax" | "text/html" | "text/plain";

export interface EntryControl {
  draft: boolean;
  preview: boolean;
  /** Only meaningful for entries (not for pages). */
  scheduled: boolean;
}

export interface Entry {
  /** Numeric id from <link rel="edit">, used in `.../atom/entry/{id}`. */
  id: string;
  /** Full atom `<id>` (urn-like) — kept for round-trip fidelity. */
  atomId: string;
  title: string;
  authorName: string;
  /** Raw body as authored. */
  content: string;
  contentType: ContentType | undefined;
  /** Rendered HTML (from `hatena:formatted-content`). Only populated when explicitly requested. */
  formattedContent?: string;
  categories: string[];
  control: EntryControl;
  /** ISO-8601. */
  updated: string;
  /** ISO-8601. May be absent on newly created entries. */
  published?: string;
  /** ISO-8601. Last edit timestamp (`app:edited`). */
  edited?: string;
  /** Public permalink (`link rel="alternate" type="text/html"`). */
  url?: string;
  /** Edit URI (`link rel="edit"`). */
  editUrl?: string;
  /** `hatenablog:custom-url`. Absent when the blog uses the default URL format. */
  customUrl?: string;
}

/** Pages never carry categories or scheduling. */
export interface Page {
  id: string;
  atomId: string;
  title: string;
  authorName: string;
  content: string;
  contentType: ContentType | undefined;
  formattedContent?: string;
  control: Omit<EntryControl, "scheduled">;
  updated: string;
  published?: string;
  edited?: string;
  url?: string;
  editUrl?: string;
  /** Required on create for pages. */
  customUrl?: string;
}

export interface EntryList {
  entries: Entry[];
  /**
   * The `page` query-string value for the next page, or null when there is no
   * next page. Carries just the epoch number — not a full URL — so callers
   * can pass it straight back into `list_entries({ page })`.
   */
  nextPage: string | null;
}

export interface PageList {
  pages: Page[];
  nextPage: string | null;
}

export interface CategoryDocument {
  categories: string[];
  /** When true, new categories cannot be added to this blog. */
  fixed: boolean;
}

/**
 * Payload used when POSTing a new entry or PUTting an existing one. Every
 * field is optional at this layer; the MCP tool layer decides which to set.
 *
 * The XML builder interprets `undefined` fields as "omit" — callers rely on
 * that for two update edge-cases:
 *   - omitting `updated` preserves the published timestamp
 *   - omitting `customUrl` preserves the slug
 */
export interface EntryWritePayload {
  title?: string;
  authorName?: string;
  content?: string;
  contentType?: ContentType;
  categories?: string[];
  control?: Partial<EntryControl>;
  updated?: string;
  customUrl?: string;
}

export interface PageWritePayload {
  title?: string;
  authorName?: string;
  content?: string;
  contentType?: ContentType;
  control?: Partial<Omit<EntryControl, "scheduled">>;
  updated?: string;
  customUrl?: string;
}
