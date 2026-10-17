import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { attribute, guideMajor, markerIn } from "../src/docs/attribute.ts";
import { findNamespaces, llmsPages, RELEASE_NOTES } from "../src/docs/listing.ts";
import { extract, plan } from "../src/docs/extract.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { docsDir, readEvents, refresh } from "../src/docs/monitor.ts";
import { fetchGuides } from "../src/pipeline/fetch.ts";
import { compact, fenceFor, markViews, renderChange, unmarkQuote } from "../src/docs/render.ts";
import { editKind } from "../src/docs/materiality.ts";
import { parseRobots } from "../src/docs/robots.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
import { env, type TestEnv } from "./helpers.ts";

describe("robots.txt", () => {
  test("our group over *, longest match wins, Allow on a tie, wildcards and $", () => {
    const r = parseRobots(["User-agent: *", "Disallow: /", "", "User-agent: unstale-collector", "Disallow: /docs/api/", "Allow: /docs/api/public", "Disallow: /*.pdf$", "Sitemap: https://x.dev/sitemap.xml"].join("\n"));
    expect(r.allowed("https://x.dev/docs/intro")).toBe(true);
    expect(r.allowed("https://x.dev/docs/api/secret")).toBe(false);
    expect(r.allowed("https://x.dev/docs/api/public/a")).toBe(true);
    expect(r.allowed("https://x.dev/guide.pdf")).toBe(false);
    expect(r.allowed("https://x.dev/guide.pdf?x=1")).toBe(true);
    expect(r.sitemaps).toEqual(["https://x.dev/sitemap.xml"]);
  });

  test("without our group, the * group applies", () => {
    const r = parseRobots("User-agent: *\nDisallow: /docs/*?query=*\n");
    expect(r.allowed("https://x.dev/docs/a?query=1")).toBe(false);
    expect(r.allowed("https://x.dev/docs/a")).toBe(true);
  });
});

describe("namespaces", () => {
  const pages = (prefix: string, names: string[]) => names.map((n) => `${prefix}/${n}`);
  const names = ["intro", "install", "config", "api", "cli"];

  test("an older version mirroring the unversioned pages is excluded (Next.js /docs/15)", () => {
    const ns = findNamespaces([...pages("/docs", names), ...pages("/docs/15", names)], "16");
    expect(ns).toEqual([expect.objectContaining({ segment: "15", kept: false, mirror: 1 })]);
  });

  test("sibling versions keep the current major; a lone namespace is site structure (Prisma /docs/orm/v6, v7)", () => {
    const ns = findNamespaces([...pages("/docs/orm/v6", names), ...pages("/docs/orm/v7", names), ...pages("/docs/cli/v7", names)], "7");
    const kept = Object.fromEntries(ns.map((n) => [`${n.position}:${n.segment}`, n.kept]));
    expect(kept).toEqual({ "3:v6": false, "3:v7": true });
  });

  test("locales: English kept, translations excluded; ai, db and js are not locales", () => {
    const ns = findNamespaces([...pages("/en/5.2", names), ...pages("/fr/5.2", names), ...pages("/en/5.1", names), ...pages("/ai", names), ...pages("/db", names)], "5");
    const kept = Object.fromEntries(ns.map((n) => [`${n.kind}:${n.segment}`, n.kept]));
    expect(kept).toEqual({ "locale:en": true, "locale:fr": false, "version:5.1": false, "version:5.2": true });
  });

  test("release notes are not docs pages (the release pipeline owns them)", () => {
    expect(["/doc/build/changelog/unreleased_20/13641", "/docs/releases/5.1", "/docs/release-notes"].map((p) => RELEASE_NOTES.test(p))).toEqual([true, true, true]);
    expect(RELEASE_NOTES.test("/docs/guides/releasing-a-package")).toBe(false);
  });

  test("llms.txt .md links are copies of the page without the suffix", () => {
    expect(llmsPages("- [Controllers](https://docs.x.dev/controllers.md)\n- [Home](https://docs.x.dev/index.md)\n- [Elsewhere](https://y.dev/a.md)", "docs.x.dev")).toEqual([
      { url: "https://docs.x.dev/controllers", copy: "https://docs.x.dev/controllers.md" },
      { url: "https://docs.x.dev/", copy: "https://docs.x.dev/index.md" },
    ]);
  });
});

describe("attribution", () => {
  test("upgrade guides from the URL or, for an unnumbered guide page, its text; not migration feature pages", () => {
    expect(guideMajor("https://nextjs.org/docs/app/guides/upgrading/version-16")).toBe("16");
    expect(guideMajor("https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7")).toBe("7");
    expect(guideMajor("https://www.prisma.io/docs/orm/v7/prisma-migrate/getting-started")).toBeUndefined();
    expect(guideMajor("https://www.prisma.io/docs/orm/migrations/squashing")).toBeUndefined();
    expect(guideMajor("https://docs.nestjs.com/migration-guide", "# Migration guide\n\nThis article provides a set of guidelines for migrating from NestJS version 11 to version 12.")).toBe("12");
    expect(guideMajor("https://nextjs.org/docs/app/guides/upgrading/codemods", "upgrade to version 16")).toBeUndefined();
    expect(guideMajor("https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-miniflare-2")).toBeUndefined();
  });

  test("markers on added lines name the version; runtime versions above the current major are ignored", () => {
    expect(markerIn("+The `ignore` option was added in v15.2.")).toEqual({ version: "15.2.0", marker: "added in v15.2" });
    expect(markerIn(".. versionadded:: 5.1\n+.. versionadded:: 5.2")).toEqual({ version: "5.2.0", marker: "versionadded:: 5.2" });
    expect(markerIn("+Requires Node.js. Available since v20.9.0", undefined, "16")).toBeUndefined();
    expect(markerIn("-Added in v1.2")).toBeUndefined();
    expect(markerIn("-We use it since version 3.0.\n+It has been used since version 3.0.")).toBeUndefined();
    expect(markerIn("+Tracks errors since v2.4.1 of the SDK.", undefined, "12")).toBeUndefined();
    expect(markerIn("+Added in v11.1.", undefined, "12")).toEqual({ version: "11.1.0", marker: "Added in v11.1" });
    // A version the package never released (another product on a shared docs host) is not a marker; a minor counts
    // by its x.y.0 key (releasedVersions adds it for every minor).
    const released = new Set(["0.3.0", "1.2.0", "1.2.18", "16.4.0", "16.4.1"]);
    expect(markerIn("+Starting in v0.7, agents stream.", released, "1")).toBeUndefined();
    expect(markerIn("+Available in v16.4.", released, "16")).toEqual({ version: "16.4.0", marker: "Available in v16.4" });
  });

  test("marker, then guide, then namespace, then unknown", () => {
    const s = { path: ["A"], status: "modified" as const, hunks: "+New in 7.1: `omit`.", added: 1, removed: 0 };
    expect(attribute(s, { guideMajor: "7" })).toEqual({ by: "marker", version: "7.1.0", marker: "New in 7.1" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "7" })).toEqual({ by: "guide", version: "7.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "6", maxMajor: "7" })).toEqual({ by: "guide", version: "6.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "4", maxMajor: "7" })).toEqual({ by: "old-guide", version: "4.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "1", maxMajor: "0" })).toEqual({ by: "unreleased-guide", version: "1.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { namespaceMajor: "7" })).toEqual({ by: "namespace", line: "7" });
    expect(attribute({ ...s, hunks: "+text" }, {})).toEqual({ by: "unknown" });
  });
});

describe("edit kinds", () => {
  const k = (rem: string, add: string) => editKind({ hunks: [rem && `-${rem}`, add && `+${add}`].filter(Boolean).join("\n") });
  test("trivial edits are recognised", () => {
    expect(k("Use the  option.", "Use the option")).toBe("format");
    expect(k("See [the guide](/old).", "See [the guide](/new).")).toBe("link");
    expect(k("Defined in: [retryer.ts:91](https://x/retryer.ts#L91)", "Defined in: [retryer.ts:120](https://x/retryer.ts#L120)")).toBe("renumber");
    expect(k("This is teh option for caching.", "This is the option for caching.")).toBe("typo");
    expect(k("We can obtain a reference to any instance from the standalone object.", "The standalone object lets you get a reference to any instance at all.")).toBe("reword");
  });
  test("meaning-flipping words, versions and technical tokens are always substantive", () => {
    expect(k("The cache is enabled by default.", "The cache is disabled by default.")).toBe("substantive");
    expect(k("Requires Node.js 18.18 or later.", "Requires Node.js 20.9 or later.")).toBe("substantive");
    expect(k("Node 20 required.", "Node 22 required.")).toBe("substantive");
    expect(k("| Server Actions | 100.0% 208/208 passed |", "| Server Actions | 100.0% 218/218 passed |")).toBe("renumber");
    expect(k("Pass the `cache` option.", "Pass the `revalidate` option.")).toBe("substantive");
    expect(k("", "Seeding no longer runs automatically after migrate dev; run prisma db seed yourself.")).toBe("substantive");
    expect(k("Вы можете использовать ловушку здесь.", "Вы можете использовать хук здесь.")).toBe("substantive");
    expect(k("Prisma ORM 8 is the current release.", "Prisma ORM 8 is a release candidate.")).toBe("substantive");
    expect(k("<span>hello</span><em>world</em>", '<span>hello</span>{" "}<em>world</em>')).toBe("substantive");
    expect(editKind({ hunks: "+<AppOnly>\n ## React 19.2\n+</AppOnly>" })).toBe("format");
  });
});

describe("render", () => {
  test("word-marked rendering drops line-number headers and tells the model to extract only changes", () => {
    const out = renderChange("https://x.dev/a", "modified", [{ path: ["A"], status: "modified", hunks: "@@ -1,2 +1,2 @@\n ctx\n-timeout is 10 s by default here\n+timeout is 30 s by default here\n@@ -9 +9 @@\n+new line", added: 2, removed: 1 }], { words: true });
    expect(out).toContain("~timeout is [-10-]{+30+} s by default here");
    expect(out).not.toContain("@@");
    expect(out).toContain("…\n+new line");
    expect(out).toContain("Emit records only for what changed");
    expect(compact("@@ -1 +1 @@\n+x")).toBe("+x");
  });

  test("quotes from word-marked notes are page text, grounded in the text after or before the change", () => {
    expect(unmarkQuote("[-turbopackFileSystemCache-]")).toBe("turbopackFileSystemCache");
    expect(unmarkQuote("timeout defaults to [-10-]{+30+} s")).toBe("timeout defaults to 30 s");
    expect(unmarkQuote("~Use `cache`")).toBe("Use `cache`");
    const v = markViews("~timeout defaults to [-10-]{+30+} s");
    expect([v.after, v.before]).toEqual(["~timeout defaults to 30 s", "~timeout defaults to 10 s"]);
  });

  test("the fence is longer than any backtick run in the page, so page text cannot close it", () => {
    const hunks = "+```js\n+code\n+```\n+```` nested";
    expect(fenceFor(hunks)).toBe("`````");
    const out = renderChange("https://x.dev/a", "modified", [{ path: ["A", "B"], status: "modified", hunks, added: 4, removed: 0 }]);
    expect(out).toContain("Section: A > B (modified)\n`````diff\n");
    expect(out).toContain("untrusted data");
  });
});

describe("monitor", () => {
  let e: TestEnv;
  let dir: string;
  let saved: string | undefined;
  beforeEach(async () => {
    e = await env();
    dir = await mkdtemp(join(tmpdir(), "unstale-docs-"));
    saved = process.env.UNSTALE_CENTRAL_DIR;
    process.env.UNSTALE_CENTRAL_DIR = dir;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
    else process.env.UNSTALE_CENTRAL_DIR = saved;
    await e.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("guides come from the docs module: current and previous major only, ingested whole once, other pages not fetched", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const site: Record<string, string> = {
      "/docs/intro": html("<h1>Intro</h1><p>Hello.</p>"),
      "/docs/upgrading/version-1": html("<h1>Upgrading to 1</h1><p>Old.</p>"),
      "/docs/upgrading/version-3": html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 22 required.</p>"),
      "/docs/migration-guide": html("<h1>Migration guide</h1><p>Migrating from version 1 to version 2.</p>"),
    };
    const hits = new Map<string, number>();
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${Object.keys(site).map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    for (const p of Object.keys(site)) e.route(p, (_q, r) => { hits.set(p, (hits.get(p) ?? 0) + 1); r.writeHead(200, { "content-type": "text/html" }).end(site[p]); });
    writeAtomic(join(docsDir("g"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/g"],
      resolutions: [{ purl: "pkg:generic/g", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 4, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const tech = { id: "g", name: "G", repo: "", components: ["pkg:generic/g"], tag: /^v(.*)$/, clean: (b: string) => b };
    const first = await fetchGuides(tech, [{ version: "3.0.0", date: "2026-01-01" }], { refresh: true, http });
    expect(first.map((g) => [new URL(g.url).pathname, g.version, g.kind])).toEqual([["/docs/upgrading/version-3", "3.0.0", "upgrade_guide"], ["/docs/migration-guide", "2.0.0", "upgrade_guide"]]);
    expect(first[0]!.notes).toContain("Node 22 required.");
    const sampled = hits.get("/docs/intro") ?? 0; // the site's copy rule is learned once from a few sampled pages
    // An edited guide is not re-ingested whole: its first snapshot stays the source; edits arrive as section notes.
    site["/docs/upgrading/version-3"] = html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 24 required.</p>");
    const second = await fetchGuides(tech, [], { refresh: true, http });
    expect(second.map((g) => g.snapshot)).toEqual(first.map((g) => g.snapshot));
    expect(hits.get("/docs/intro") ?? 0).toBe(sampled); // a guides-only check fetches no other page
    // A legacy entry from the table-driven path (a repository file) is history, not a source.
    const ip = join(dir, "guides", "g", "index.json");
    const index = JSON.parse(readFileSync(ip, "utf8"));
    index.guides.push({ ...index.guides[0], url: "https://github.com/o/r/blob/abc/docs/upgrading/version-3.md", repo: "o/r", path: "docs/upgrading/version-3.md", commit: "abc" });
    writeAtomic(ip, JSON.stringify(index));
    expect((await fetchGuides(tech, [], { offline: true })).map((g) => new URL(g.url).hostname)).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  test("a page budget checks new pages first, then the least recently checked; guides always", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const paths = ["/docs/a", "/docs/b", "/docs/c", "/docs/d", "/docs/upgrading/version-3"];
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    for (const p of paths) e.route(p, (_q, r) => { r.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>${p}</h1><p>Text.</p>`)); });
    writeAtomic(join(docsDir("b"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/b"],
      resolutions: [{ purl: "pkg:generic/b", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 5, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "b", purls: ["pkg:generic/b"] };
    const checkedOn = (day: number) => refresh(src, { http, budget: 2, now: () => new Date(Date.UTC(2026, 9, day)) }).then(() => {
      const st = JSON.parse(readFileSync(join(docsDir("b"), "state.json"), "utf8"));
      return Object.entries<{ checked?: string }>(st.pages).filter(([, p]) => p.checked === new Date(Date.UTC(2026, 9, day)).toISOString()).map(([u]) => new URL(u).pathname).sort();
    });
    expect(await checkedOn(1)).toEqual(["/docs/a", "/docs/b", "/docs/upgrading/version-3"]);
    expect(await checkedOn(2)).toEqual(["/docs/c", "/docs/d", "/docs/upgrading/version-3"]);
    expect(await checkedOn(3)).toEqual(["/docs/a", "/docs/b", "/docs/upgrading/version-3"]);
  });

  test("baseline, then created, modified, deleted, moved and attributed sections; a rerun adds nothing", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const site: Record<string, { status: number; body?: string; location?: string }> = {
      "/docs/a": { status: 200, body: html("<h1>A</h1><h2>Options</h2><p>timeout defaults to 10 s.</p>") },
      "/docs/b": { status: 200, body: html("<h1>B</h1><h2>Usage</h2><p>Call b() once.</p><p>Then call c().</p>") },
      "/docs/old": { status: 200, body: html("<h1>Old</h1><h2>Legacy</h2><p>Use legacy() here.</p>") },
      "/docs/upgrading/version-3": { status: 200, body: html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 20 required.</p>") },
      "/docs/migration": { status: 200, body: html("<h1>Migration</h1><p>Migrating from version 2 to version 3.</p>") },
    };
    let listed = ["/docs/a", "/docs/b", "/docs/old", "/docs/upgrading/version-3", "/docs/migration"];
    const sitemap = () => `<?xml version="1.0"?><urlset>${listed.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`;
    e.route("/sitemap.xml", (_q, s) => void s.writeHead(200, { "content-type": "application/xml" }).end(sitemap()));
    for (const p of [...Object.keys(site), "/docs/new", "/docs/b2"]) {
      e.route(p, (_q, s) => {
        const x = site[p];
        if (!x) return void s.writeHead(404).end();
        if (x.location) return void s.writeHead(x.status, { location: x.location }).end();
        s.writeHead(x.status, { "content-type": "text/html" }).end(x.body ?? "");
      });
    }
    writeAtomic(join(docsDir("t"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/t"],
      resolutions: [{ purl: "pkg:generic/t", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 4, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "t", purls: ["pkg:generic/t"] };

    const first = await refresh(src, { http });
    expect(first).toMatchObject({ baseline: true, checked: 5, events: {} });

    site["/docs/a"]!.body = html("<h1>A</h1><h2>Options</h2><p>timeout defaults to 30 s. Added in v2.1.</p>");
    site["/docs/new"] = { status: 200, body: html("<h1>New</h1><h2>Streaming</h2><p>Use stream().</p>") };
    delete site["/docs/old"];
    site["/docs/b2"] = { status: 200, body: html("<h1>B</h1><h2>Usage</h2><p>Call b() once.</p><p>Then call d().</p>") };
    site["/docs/b"] = { status: 301, location: `${e.base}/docs/b2` };
    site["/docs/upgrading/version-3"]!.body = html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 22 required.</p>");
    listed = ["/docs/a", "/docs/b2", "/docs/new", "/docs/upgrading/version-3", "/docs/migration"];

    const second = await refresh(src, { http });
    expect(second.events).toEqual({ created: 1, deleted: 1, moved: 1, modified: 2 });
    const byKind = Object.fromEntries(readEvents("t").map((x) => [`${x.kind} ${new URL(x.url).pathname}`, x]));
    expect(byKind["modified /docs/a"]!.sections).toEqual([expect.objectContaining({ path: ["A", "Options"], attribution: { by: "marker", version: "2.1.0", marker: "Added in v2.1" } })]);
    expect(byKind["modified /docs/upgrading/version-3"]!.sections![0]!.attribution).toEqual({ by: "guide", version: "3.0.0" });
    expect(byKind["created /docs/new"]!.sections!.map((s) => s.attribution.by)).toEqual(["unknown", "unknown"]);
    expect(byKind["deleted /docs/old"]!.sections!.map((s) => s.status)).toEqual(["removed", "removed"]);
    expect(byKind["moved /docs/b"]).toMatchObject({ to: `${e.base}/docs/b2`, sections: [expect.objectContaining({ path: ["B", "Usage"], status: "modified" })] });

    // Extraction gets the versioned sections only, one note per version; the rest are held.
    const p = await plan("t");
    expect(p.notes.map((n) => [new URL(n.note.url).pathname, n.note.version, n.sections])).toEqual([["/docs/upgrading/version-3", "3.0.0", 1], ["/docs/a", "2.1.0", 1]]);
    expect(p.notes[1]!.note.notes).toContain("~timeout defaults to [-10-]{+30+} s.{+ Added in v2.1.+}");
    expect(p.held).toEqual({ unknown: 5 });
    expect(p.settled).toHaveLength(3); // created, deleted and moved: held sections only, so never diffed again
    expect((await plan("t", { context: 3, words: false })).notes[1]!.note.notes).toContain("-timeout defaults to 10 s.");
    // The budget sees each note's measured text before any model call; a refusal stops there and the notes stay planned.
    const seen: string[] = [];
    const refused = await extract({ id: "t", name: "T", components: ["pkg:generic/t"] } as unknown as Technology, Infinity, undefined, (text) => (seen.push(text), false));
    expect(refused).toMatchObject({ notes: 0, stopped: true });
    expect(seen).toEqual([p.notes[0]!.note.notes]);
    expect((await plan("t")).notes).toHaveLength(2);

    const third = await refresh(src, { http });
    expect(third.events).toEqual({});
    // The unnumbered guide's major, read from its text on first sight, survives later refreshes.
    const state = JSON.parse(readFileSync(join(docsDir("t"), "state.json"), "utf8"));
    expect(state.pages[`${e.base}/docs/migration`].guideMajor).toBe("3");
    expect(readEvents("t")).toHaveLength(5);
  });
});
