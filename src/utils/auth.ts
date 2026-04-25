/**
 * Credentials extracted from a BYOK Authorization header.
 *
 * Hatena AtomPub only accepts Basic, so `authHeader` is always normalised to
 * `Basic <base64(hatena_id:api_key)>` regardless of what scheme the caller
 * used. Callers can paste it straight into an outbound request.
 */
export interface BasicCredentials {
  /** `Basic <base64>` — ready to relay to Hatena unchanged. */
  authHeader: string;
  /** Hatena ID (the username portion). */
  hatenaId: string;
}

export class MissingCredentialsError extends Error {
  constructor(message = "Authorization header is missing or unsupported") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/**
 * Parse a raw `Authorization` header value. Accepts either of:
 *
 *   Basic  base64(hatena_id:api_key)        — native Hatena form
 *   Bearer base64(hatena_id:api_key)        — for OAuth proxies that
 *   Bearer hatena_id:api_key                  hardcode the `Bearer` scheme
 *                                             (e.g. mcp-oauth-proxy)
 *
 * Returns credentials with `authHeader` always normalised to `Basic ...` so
 * the AtomPub client can forward it verbatim. The password/API key is never
 * exposed on the returned object.
 *
 * Workers-safe: uses Web-standard `atob` / `btoa`, no `Buffer`.
 */
export function parseAuthHeader(headerValue: string | null | undefined): BasicCredentials {
  if (!headerValue) throw new MissingCredentialsError();
  const trimmed = headerValue.trim();
  const match = /^(Basic|Bearer)\s+(.+)$/i.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    throw new MissingCredentialsError(
      "Authorization header must be 'Basic <base64>' or 'Bearer <token>'",
    );
  }
  const scheme = match[1].toLowerCase();
  const token = match[2].trim();

  if (scheme === "basic") return parseBasicToken(trimmed, token);
  return parseBearerToken(token);
}

/** Backward-compatible alias — older callers/tests may still import this. */
export const parseBasicAuth = parseAuthHeader;

function parseBasicToken(rawHeader: string, token: string): BasicCredentials {
  let decoded: string;
  try {
    decoded = atob(token);
  } catch {
    throw new MissingCredentialsError("Authorization header has invalid base64");
  }
  const colonIndex = decoded.indexOf(":");
  if (colonIndex <= 0) {
    throw new MissingCredentialsError("Authorization payload must be 'user:password'");
  }
  return { authHeader: rawHeader, hatenaId: decoded.slice(0, colonIndex) };
}

function parseBearerToken(token: string): BasicCredentials {
  // OAuth プロキシ (mcp-oauth-proxy など) は `Bearer ` プレフィックスを
  // 強制することが多い。Bearer トークンは不透明な文字列なので、
  // hatena_id:api_key を 1 つの値に詰めてもらい、ここで Basic に組み直す。
  const split = splitBearerPayload(token);
  if (!split) {
    throw new MissingCredentialsError(
      "Bearer token must encode 'hatena_id:api_key' (plain or base64)",
    );
  }
  const { hatenaId, apiKey, base64 } = split;
  return {
    authHeader: `Basic ${base64 ?? btoa(`${hatenaId}:${apiKey}`)}`,
    hatenaId,
  };
}

function splitBearerPayload(
  token: string,
): { hatenaId: string; apiKey: string; base64?: string } | null {
  // Try base64 first — same payload format as Basic, so the user can reuse
  // their existing base64(hatena_id:api_key) value with either scheme.
  try {
    const decoded = atob(token);
    const i = decoded.indexOf(":");
    if (i > 0 && i < decoded.length - 1) {
      return { hatenaId: decoded.slice(0, i), apiKey: decoded.slice(i + 1), base64: token };
    }
  } catch {
    // not valid base64; fall through to plaintext
  }
  // Fall back to plain `user:pass`. Convenient for proxies whose UI is just
  // a single text box that shows what was typed verbatim.
  const i = token.indexOf(":");
  if (i > 0 && i < token.length - 1) {
    return { hatenaId: token.slice(0, i), apiKey: token.slice(i + 1) };
  }
  return null;
}
