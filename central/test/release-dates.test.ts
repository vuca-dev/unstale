// Release dates from the registry (fetch.ts `publishDates`, ecosystems.ts `publishTimes`). Case: jsdom created a GitHub
// release for every old tag on 2026-03-15, so its index dated 0.2.1 through 29.x on that one day; npm `time` has when
// each version was published (times below as the registry gave them on 17 October 2026, trimmed to a few versions).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchReleases, publishDates } from "../src/pipeline/fetch.ts";
import { buildIndex, recomputeReleases } from "../src/pipeline/lines.ts";
import type { StoredRecord } from "../src/pipeline/store.ts";
import { SINCE, type Technology } from "../src/pipeline/technologies.ts";
import { sha256, writeAtomic } from "../src/pipeline/util.ts";

const JSDOM: Technology = { id: "jsdom-341360b0", name: "jsdom", repo: "jsdom/jsdom", components: ["pkg:npm/jsdom"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
const CARGO: Technology = { id: "cargo-fixture", name: "Cargo fixture", repo: "fixture/cargo", components: ["pkg:cargo/fixture-crate"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
const NPM_TIME = {
  created: "2011-11-21T03:09:04.421Z",
  modified: "2026-10-15T09:24:39.281Z",
  "0.2.1": "2011-11-21T03:12:01.000Z",
  "20.0.1": "2022-10-02T06:54:05.058Z",
  "29.0.0": "2026-03-15T06:57:21.321Z",
  "30.0.0": "2026-07-27T10:01:00.000Z",
};
const gh = (tag: string, day: string) => ({ tag_name: tag, published_at: `${day}T12:00:00Z`, prerelease: false, draft: false, body: `notes for ${tag}`, html_url: `https://github.com/jsdom/jsdom/releases/tag/${tag}` });

let dir: string;
const prevDir = process.env.UNSTALE_CENTRAL_DIR;
const prevToken = process.env.GITHUB_TOKEN;
let calls: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-dates-"));
  process.env.UNSTALE_CENTRAL_DIR = dir;
  process.env.GITHUB_TOKEN = "test-token";
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevDir === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prevDir;
  if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = prevToken;
});

function stub(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    return hit ? new Response(JSON.stringify(hit[1])) : new Response("not found", { status: 404 });
  });
}

const stored = (tag: string, version: string, date: string) => {
  writeAtomic(join(dir, "releases", JSDOM.id, `${version}.md`), `notes for ${tag}`);
  return { technology: JSDOM.id, tag, version, date, url: `https://github.com/jsdom/jsdom/releases/tag/${tag}`, snapshot: `sha256:${sha256(`notes for ${tag}`)}` };
};

describe("release dates", () => {
  test("a stored index dated by a bulk GitHub import is corrected from the registry on its next read", async () => {
    // As the store held it: every old release on the day the GitHub releases were created; checked just now, so the
    // release list is not requested again.
    const checked = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    writeAtomic(join(dir, "releases", JSDOM.id, "index.json"), JSON.stringify({ checked, tagPattern: JSDOM.tag.source, releases: [stored("v0.2.1", "0.2.1", "2026-03-15"), stored("v20.0.1", "20.0.1", "2026-03-15"), stored("v29.0.0", "29.0.0", "2026-03-15")] }));
    stub({ "https://registry.npmjs.org/jsdom": { name: "jsdom", time: NPM_TIME } });
    const { notes, checked: after } = await fetchReleases(JSDOM);
    expect(after).toBe(checked);
    expect(notes.map((n) => [n.version, n.date, n.noteDate])).toEqual([
      ["0.2.1", "2011-11-21", "2026-03-15"],
      ["20.0.1", "2022-10-02", "2026-03-15"],
      // Same day on both: no separate note date (the extraction prompt is unchanged either way).
      ["29.0.0", "2026-03-15", undefined],
    ]);
    expect(calls.filter((u) => u.includes("api.github.com"))).toEqual([]);
    const index = JSON.parse(readFileSync(join(dir, "releases", JSDOM.id, "index.json"), "utf8"));
    expect(index.releases.map((r: { date: string; published: string }) => [r.date, r.published])).toEqual([
      ["2026-03-15", "2011-11-21"],
      ["2026-03-15", "2022-10-02"],
      ["2026-03-15", "2026-03-15"],
    ]);
    // Stored once: the next read asks nothing.
    calls = [];
    expect((await fetchReleases(JSDOM)).notes.map((n) => n.date)).toEqual(["2011-11-21", "2022-10-02", "2026-03-15"]);
    expect(calls).toEqual([]);
  });

  test("a new GitHub release is in the window by its registry day; one the registry lacks keeps its GitHub day", async () => {
    stub({
      "https://api.github.com/repos/jsdom/jsdom/releases": [gh("31.0.0", "2026-10-16"), gh("v30.0.0", "2026-07-28"), gh("v20.0.1", "2026-03-15"), gh("v0.2.1", "2026-03-15")],
      "https://registry.npmjs.org/jsdom": { name: "jsdom", time: NPM_TIME },
    });
    const { notes, stats } = await fetchReleases(JSDOM);
    // 0.2.1 and 20.0.1 were published years before the window: not taken for new releases.
    expect(notes.map((n) => [n.version, n.date, n.noteDate])).toEqual([
      ["30.0.0", "2026-07-27", "2026-07-28"],
      ["31.0.0", "2026-10-16", undefined],
    ]);
    expect(stats.newReleases).toBe(2);
  });

  test("a listing that runs out of pages before the window's start asks for each line's x.0.0 by its tag", async () => {
    // vercel/ai tags every package of the repository (about 100 a day): its 59 pages end two months back, past
    // ai@7.0.0 (25 June 2026), so the release whose notes carry the major's changes was never listed.
    const AI: Technology = { id: "ai-21ad95de", name: "ai", repo: "vercel/ai", components: ["pkg:npm/ai"], tag: /^ai@(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const rel = (tag: string, day: string) => ({ ...gh(tag, day), html_url: `https://github.com/vercel/ai/releases/tag/${encodeURIComponent(tag)}` });
    const page = [rel("ai@7.0.66", "2026-08-14"), rel("ai@6.0.300", "2026-08-14"), ...Array.from({ length: 98 }, (_, i) => rel(`@ai-sdk/openai@3.0.${i}`, "2026-08-14"))];
    stub({
      "https://api.github.com/repos/vercel/ai/releases/tags/ai%407.0.0": rel("ai@7.0.0", "2026-06-25"),
      "https://api.github.com/repos/vercel/ai/releases?": page,
      "https://registry.npmjs.org/ai": { name: "ai", time: { "7.0.0": "2026-06-25T12:47:23.880Z", "7.0.66": "2026-08-14T18:41:57.488Z", "6.0.0": "2025-12-22T17:11:49.521Z", "6.0.300": "2026-08-14T10:00:00.000Z" } },
    });
    const { notes } = await fetchReleases(AI);
    expect(notes.map((n) => n.version)).toEqual(["7.0.0", "6.0.300", "7.0.66"]);
    // 6.0.0 has no GitHub release (404): asked once, nothing added; 7.0.0 once.
    expect(calls.filter((u) => u.includes("/releases/tags/"))).toEqual([
      "https://api.github.com/repos/vercel/ai/releases/tags/ai%407.0.0",
      "https://api.github.com/repos/vercel/ai/releases/tags/ai%406.0.0",
    ]);
    expect(calls.filter((u) => u.includes("/releases?")).length).toBe(59);
  });

  test("a tag on a line the packages never published, while the registry kept publishing, is not the technology's", async () => {
    // modelcontextprotocol/typescript-sdk tags its split v2 packages `v2.3.0`; `@modelcontextprotocol/sdk` is published
    // on 1.x only (1.32.1 on 5 October 2026). A 3.x tagged after the registry's newest publish may be one npm has not
    // caught up with: kept.
    const MCP: Technology = { id: "modelcontextprotocol-sdk-d59cf9c0", name: "MCP SDK", repo: "modelcontextprotocol/typescript-sdk", components: ["pkg:npm/%40modelcontextprotocol/sdk"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const rel = (tag: string, day: string) => ({ ...gh(tag, day), html_url: `https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/${tag}` });
    stub({
      "https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases": [rel("v3.0.0", "2026-10-07"), rel("v2.3.1", "2026-10-05"), rel("1.32.1", "2026-10-05"), rel("v2.3.0", "2026-10-02"), rel("1.32.0", "2026-10-02")],
      "https://registry.npmjs.org/@modelcontextprotocol%2fsdk": { name: "@modelcontextprotocol/sdk", time: { "1.32.0": "2026-10-02T17:32:51.427Z", "1.32.1": "2026-10-05T11:47:50.208Z" } },
    });
    const { notes } = await fetchReleases(MCP);
    expect(notes.map((n) => n.version)).toEqual(["1.32.0", "1.32.1", "3.0.0"]);
    expect(notes[0]!.url).toBe("https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0");
  });

  test("a listing that reaches the window's start asks for no tag", async () => {
    stub({ "https://api.github.com/repos/jsdom/jsdom/releases": [gh("v30.0.5", "2026-07-28")], "https://registry.npmjs.org/jsdom": { name: "jsdom", time: NPM_TIME } });
    await fetchReleases(JSDOM);
    expect(calls.filter((u) => u.includes("/releases/tags/"))).toEqual([]);
  });

  test("the registry's publish times are cached; offline answers from the cache alone", async () => {
    stub({ "https://registry.npmjs.org/jsdom": { name: "jsdom", time: NPM_TIME } });
    expect(await publishDates(JSDOM, ["29.0.0"], { offline: true })).toEqual(new Map());
    expect(calls).toEqual([]);
    expect([...(await publishDates(JSDOM, ["29.0.0", "1.0.0"]))]).toEqual([["29.0.0", "2026-03-15"]]);
    // Fresh cache: a version it lacks is not asked again inside the window.
    expect([...(await publishDates(JSDOM, ["29.0.0", "1.0.0"]))]).toEqual([["29.0.0", "2026-03-15"]]);
    expect(calls.length).toBe(1);
    expect([...(await publishDates(JSDOM, ["0.2.1"], { offline: true }))]).toEqual([["0.2.1", "2011-11-21"]]);
  });

  test("an unreadable registry fails open: GitHub dates kept", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad", { status: 400 }));
    expect(await publishDates(JSDOM, ["29.0.0"])).toEqual(new Map());
  });

  test("PyPI: the first file's upload time; a version with no files has none", async () => {
    stub({
      "https://pypi.org/pypi/Django/json": {
        releases: {
          "5.0": [{ upload_time_iso_8601: "2023-12-05T00:12:45.000000Z" }, { upload_time_iso_8601: "2023-12-04T23:59:41.502020Z" }],
          "5.0.1": [],
        },
      },
    });
    const django: Technology = { ...JSDOM, id: "django", components: ["pkg:pypi/Django"] };
    expect([...(await publishDates(django, ["5.0", "5.0.1"]))]).toEqual([["5.0", "2023-12-04"]]);
  });

  test("a component that lacks the version leaves it to the next one", async () => {
    stub({ "https://registry.npmjs.org/a": { time: { "1.0.0": "2026-01-02T00:00:00Z" } }, "https://registry.npmjs.org/b": { time: { "1.0.0": "2026-01-01T00:00:00Z", "2.0.0": "2026-02-01T00:00:00Z" } } });
    const t: Technology = { ...JSDOM, id: "ab", components: ["pkg:npm/a", "pkg:npm/b"] };
    expect([...(await publishDates(t, ["1.0.0", "2.0.0"]))]).toEqual([["1.0.0", "2026-01-02"], ["2.0.0", "2026-02-01"]]);
  });

  test("record releases take the index's day for the versions it holds", () => {
    const releaseIndex = buildIndex([{ version: "3.0.0", date: "2015-01-18" }, { version: "20.0.1", date: "2022-10-02" }]);
    const r = {
      releases: [
        { component: "pkg:npm/jsdom", version: "3.0.0", date: "2026-03-15", line: "3" },
        { component: "pkg:npm/jsdom", version: "2.0.0", date: "2026-03-15", line: "2" },
      ],
      sources: [],
    } as unknown as StoredRecord;
    expect(recomputeReleases(r, { releaseIndex }, JSDOM.components).map((x) => [x.version, x.date])).toEqual([
      ["2.0.0", "2026-03-15"],
      ["3.0.0", "2015-01-18"],
    ]);
  });
});

describe("a technology with no GitHub release notes", () => {
  test("Cargo registry releases paginate serially, use created_at, and reuse the shared cache offline", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      num: i === 0 ? "1.0.0" : `0.0.${i}`,
      created_at: i === 0 ? `${SINCE}T12:00:00Z` : "2020-01-01T00:00:00Z",
      yanked: i === 0,
    }));
    const secondPage = [
      { num: "1.1.0", created_at: "2025-10-16T01:02:03Z", yanked: false },
      { num: "2.0.0-beta.1", created_at: "2025-10-17T00:00:00Z", yanked: false },
      { num: "1.0.1", created_at: "not-a-date", yanked: false },
      { num: "not-a-version", created_at: "2025-10-18T00:00:00Z", yanked: false },
      { num: "1.2.0", created_at: "2025-10-19T23:59:59Z", yanked: true },
    ];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.endsWith("page=1&per_page=100")) return Response.json({ versions: firstPage });
      if (url.endsWith("page=2&per_page=100")) return Response.json({ versions: secondPage });
      return new Response("unexpected URL", { status: 400 });
    });
    const { registryReleases } = await import("../src/pipeline/fetch.ts");
    const releases = await registryReleases(CARGO);
    expect(releases).toEqual([
      { version: "1.0.0", date: SINCE, url: "https://crates.io/crates/fixture-crate/1.0.0" },
      { version: "1.1.0", date: "2025-10-16", url: "https://crates.io/crates/fixture-crate/1.1.0" },
      { version: "1.2.0", date: "2025-10-19", url: "https://crates.io/crates/fixture-crate/1.2.0" },
    ]);
    expect(calls).toEqual([
      "https://crates.io/api/v1/crates/fixture-crate/versions?page=1&per_page=100",
      "https://crates.io/api/v1/crates/fixture-crate/versions?page=2&per_page=100",
    ]);
    expect(calls.some((url) => url.includes("api.github.com"))).toBe(false);
    calls = [];
    expect(await registryReleases(CARGO, { offline: true })).toEqual(releases);
    expect(calls).toEqual([]);
  });

  test("missing crates and later-page failures fail open without caching a partial Cargo index", async () => {
    const missing: Technology = { ...CARGO, id: "cargo-missing", components: ["pkg:cargo/missing-crate"] };
    const failed: Technology = { ...CARGO, id: "cargo-later-failure", components: ["pkg:cargo/retry-crate"] };
    const { registryReleases } = await import("../src/pipeline/fetch.ts");
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.includes("/missing-crate/versions")) return new Response("", { status: 404 });
      if (url.endsWith("page=1&per_page=100")) return Response.json({ versions: Array.from({ length: 100 }, (_, i) => ({ num: `1.0.${i}`, created_at: "2025-10-16T00:00:00Z" })) });
      return new Response("unavailable", { status: 400 });
    });
    expect(await registryReleases(missing)).toEqual([]);
    expect(await registryReleases(failed)).toEqual([]);
    expect(calls.filter((url) => url.includes("retry-crate"))).toEqual([
      "https://crates.io/api/v1/crates/retry-crate/versions?page=1&per_page=100",
      "https://crates.io/api/v1/crates/retry-crate/versions?page=2&per_page=100",
    ]);
    expect(calls.some((url) => url.includes("api.github.com"))).toBe(false);

    calls = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return Response.json({ versions: [{ num: "2.0.0", created_at: "2025-10-20T00:00:00Z" }] });
    });
    expect(await registryReleases(failed)).toEqual([{ version: "2.0.0", date: "2025-10-20", url: "https://crates.io/crates/retry-crate/2.0.0" }]);
    expect(calls).toEqual(["https://crates.io/api/v1/crates/retry-crate/versions?page=1&per_page=100"]);
    expect(calls.some((url) => url.includes("api.github.com"))).toBe(false);
  });

  test("its advisories resolve against the registry's versions in the window: stable, dated by the registry, linked to their page", async () => {
    const MD: Technology = { id: "markdown-it-1", name: "markdown-it", repo: "markdown-it/markdown-it", components: ["pkg:npm/markdown-it"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
    stub({ "https://registry.npmjs.org/markdown-it": { name: "markdown-it", time: { created: "2014-12-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", "13.0.1": "2022-05-03T00:00:00Z", "14.2.0": "2026-06-01T08:00:00Z", "15.0.0-beta.1": "2026-08-01T00:00:00Z", "14.3.1": "2026-09-29T23:30:00Z", "15.0.1": "2026-09-30T01:00:00Z" } } });
    const { advisoryReleases, registryReleases } = await import("../src/pipeline/fetch.ts");
    const rel = await registryReleases(MD);
    expect(rel).toEqual([
      { version: "14.2.0", date: "2026-06-01", url: "https://www.npmjs.com/package/markdown-it/v/14.2.0" },
      { version: "14.3.1", date: "2026-09-29", url: "https://www.npmjs.com/package/markdown-it/v/14.3.1" },
      { version: "15.0.1", date: "2026-09-30", url: "https://www.npmjs.com/package/markdown-it/v/15.0.1" },
    ]);
    // Cached as `publishDates` keeps it: the next read asks nothing; and release notes, when there are any, win.
    calls = [];
    expect(await advisoryReleases(MD, [])).toEqual(rel);
    expect(calls).toEqual([]);
    const notes = [{ version: "14.3.1", date: "2026-09-29", url: "https://github.com/x/y/releases/tag/14.3.1" }];
    expect(await advisoryReleases(MD, notes)).toBe(notes);
    // An ecosystem without the hooks: none (no advisories, as before).
    expect(await registryReleases({ ...MD, components: ["pkg:cargo/serde"] })).toEqual([]);
  });
});


describe("conditional release listings", () => {
  test("an unchanged head skips pagination but a daily reconciliation reads deeper pages", async () => {
    const rows = Array.from({ length: 100 }, () => gh("v30.0.0", "2026-07-28"));
    const requests: Array<{ url: string; etag: string | null }> = [];
    let unchanged = false;
    let backdated = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("registry.npmjs.org")) return Response.json({ name: "jsdom", time: NPM_TIME });
      const etag = new Headers(init?.headers).get("If-None-Match");
      requests.push({ url, etag });
      if (url.endsWith("page=1")) {
        if (unchanged && etag) return new Response(null, { status: 304 });
        return Response.json(rows, { headers: { etag: '"head-1"' } });
      }
      return Response.json(backdated ? [gh("v31.0.0", "2026-08-01")] : []);
    });
    await fetchReleases(JSDOM);
    expect(requests).toHaveLength(2);
    requests.length = 0;
    unchanged = true;
    const result = await fetchReleases(JSDOM, { refresh: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.etag).toBe('"head-1"');
    expect(result.notes).toHaveLength(1);
    expect(result.stats.newReleases).toBe(0);
    const path = join(dir, "releases", JSDOM.id, "index.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.listing.reconciled = new Date(Date.now() - 25 * 3600_000).toISOString();
    writeAtomic(path, JSON.stringify(index));
    requests.length = 0;
    backdated = true;
    expect((await fetchReleases(JSDOM, { refresh: true })).notes).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.etag).toBeNull();
  });

  test.each(["repository", "tags"])("changing %s discards the previous validator", async (change) => {
    const path = join(dir, "releases", JSDOM.id, "index.json");
    writeAtomic(path, JSON.stringify({ checked: new Date().toISOString(), tagPattern: JSDOM.tag.source,
      matched: true, releases: [stored("v30.0.0", "30.0.0", "2026-07-28")], listing: { repo: change === "repository" ? "previous/repo" : JSDOM.repo, etag: '"wrong"', reconciled: new Date().toISOString() } }));
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("If-None-Match")).toBe(false);
      return Response.json(url.includes("registry.npmjs.org") ? { name: "jsdom", time: NPM_TIME } : []);
    });
    await fetchReleases(change === "tags" ? { ...JSDOM, tag: /^v(\d+\.\d+\.\d+)$/ } : JSDOM, { refresh: true });
    expect(JSON.parse(readFileSync(path, "utf8")).listing).toBeUndefined();
  });
});
