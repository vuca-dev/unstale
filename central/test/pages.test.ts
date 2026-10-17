// The shared docs page cache: one fetch per page per day across technologies; a technology's own re-check always
// fetches; validators answer conditional requests; expired pages are pruned.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_HTTP, HttpClient, type FetchResult } from "../src/collector/http.ts";
import { SharedPages } from "../src/docs/pages.ts";

class Origin extends HttpClient {
  calls = 0;
  body = "<h1>v1</h1>";
  override async get(url: string): Promise<FetchResult> {
    this.calls++;
    return { status: 200, finalUrl: url, headers: new Headers({ "content-type": "text/html", etag: '"e1"' }), body: new TextEncoder().encode(this.body) };
  }
}

test("one fetch per page across technologies; the fetching technology's own re-check goes to the origin", async () => {
  const origin = new Origin(DEFAULT_HTTP);
  const dir = mkdtempSync(join(tmpdir(), "unstale-pages-"));
  const a = new SharedPages(origin, "a", 3600_000, dir);
  const b = new SharedPages(origin, "b", 3600_000, dir);
  const h = { accept: "text/html" };
  await a.get("https://docs.x.dev/p", h);
  const viaB = await b.get("https://docs.x.dev/p", h);
  expect([origin.calls, new TextDecoder().decode(viaB.body), b.hits]).toEqual([1, "<h1>v1</h1>", 1]);
  origin.body = "<h1>v2</h1>";
  expect(new TextDecoder().decode((await a.get("https://docs.x.dev/p", h)).body)).toBe("<h1>v2</h1>");
  expect(origin.calls).toBe(2);
  // A conditional request whose validator matches is answered 304 from the kept page; other headers are another key.
  expect((await new SharedPages(origin, "c", 3600_000, dir).get("https://docs.x.dev/p", { ...h, "If-None-Match": '"e1"' })).status).toBe(304);
  await b.get("https://docs.x.dev/p", { accept: "text/markdown" });
  expect(origin.calls).toBe(3);
});

test("pages kept past the TTL are not served and are pruned", async () => {
  const origin = new Origin(DEFAULT_HTTP);
  const dir = mkdtempSync(join(tmpdir(), "unstale-pages-"));
  await new SharedPages(origin, "a", 1000, dir).get("https://docs.x.dev/p", {});
  const later = new SharedPages(origin, "b", 1000, dir);
  expect(later.prune(Date.now() + 2000)).toBe(1);
  await later.get("https://docs.x.dev/p", {});
  expect(origin.calls).toBe(2);
});
