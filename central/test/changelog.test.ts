// Release notes outside GitHub release bodies (changelog.ts, fetch.ts): changelog files read per version, pointer
// bodies read through their link, and release-please monorepo tags. Fixtures are trimmed copies of the live sources
// (18 October 2026): qs, markdown-it, Express-style setext, vite, react-router, TypeScript, Cypress.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linkedReleaseText, headingVersion, pickChangelog, pointerLinks, repoFileLink, sectionFor, versionSections } from "../src/pipeline/changelog.ts";
import { articleToMarkdown } from "../src/collector/extract.ts";
import { releasePattern } from "../src/onboarding/discovery.ts";
import { reconcileLinkedEvidence, reconcileSources } from "../src/onboarding/source-quality.ts";
import { sha256 } from "../src/pipeline/util.ts";
import type { ReleaseNote } from "../src/pipeline/fetch.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import type { TechStore } from "../src/pipeline/store.ts";
import { HttpClient } from "../src/collector/http.ts";

describe("changelog sections", () => {
  test("one section per version, in each format met", () => {
    const qs = "## **6.16.1**\n- [Fix] `parse`: do not mutate an object input\n\n## **6.16.0**\n- [New] `stringify`: add a `depth` option\n";
    expect(versionSections(qs).map((s) => [s.version, s.text.split("\n").length])).toEqual([["6.16.1", 2], ["6.16.0", 2]]);
    const md = "# Changelog\n\nAll notable changes.\n\n## [15.0.3] - 2026-10-16\n\n### Fixed\n\n- linkify fix\n\n## [15.0.2] - 2026-09-01\n\n### Changed\n\n- x\n";
    expect(sectionFor(md, "15.0.3")?.text).toBe("## [15.0.3] - 2026-10-16\n\n### Fixed\n\n- linkify fix");
    const setext = "5.1.0 / 2025-03-31\n==================\n\n  * Add support for `Uint8Array`\n\n5.0.1 / 2024-10-08\n==========\n\n  * Update deps\n";
    expect(versionSections(setext).map((s) => s.version)).toEqual(["5.1.0", "5.0.1"]);
    const vite = "## <small>[8.2.4](https://github.com/vitejs/vite/compare/v8.2.3...v8.2.4) (2026-10-06)</small>\n\n## <small>8.2.3 (2026-10-06)</small>\n### Bug Fixes\n* fix\n";
    expect(versionSections(vite).map((s) => s.version)).toEqual(["8.2.4", "8.2.3"]);
    expect(sectionFor(vite, "8.2.3")?.text).toContain("* fix");
    const rr = "# React Router Releases\n\n- [v8.4.0](#v840)\n\n## v8.4.0\n\nDate: 2026-09-15\n\n### What's Changed\n\n#### Reduced Route Component Re-renders\n\nbody\n\n## v8.3.1\n\nother\n";
    expect(sectionFor(rr, "8.4.0")?.text).toContain("#### Reduced Route Component Re-renders\n\nbody");
    expect(sectionFor(rr, "8.4.0")?.text).not.toContain("other");
  });

  test("a prerelease or a longer number is not the version; code fences hold no headings", () => {
    expect(headingVersion("9.0.0-beta.1")).toBeUndefined();
    expect(headingVersion("v1.2.30")).toBe("1.2.30");
    expect(headingVersion("[6.4.4](https://github.com/x/y/compare/v6.4.3...v6.4.4) (2026-10-06)")).toBe("6.4.4");
    expect(versionSections("```\n# 1.0.0\n```\n## 2.0.0\nx\n").map((s) => s.version)).toEqual(["2.0.0"]);
  });

  test("the changelog file among a directory's names", () => {
    expect(pickChangelog(["README.md", "History.md", "CHANGELOG.md", "package.json"])).toBe("CHANGELOG.md");
    expect(pickChangelog(["README.md", "History.md"])).toBe("History.md");
    expect(pickChangelog(["CHANGELOG.old.md", "src"])).toBeUndefined();
  });
});

test("rolling release pages select minor-version headings without changing strict changelog parsing", () => {
  const page = "# What's New\n\n## deck.gl v9.4\u200b\nFuture change\n\n## deck.gl v9.3\u200b\nCorrect change\n### Layers\nLayer change\n\n## deck.gl v9.2\nOld change";
  expect(linkedReleaseText(page, "9.3.0")).toBe("## deck.gl v9.3\u200b\nCorrect change\n### Layers\nLayer change");
  expect(linkedReleaseText(page, "9.3.1")).toContain("Correct change");
  expect(linkedReleaseText(page, "9.1.0")).toBe("");
  expect(versionSections(page)).toEqual([]);
  expect(linkedReleaseText("## deck.gl v9.4\n" + "Future change. ".repeat(60), "9.3.0")).toBe("");
  expect(linkedReleaseText("## v9.3.1\nPatch-only change", "9.3.2")).toBe("");
  const exact = page + "\n## 9.3.1\nPatch-only change";
  expect(linkedReleaseText(exact, "9.3.1")).toBe("## 9.3.1\nPatch-only change");
  expect(linkedReleaseText("# Announcing TypeScript 6.0\nOne announcement", "6.0.2")).toContain("One announcement");
  expect(versionSections("## 9.3.0-beta.1\nx\n## 9.3.1-rc.1\ny", true)).toEqual([]);
});

describe("pointer release bodies", () => {
  test("a body that only links its notes is a pointer; release notes are not", () => {
    expect(pointerLinks("See the changelog for release notes: https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v840")).toEqual([
      "https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v840",
    ]);
    expect(pointerLinks("Please refer to [CHANGELOG.md](https://github.com/vitejs/vite/blob/v6.4.4/packages/vite/CHANGELOG.md) for details.")).toHaveLength(1);
    const ts =
      "For release notes, check out the [release announcement blog post](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/).\n\n" +
      "* [fixed issues query for TypeScript 6.0.0 (Beta)](https://github.com/Microsoft/TypeScript/issues?q=milestone%3A%22TypeScript+6.0.0%22).\n" +
      "* [fixed issues query for TypeScript 6.0.1 (RC)](https://github.com/Microsoft/TypeScript/issues?q=milestone%3A%22TypeScript+6.0.1%22).\n" +
      "* [fixed issues query for TypeScript 6.0.2 (Stable)](https://github.com/Microsoft/TypeScript/issues?q=milestone%3A%22TypeScript+6.0.2%22).\n\n" +
      "Downloads are available on:\n* [npm](https://www.npmjs.com/package/typescript)";
    expect(pointerLinks(ts)).toEqual(["https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/"]);
    expect(pointerLinks("https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/\r\n\r\nThis tag was originally released at: https://github.com/microsoft/typescript-go/releases/tag/typescript%2Fv7.0.2")).toEqual([
      "https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/",
    ]);
    // Terse release notes whose links are issues, pulls and commits only.
    expect(pointerLinks("### Bug Fixes\n\n* **deps:** update launch-editor to v2.14.2 ([#23654](https://github.com/vitejs/vite/issues/23654)) ([22fd1d5](https://github.com/vitejs/vite/commit/22fd1d5))")).toEqual([]);
    expect(pointerLinks("## [25.14.0](https://github.com/puppeteer/puppeteer/compare/puppeteer-v25.13.0...puppeteer-v25.14.0) (2026-10-14)")).toEqual([]);
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ") + " https://example.com/notes";
    expect(pointerLinks(long)).toEqual([]);
  });

  test("a repository file link names its raw copy", () => {
    expect(repoFileLink("https://github.com/vitejs/vite/blob/v6.4.4/packages/vite/CHANGELOG.md")).toEqual({
      repo: "vitejs/vite",
      ref: "v6.4.4",
      path: "packages/vite/CHANGELOG.md",
      raw: "https://raw.githubusercontent.com/vitejs/vite/v6.4.4/packages/vite/CHANGELOG.md",
    });
    expect(repoFileLink("https://github.com/vitejs/vite/blob/main/src/index.ts")).toBeUndefined();
  });

  test("an announcement page is read as its post, not its comments or cards", () => {
    const post = "<p>" + "TypeScript 6.0 deprecates baseUrl. ".repeat(60) + "</p>";
    const html = `<html><body><main><aside>Author card</aside><article id="post"><h1>Announcing TypeScript 6.0</h1><div class="entry-content sharepostcontent">${post}</div>
      <article class="comment"><p>Nice!</p></article></article><article><h3>Announcing TypeScript 7.0 Beta</h3></article></main></body></html>`;
    const text = articleToMarkdown(html);
    expect(text).toContain("# Announcing TypeScript 6.0");
    expect(text).toContain("deprecates baseUrl");
    expect(text).not.toContain("Author card");
  });
});

test("release-please monorepo tags: `<name>-v<version>`, never a sibling's", () => {
  const tag = new RegExp(releasePattern("pkg:npm/puppeteer", "puppeteer/puppeteer"));
  expect(tag.exec("puppeteer-v25.14.0")?.[1]).toBe("25.14.0");
  expect(tag.exec("v25.14.0")?.[1]).toBe("25.14.0");
  expect(tag.test("puppeteer-core-v25.14.0")).toBe(false);
  expect(tag.test("browsers-v3.2.5")).toBe(false);
  const scoped = new RegExp(releasePattern("pkg:npm/%40mui/material", "mui/material-ui", "packages/mui-material"));
  expect(scoped.test("v9.5.0")).toBe(false);
  expect(scoped.exec("@mui/material@9.5.0")?.[1]).toBe("9.5.0");
});

test("records from a changelog section keep their evidence; another repository's file does not", () => {
  const t: Technology = { id: "qs", name: "qs", repo: "ljharb/qs", components: ["pkg:npm/qs"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
  const rec = (id: string, url: string) => ({ id, status: "active", evidence: [{ kind: "release_notes", url }], releases: [{ version: "6.16.0", line: "6" }], revision: 1, history: [], label_version: 1 });
  const store = {
    technology: "qs",
    records: {
      "qs:a": rec("qs:a", "https://github.com/ljharb/qs/blob/0123abc/CHANGELOG.md#6160"),
      "qs:b": rec("qs:b", "https://github.com/other/qs/blob/0123abc/CHANGELOG.md#6160"),
      "qs:c": rec("qs:c", "https://github.com/ljharb/qs/blob/0123abc/README.md"),
    },
    ingested: {},
  } as unknown as TechStore;
  const prevDir = process.env.UNSTALE_CENTRAL_DIR;
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-reconcile-"));
  try {
    expect(reconcileSources(t, store)).toBe(2);
  } finally {
    if (prevDir === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
    else process.env.UNSTALE_CENTRAL_DIR = prevDir;
  }
  expect(store.records["qs:a"]!.status).toBe("active");
  expect(store.records["qs:b"]!.status).toBe("retracted");
  expect(store.records["qs:c"]!.status).toBe("retracted");
});

describe("fetchReleases through changelogs and links", () => {
  let dir: string;
  const prev = { dir: process.env.UNSTALE_CENTRAL_DIR, token: process.env.GITHUB_TOKEN };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unstale-changelog-"));
    process.env.UNSTALE_CENTRAL_DIR = dir;
    process.env.GITHUB_TOKEN = "test-token";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [k, v] of [["UNSTALE_CENTRAL_DIR", prev.dir], ["GITHUB_TOKEN", prev.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  /** GitHub's release list through `fetch`; everything else (API, raw files, pages, registry) through the polite
   * client, which the docs fetcher and the registry hooks use. */
  function serve(releases: unknown[], routes: Record<string, unknown>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://api.github.com/") && url.includes("/releases?")) return new Response(JSON.stringify(url.includes("page=1") ? releases : []));
      const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
      return hit ? new Response(typeof hit[1] === "string" ? hit[1] : JSON.stringify(hit[1])) : new Response("not found", { status: 404 });
    });
    vi.spyOn(HttpClient.prototype, "get").mockImplementation(async (url: string) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.startsWith(k) && !url.slice(k.length).startsWith("/"));
      const exact = hit ?? Object.entries(routes).find(([k]) => url === k);
      if (!exact) {
        const { FetchFailure } = await import("../src/collector/http.ts");
        throw new FetchFailure("http_status", "HTTP 404", 404);
      }
      const v = exact[1];
      return { status: 200, finalUrl: url, headers: new Headers(), body: Buffer.from(typeof v === "string" ? v : JSON.stringify(v)) };
    });
    return calls;
  }
  const gh = (repo: string, tag: string, day: string, body: string) => ({ tag_name: tag, published_at: `${day}T12:00:00Z`, prerelease: false, draft: false, body, html_url: `https://github.com/${repo}/releases/tag/${tag}` });

  test("a package with no GitHub release is read from its changelog, one note per published version in the window", async () => {
    const { fetchReleases } = await import("../src/pipeline/fetch.ts");
    const qs: Technology = { id: "qs-a0a4cdbf", name: "qs", repo: "ljharb/qs", components: ["pkg:npm/qs"], tag: /^(?:qs@|v?)(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const file = "## **6.16.1**\n- [Fix] `parse`: do not mutate an object input\n\n## **6.16.0**\n- [New] `stringify`: add a `depth` option\n\n## **6.13.0**\n- [New] old\n\n## **6.17.0**\n- not published yet\n";
    const calls = serve([], {
      "https://api.github.com/repos/ljharb/qs/contents/": [{ name: "CHANGELOG.md", type: "file" }, { name: "README.md", type: "file" }],
      "https://api.github.com/repos/ljharb/qs/commits?path=CHANGELOG.md&per_page=1": [{ sha: "c0ffee" }],
      "https://raw.githubusercontent.com/ljharb/qs/c0ffee/CHANGELOG.md": file,
      "https://registry.npmjs.org/qs": { time: { "6.13.0": "2024-07-01T00:00:00Z", "6.16.0": "2026-08-01T00:00:00Z", "6.16.1": "2026-10-01T00:00:00Z" } },
    });
    const { notes } = await fetchReleases(qs);
    expect(notes.map((n) => [n.version, n.date, n.tag, n.url])).toEqual([
      ["6.16.0", "2026-08-01", "CHANGELOG.md@6.16.0", "https://github.com/ljharb/qs/blob/c0ffee/CHANGELOG.md#6160"],
      ["6.16.1", "2026-10-01", "CHANGELOG.md@6.16.1", "https://github.com/ljharb/qs/blob/c0ffee/CHANGELOG.md#6161"],
    ]);
    expect(notes[1]!.notes).toContain("do not mutate an object input");
    // Stored: read again inside the window, nothing is requested.
    calls.length = 0;
    expect((await fetchReleases(qs)).notes).toHaveLength(2);
    expect(calls).toEqual([]);
  });

  test("cached rolling pages are narrowed offline, with new snapshot keys and the old evidence snapshot identified", async () => {
    const { fetchReleases } = await import("../src/pipeline/fetch.ts");
    const t: Technology = { id: "rolling", name: "rolling", repo: "owner/rolling", components: [], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const page = "# What's New\n## rolling v9.4\n" + "Future change. ".repeat(40) + "\n## rolling v9.3\n" + "Correct change. ".repeat(3) + "\n## rolling v9.2\n" + "Old change. ".repeat(40);
    const body = "See [What's New](https://rolling.dev/whats-new) for details.";
    serve([gh(t.repo, "v9.3.0", "2026-04-13", body), gh(t.repo, "v9.4.0", "2026-09-05", body)], {
      "https://api.github.com/repos/owner/rolling": { homepage: "https://rolling.dev" },
      "https://api.github.com/users/owner": { blog: "https://rolling.dev" },
      "https://rolling.dev/whats-new": page,
    });
    const initial = await fetchReleases(t);
    expect(initial.notes.find((n) => n.version === "9.3.0")!.notes).toContain("Correct change");
    expect(initial.notes.find((n) => n.version === "9.3.0")!.notes).not.toContain("Future change");
    expect(initial.notes.find((n) => n.version === "9.4.0")!.notes).toContain("Future change");
    // Simulate the saved format before minor headings were understood.
    const idx = join(dir, "releases", t.id, "index.json");
    const stored = JSON.parse(readFileSync(idx, "utf8"));
    const old = stored.releases.find((r: { version: string }) => r.version === "9.3.0");
    old.linked.snapshot = `sha256:${sha256(page)}`;
    writeFileSync(join(dir, "releases", t.id, "9.3.0.linked.md"), page);
    writeFileSync(idx, JSON.stringify(stored));
    const fetched = await fetchReleases(t, { offline: true });
    const note = fetched.notes.find((n) => n.version === "9.3.0")!;
    expect(fetched.stats.requests).toBe(0);
    expect(note.notes).toContain("Correct change");
    expect(note.notes).not.toContain("Future change");
    expect(note.notes).not.toContain("Old change");
    expect(note.supersededSnapshot).toBe(`sha256:${sha256(`${old.snapshot}\n${old.linked.snapshot}`)}`);
    expect(note.snapshot).not.toBe(note.supersededSnapshot);
    expect(note.keyTag).not.toContain(old.linked.snapshot.slice(7, 15));
  });

  test("a pointer body is read through its link: the version's section of the repository's changelog", async () => {
    const { fetchReleases } = await import("../src/pipeline/fetch.ts");
    const rr: Technology = { id: "react-router", name: "react-router", repo: "remix-run/react-router", components: ["pkg:npm/react-router"], tag: /^(?:react-router@|v?)(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const body = "See the changelog for release notes: https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v840";
    serve([gh("remix-run/react-router", "react-router@8.4.0", "2026-09-15", body), gh("remix-run/react-router", "react-router@8.3.1", "2026-08-28", "### Patch Changes\n\n- a real note with enough words to be the release notes itself, " + "and more words ".repeat(12))], {
      "https://raw.githubusercontent.com/remix-run/react-router/main/CHANGELOG.md": "# React Router Releases\n\n## v8.4.0\n\nDate: 2026-09-15\n\n### What's Changed\n\nReduced route component re-renders: four internal contexts.\n\n## v8.3.1\n\nolder\n",
    });
    const { notes } = await fetchReleases(rr);
    const n840 = notes.find((n) => n.version === "8.4.0")!;
    expect(n840.notes).toContain(body);
    expect(n840.notes).toContain("Release notes linked from this release (https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v840)");
    expect(n840.notes).toContain("four internal contexts");
    expect(n840.notes).not.toContain("older");
    // The snapshot covers the linked text, so a release extracted from its bare pointer before is extracted again.
    const index = JSON.parse(readFileSync(join(dir, "releases", rr.id, "index.json"), "utf8"));
    const stored = index.releases.find((r: { version: string }) => r.version === "8.4.0");
    expect(n840.snapshot).not.toBe(stored.snapshot);
    expect(n840.keyTag).toBe(`+linked.${stored.linked.snapshot.slice(7, 15)}`);
    expect(notes.find((n) => n.version === "8.3.1")!.notes).not.toContain("linked from");
  });

  test("a page on the publisher's site is read whole once; another site never", async () => {
    const { fetchReleases } = await import("../src/pipeline/fetch.ts");
    const ts: Technology = { id: "typescript", name: "typescript", repo: "microsoft/TypeScript", components: ["pkg:npm/typescript"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const post = `<html><body><article><h1>Announcing TypeScript 6.0</h1><p>${"The baseUrl option is deprecated. ".repeat(40)}</p></article></body></html>`;
    serve(
      [
        gh("microsoft/TypeScript", "v6.0.3", "2026-04-16", "For release notes, check out the [release announcement blog post](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)."),
        gh("microsoft/TypeScript", "v6.0.2", "2026-03-23", "For release notes, check out the [release announcement blog post](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/)."),
        gh("microsoft/TypeScript", "v6.0.1", "2026-03-10", "Release notes: [elsewhere](https://notes.example.org/ts-6-0-1)"),
      ],
      {
        "https://api.github.com/repos/microsoft/TypeScript": { homepage: "https://www.typescriptlang.org" },
        "https://api.github.com/users/microsoft": { blog: "https://opensource.microsoft.com" },
        "https://devblogs.microsoft.com/robots.txt": "User-agent: *\nAllow: /\n",
        "https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/": post,
        "https://notes.example.org/ts-6-0-1": post,
      },
    );
    const { notes } = await fetchReleases(ts);
    const by = Object.fromEntries(notes.map((n) => [n.version, n.notes]));
    expect(by["6.0.2"]).toContain("The baseUrl option is deprecated.");
    // The later release linking the same post is its own body only: the post is extracted once.
    expect(by["6.0.3"]).not.toContain("deprecated");
    expect(by["6.0.1"]).not.toContain("deprecated");
  });
});

test("linked-page repair retracts only unsupported old-snapshot records and preserves independent evidence", () => {
  const t = { id: "rolling", components: [] } as unknown as Technology;
  const note = { url: "https://github.com/owner/rolling/releases/tag/v9.3.0", supersededSnapshot: "old", notes: "Correct change" } as ReleaseNote;
  const evidence = (quote: string, snapshot = "old") => ({ kind: "release_notes", url: note.url, quote, snapshot });
  const rec = (id: string, ev: object[]) => ({ id, status: "active", releases: [{ version: "9.3.0", line: "9" }], evidence: ev, related: [], revision: 1, label_version: 1, history: [] });
  const store = { technology: t.id, records: {
    wrong: rec("wrong", [evidence("Old change")]),
    valid: rec("valid", [evidence("Correct change")]),
    other: rec("other", [evidence("Old change", "independent-snapshot")]),
    mixed: rec("mixed", [evidence("Old change"), { ...evidence("independent"), kind: "upgrade_guide" }]),
    related: { ...rec("related", [evidence("Correct change")]), related: ["wrong"] },
  }, ingested: { oldKey: "wrong", validKey: "valid" } } as unknown as TechStore;
  const oldDir = process.env.UNSTALE_CENTRAL_DIR;
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-linked-repair-"));
  try {
    expect(reconcileLinkedEvidence(t, [note], store)).toBe(2);
    expect(store.records.wrong!.status).toBe("retracted");
    expect(store.records.valid!.status).toBe("active");
    expect(store.records.other!.status).toBe("active");
    expect(store.records.mixed!.evidence).toHaveLength(1);
    expect(store.records.mixed!.status).toBe("active");
    expect(store.records.related!.related).toEqual([]);
    expect(store.ingested.oldKey).toBeUndefined();
    expect(store.ingested.validKey).toBe("valid");
    expect(reconcileLinkedEvidence(t, [note], store)).toBe(0);
  } finally {
    if (oldDir === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
    else process.env.UNSTALE_CENTRAL_DIR = oldDir;
  }
});
