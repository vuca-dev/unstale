// GitHub's rate-limit 403 (primary: `x-ratelimit-remaining: 0`; secondary: `retry-after` or its message) is a rate
// limit like a 429: the release-list reader throws it as one, the drain pauses every start and counts no failure. Any
// other 403 stays a failure. The docs fetcher answers a rate-limited read as 429, which its readers treat as transient.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FetchFailure, githubRateLimit, type HttpClient } from "../src/collector/http.ts";
import { httpFetcher } from "../src/docs/fetcher.ts";
import type { RobotsCache } from "../src/docs/robots.ts";
import { rateLimit } from "../src/onboarding/service.ts";
import { fetchReleases } from "../src/pipeline/fetch.ts";
import type { Technology } from "../src/pipeline/technologies.ts";

const T: Technology = { id: "limited-00000000", name: "limited", repo: "ex/limited", components: ["pkg:npm/limited"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
const prevDir = process.env.UNSTALE_CENTRAL_DIR;
const prevToken = process.env.GITHUB_TOKEN;
let calls = 0;

beforeEach(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-gh-limit-"));
  process.env.GITHUB_TOKEN = "test-token";
  calls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (prevDir === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prevDir;
  if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = prevToken;
});

/** Every GitHub request answers 403 with these headers and body. */
function forbid(headers: Record<string, string>, body = '{"message":"Resource not accessible by integration"}') {
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response(body, { status: 403, headers });
  });
}

/** fetchReleases' error, its retries' waits run on fake timers. */
async function releasesError(): Promise<unknown> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const failed = fetchReleases(T).then(() => undefined, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  return failed;
}

describe("GitHub rate-limit 403", () => {
  test("primary: remaining 0 is a rate limit until the reset, tried as a 429 is, then thrown as one", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    forbid({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, '{"message":"API rate limit exceeded for installation ID 1."}');
    const e = await releasesError();
    expect(e).toBeInstanceOf(FetchFailure);
    expect(e).toMatchObject({ httpStatus: 403, host: "api.github.com", rateLimited: true, message: "GitHub ex/limited page 1: 403" });
    expect(calls).toBe(3);
    const limited = rateLimit(e);
    expect(limited?.retryAfterMs).toBeGreaterThan(590_000);
    expect(limited?.retryAfterMs).toBeLessThanOrEqual(600_000);
  });

  test("secondary: retry-after, or only the documented message (at least a minute)", async () => {
    forbid({ "retry-after": "120" }, '{"message":"You have exceeded a secondary rate limit."}');
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 120_000 });
    vi.useRealTimers();
    forbid({}, '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}');
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 60_000 });
  });

  test("a 403 that is not a rate limit stays a failure, asked once", async () => {
    forbid({ "x-ratelimit-remaining": "4000" });
    const e = await releasesError();
    expect(e).not.toBeInstanceOf(FetchFailure);
    expect(String(e)).toContain("GitHub ex/limited page 1: 403");
    expect(rateLimit(e)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a GitHub 429 keeps its Retry-After for the pause", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 30_000 });
  });

  test("the rule: only a 403, by header or the documented message", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "0" }))).toEqual({});
    expect(githubRateLimit(403, h({}), "API rate limit exceeded for 1.2.3.4.")).toEqual({ retryAfterMs: 60_000 });
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "12" }), "Must have admin rights to Repository.")).toBeUndefined();
    expect(githubRateLimit(404, h({ "x-ratelimit-remaining": "0" }))).toBeUndefined();
    expect(githubRateLimit(401, h({ "retry-after": "5" }))).toBeUndefined();
  });

  test("the docs fetcher answers a rate-limited read as 429, a plain 403 as 403", async () => {
    const failing = (e: FetchFailure) => ({ get: async () => { throw e; } }) as unknown as HttpClient;
    const robots = { allowed: async () => true } as unknown as RobotsCache;
    const limited = httpFetcher(failing(new FetchFailure("http_status", "HTTP 403 (rate limit)", 403, 60_000, "api.github.com", true)), robots, "t");
    expect((await limited.get("https://api.github.com/repos/ex/limited", "application/json", true)).status).toBe(429);
    const denied = httpFetcher(failing(new FetchFailure("http_status", "HTTP 403", 403, undefined, "api.github.com")), robots, "t");
    expect((await denied.get("https://api.github.com/repos/ex/limited", "application/json", true)).status).toBe(403);
  });
});
