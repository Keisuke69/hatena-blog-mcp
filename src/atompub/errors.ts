/**
 * Error thrown for any non-2xx response from the Hatena AtomPub API, plus
 * parse failures. The MCP layer maps these into user-facing Japanese messages;
 * the raw body is kept here only for logging and never surfaced to clients.
 */
export class AtomPubError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly code: AtomPubErrorCode;

  constructor(
    message: string,
    opts: {
      status: number;
      body?: string;
      code?: AtomPubErrorCode;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AtomPubError";
    this.status = opts.status;
    this.bodySnippet = truncate(opts.body ?? "", 500);
    this.code = opts.code ?? inferCode(opts.status);
  }
}

export type AtomPubErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "bad_request"
  | "parse_error"
  | "network_error"
  | "unknown";

function inferCode(status: number): AtomPubErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "bad_request";
  if (status === 0) return "network_error";
  return "unknown";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}
