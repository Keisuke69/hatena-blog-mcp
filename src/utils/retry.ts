/**
 * `fetch` wrapper that retries transient failures from the Hatena AtomPub API.
 *
 * Retries:
 *   - HTTP 429 (rate limited) and 5xx (server errors / gateway blips)
 *   - Network-level rejections (DNS, TLS, fetch threw)
 *
 * Does NOT retry:
 *   - 4xx other than 429 (caller bug / auth issue — retrying won't help)
 *   - AbortError from the caller's signal (user gave up deliberately)
 *
 * `Retry-After` is honoured both as a whole-number seconds value and as an
 * HTTP-date. When present, it replaces the computed backoff.
 */
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Multiplier per attempt; 2 means 1s, 2s, 4s ... */
  factor?: number;
  /** Upper bound on a single wait — useful for very polite retries. */
  maxDelayMs?: number;
  /** Deterministic backoff source (0..1). Default: Math.random. Tests pass a stub. */
  random?: () => number;
  /** Deterministic sleep. Default: setTimeout. Tests pass a no-op collector. */
  sleep?: (ms: number) => Promise<void>;
  /** Override `fetch` — useful for Workers, Node tests, etc. */
  fetchImpl?: typeof fetch;
  /** Wall-clock source used to parse Retry-After HTTP-dates. */
  now?: () => number;
}

const DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 30_000,
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const factor = opts.factor ?? DEFAULTS.factor;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    try {
      const response = await fetchImpl(input, init);
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      if (attempt === maxRetries) {
        return response;
      }
      const waitMs = computeWaitMs({
        attempt,
        baseDelayMs,
        factor,
        maxDelayMs,
        random,
        retryAfter: response.headers.get("retry-after"),
        now,
      });
      // Consume the body so the connection can be reused.
      await response.body?.cancel?.();
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      if (isAbortError(err) || attempt === maxRetries) {
        throw err;
      }
      const waitMs = computeWaitMs({
        attempt,
        baseDelayMs,
        factor,
        maxDelayMs,
        random,
        retryAfter: null,
        now,
      });
      await sleep(waitMs);
    }
    attempt += 1;
  }

  // Loop only exits via return/throw above; this satisfies the type checker.
  throw lastError ?? new Error("fetchWithRetry exhausted retries");
}

function computeWaitMs(args: {
  attempt: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  random: () => number;
  retryAfter: string | null;
  now: () => number;
}): number {
  const retryAfterMs = parseRetryAfter(args.retryAfter, args.now);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, args.maxDelayMs);
  }
  const exp = args.baseDelayMs * args.factor ** args.attempt;
  const jitter = 1 + (args.random() - 0.5) * 0.5; // ±25%
  return Math.min(Math.max(0, exp * jitter), args.maxDelayMs);
}

function parseRetryAfter(value: string | null, now: () => number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Pure-digit form: seconds.
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date form.
  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now());
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || (err as { code?: string }).code === "ABORT_ERR")
  );
}
