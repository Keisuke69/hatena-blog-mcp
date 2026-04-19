import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "../../src/utils/retry.js";

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response("body", { status, headers });
}

interface Recorder {
  calls: number;
  waits: number[];
}

function makeDeps(recorder: Recorder) {
  return {
    random: () => 0.5, // no jitter
    sleep: async (ms: number) => {
      recorder.waits.push(ms);
    },
    now: () => 0,
  };
}

describe("fetchWithRetry", () => {
  it("returns the first 2xx response without retrying", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return makeResponse(200);
    };
    const res = await fetchWithRetry("https://x", {}, { ...makeDeps(rec), fetchImpl });
    expect(res.status).toBe(200);
    expect(rec.calls).toBe(1);
    expect(rec.waits).toEqual([]);
  });

  it("does not retry non-retryable 4xx statuses", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return makeResponse(401);
    };
    const res = await fetchWithRetry("https://x", {}, { ...makeDeps(rec), fetchImpl });
    expect(res.status).toBe(401);
    expect(rec.calls).toBe(1);
  });

  it("retries 429 up to maxRetries with exponential backoff", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return makeResponse(429);
    };
    const res = await fetchWithRetry(
      "https://x",
      {},
      { ...makeDeps(rec), fetchImpl, maxRetries: 3, baseDelayMs: 1000, factor: 2 },
    );
    expect(res.status).toBe(429);
    // Attempt 0 → wait 1000, attempt 1 → 2000, attempt 2 → 4000, attempt 3 → give up
    expect(rec.calls).toBe(4);
    expect(rec.waits).toEqual([1000, 2000, 4000]);
  });

  it("retries 503 and eventually succeeds", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return rec.calls < 3 ? makeResponse(503) : makeResponse(200);
    };
    const res = await fetchWithRetry(
      "https://x",
      {},
      { ...makeDeps(rec), fetchImpl, baseDelayMs: 100, factor: 2 },
    );
    expect(res.status).toBe(200);
    expect(rec.calls).toBe(3);
    expect(rec.waits).toEqual([100, 200]);
  });

  it("honours Retry-After: seconds over the computed backoff", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return rec.calls < 2 ? makeResponse(429, { "Retry-After": "7" }) : makeResponse(200);
    };
    await fetchWithRetry("https://x", {}, { ...makeDeps(rec), fetchImpl, baseDelayMs: 100 });
    expect(rec.waits).toEqual([7000]);
  });

  it("honours Retry-After: HTTP-date and clamps negative deltas to 0", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const pastDate = new Date(0).toUTCString();
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return rec.calls < 2 ? makeResponse(503, { "Retry-After": pastDate }) : makeResponse(200);
    };
    await fetchWithRetry(
      "https://x",
      {},
      { ...makeDeps(rec), fetchImpl, baseDelayMs: 100, now: () => 10_000 },
    );
    // Date is in the past relative to now=10000, so delta is clamped to 0.
    expect(rec.waits).toEqual([0]);
  });

  it("clamps wait to maxDelayMs", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return makeResponse(503);
    };
    await fetchWithRetry(
      "https://x",
      {},
      {
        ...makeDeps(rec),
        fetchImpl,
        maxRetries: 2,
        baseDelayMs: 1000,
        factor: 100, // blow up quickly
        maxDelayMs: 5_000,
      },
    );
    // attempt 0 → 1000, attempt 1 → would be 100000, clamped to 5000
    expect(rec.waits).toEqual([1000, 5_000]);
  });

  it("retries on fetch rejections (network errors)", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      if (rec.calls < 3) throw new Error("network");
      return makeResponse(200);
    };
    const res = await fetchWithRetry(
      "https://x",
      {},
      { ...makeDeps(rec), fetchImpl, baseDelayMs: 50, factor: 2 },
    );
    expect(res.status).toBe(200);
    expect(rec.calls).toBe(3);
    expect(rec.waits).toEqual([50, 100]);
  });

  it("propagates AbortError immediately (no retry)", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await expect(fetchWithRetry("https://x", {}, { ...makeDeps(rec), fetchImpl })).rejects.toThrow(
      /aborted/,
    );
    expect(rec.calls).toBe(1);
    expect(rec.waits).toEqual([]);
  });

  it("throws the final network error after exhausting retries", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      throw new Error("still down");
    };
    await expect(
      fetchWithRetry(
        "https://x",
        {},
        { ...makeDeps(rec), fetchImpl, maxRetries: 2, baseDelayMs: 10 },
      ),
    ).rejects.toThrow(/still down/);
    expect(rec.calls).toBe(3); // 1 initial + 2 retries
  });

  it("applies ±25% jitter when random is not 0.5", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return makeResponse(503);
    };
    await fetchWithRetry(
      "https://x",
      {},
      {
        random: () => 0, // push to lower bound: multiplier = 1 + (0 - 0.5) * 0.5 = 0.75
        sleep: async (ms) => {
          rec.waits.push(ms);
        },
        now: () => 0,
        fetchImpl,
        maxRetries: 1,
        baseDelayMs: 1000,
        factor: 2,
      },
    );
    expect(rec.waits).toEqual([750]);
  });

  it("ignores Retry-After when the value is unparseable", async () => {
    const rec: Recorder = { calls: 0, waits: [] };
    const fetchImpl = async (): Promise<Response> => {
      rec.calls += 1;
      return rec.calls < 2 ? makeResponse(503, { "Retry-After": "not-a-date" }) : makeResponse(200);
    };
    await fetchWithRetry(
      "https://x",
      {},
      { ...makeDeps(rec), fetchImpl, baseDelayMs: 42, factor: 1 },
    );
    expect(rec.waits).toEqual([42]);
  });
});
