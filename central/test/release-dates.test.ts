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
import type { Technology } from "../src/pipeline/technologies.ts";
import { sha256, writeAtomic } from "../src/pipeline/util.ts";

const JSDOM: Technology = { id: "jsdom-341360b0", name: "jsdom", repo: "jsdom/jsdom", components: ["pkg:npm/jsdom"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
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
