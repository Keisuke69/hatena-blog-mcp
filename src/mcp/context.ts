import { AtomPubClient } from "../atompub/client.js";
import type { BasicCredentials } from "../utils/auth.js";
import type { RetryOptions } from "../utils/retry.js";

/**
 * Everything a tool handler needs to talk to Hatena on behalf of the caller.
 *
 * Constructed once per MCP request in the transport adapter so that every
 * tool invocation inside that request sees the same credentials. The
 * adapter is responsible for extracting `credentials` from the
 * `Authorization` header and rejecting unauthenticated requests before the
 * tool layer ever runs.
 */
export interface ToolContext {
  credentials: BasicCredentials;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
}

/**
 * Builds a scoped AtomPubClient for a specific blog.
 *
 * `hatenaIdOverride` lets a tool call target a blog owned by a different
 * Hatena ID than the credential's username component — only meaningful if
 * the same API key happens to be valid for both accounts (rare but
 * technically possible for group blogs).
 */
export function makeClient(
  ctx: ToolContext,
  blogId: string,
  hatenaIdOverride?: string,
): AtomPubClient {
  const opts: ConstructorParameters<typeof AtomPubClient>[0] = {
    credentials: {
      authHeader: ctx.credentials.authHeader,
      hatenaId: hatenaIdOverride ?? ctx.credentials.hatenaId,
    },
    blogId,
  };
  if (ctx.fetchImpl) opts.fetchImpl = ctx.fetchImpl;
  if (ctx.retry) opts.retry = ctx.retry;
  return new AtomPubClient(opts);
}
