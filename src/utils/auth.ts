/**
 * Credentials extracted from a BYOK `Authorization: Basic ...` header.
 *
 * We keep the raw header around so the AtomPub client can relay it verbatim
 * to Hatena without re-encoding — decoding once, re-encoding once is almost
 * always fine, but "once" is already one round-trip more than is necessary.
 */
export interface BasicCredentials {
  /** `Basic base64(user:pass)` — ready to paste into an outbound Authorization header. */
  authHeader: string;
  /** Hatena ID (the username portion of the Basic header). */
  hatenaId: string;
}

export class MissingCredentialsError extends Error {
  constructor(message = "Authorization header is missing or not Basic") {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

/**
 * Parse a raw `Authorization` header value. Returns the credentials or throws
 * MissingCredentialsError. The password/API key is never returned — callers
 * that need to forward it use `authHeader` instead.
 *
 * Implementation note: we use Web-standard `atob` which is available in both
 * Cloudflare Workers and Node 16+. No `Buffer` — this code runs on Workers.
 */
export function parseBasicAuth(headerValue: string | null | undefined): BasicCredentials {
  if (!headerValue) throw new MissingCredentialsError();
  const trimmed = headerValue.trim();
  const match = /^Basic\s+(.+)$/i.exec(trimmed);
  if (!match || !match[1]) throw new MissingCredentialsError();
  const b64 = match[1].trim();
  let decoded: string;
  try {
    decoded = atob(b64);
  } catch {
    throw new MissingCredentialsError("Authorization header has invalid base64");
  }
  const colonIndex = decoded.indexOf(":");
  if (colonIndex <= 0) {
    throw new MissingCredentialsError("Authorization payload must be 'user:password'");
  }
  const hatenaId = decoded.slice(0, colonIndex);
  return { authHeader: trimmed, hatenaId };
}
