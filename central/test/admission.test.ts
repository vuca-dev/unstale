// Admission rules (eval/scope/RESULTS.md): release-based freshness, stars for the repository's main package only,
// archived repositories, deprecated packages with a notice, type stubs parked; unreadable signals fail open.
import { describe, expect, test, vi } from "vitest";
import { admit, endedIn, fromCargo, lineRepos, signals, withLifecycle, fromGithub, fromNpm, fromPypi, repoShare, THRESHOLDS, typedPackage, type Signals } from "../src/pipeline/admission.ts";

const NOW = Date.parse("2026-10-16T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const npm = (over: Partial<Signals> = {}): Signals => ({ purl: "pkg:npm/left-pad", lastRelease: daysAgo(30), downloads: 5_000, stars: 50, ...over });
const verdict = (s: Signals) => admit(s, THRESHOLDS.npm, NOW);
const cargoSignals = (over: Partial<Signals> = {}): Signals => ({
  purl: "pkg:cargo/example-crate",
  lastRelease: daysAgo(30),
  downloads: 9_999,
  stars: 0,
  archived: false,
  deprecated: undefined,
  repoShare: undefined,
  lastCommit: undefined,
  ...over,
});
const cargoVerdict = (s: Signals) => admit(s, THRESHOLDS.cargo, NOW);

describe("freshness by release", () => {
  test("a release inside the window passes; outside it parks even with a recent push", () => {
    expect(verdict(npm()).rule).toBe("used");
    const v = verdict(npm({ lastRelease: daysAgo(400), lastCommit: daysAgo(2) }));
    expect(v).toMatchObject({ admit: false, rule: "stale", why: "no release in 365 days" });
  });
  test("the push counts only when no release date is readable", () => {
    expect(verdict(npm({ lastRelease: undefined, lastCommit: daysAgo(2) })).admit).toBe(true);
    expect(verdict(npm({ lastRelease: undefined, lastCommit: daysAgo(400) }))).toMatchObject({ admit: false, rule: "stale" });
  });
  test("no readable signal at all fails open", () => {
    expect(admit({ purl: "pkg:npm/x" }, THRESHOLDS.npm, NOW)).toMatchObject({ admit: true, rule: "fails-open" });
  });
});

describe("Cargo admission settings", () => {
  test("locks the provisional Cargo thresholds and exact downloads boundary", () => {
    expect(THRESHOLDS.cargo).toEqual({ freshDays: 365, minDownloads: 10_000, minStars: 100 });
    expect(cargoVerdict(cargoSignals({ downloads: 9_999 }))).toMatchObject({ admit: false, rule: "unused" });
    expect(cargoVerdict(cargoSignals({ downloads: 10_000 }))).toMatchObject({ admit: true, rule: "used" });
  });

  test("100 stars is the alternative usage floor for the repository's main package", () => {
    expect(cargoVerdict(cargoSignals({ downloads: 9_999, stars: 99 }))).toMatchObject({ admit: false, rule: "unused" });
    expect(cargoVerdict(cargoSignals({ downloads: 9_999, stars: 100 }))).toMatchObject({ admit: true, rule: "used" });
  });

  test("the release exactly 365 days old is fresh; 366 days is stale", () => {
    expect(cargoVerdict(cargoSignals({ downloads: 10_000, lastRelease: daysAgo(365) }))).toMatchObject({ admit: true, rule: "used" });
    expect(cargoVerdict(cargoSignals({ downloads: 10_000, lastRelease: daysAgo(366) }))).toMatchObject({ admit: false, rule: "stale" });
  });

  test("unknown usage remains fail-open, while a known zero is below the floor", () => {
    expect(cargoVerdict({ purl: "pkg:cargo/example-crate" })).toMatchObject({ admit: true, rule: "fails-open", why: "no readable signal (fails open)" });
    expect(cargoVerdict({ purl: "pkg:cargo/example-crate", lastRelease: daysAgo(30) })).toMatchObject({ admit: true, rule: "fails-open", why: "maintained; usage unreadable (fails open)" });
    expect(cargoVerdict(cargoSignals({ downloads: 0, stars: undefined }))).toMatchObject({ admit: false, rule: "unused" });
  });
});

describe("stars count for the repository's main package only", () => {
  test("a main package passes on stars; a package with borrowed stars does not", () => {
    expect(verdict(npm({ downloads: 50, stars: 90_000, repoShare: 0.4 })).admit).toBe(true);
    const v = verdict(npm({ purl: "pkg:npm/mermaid-es6", downloads: 50, stars: 90_000, repoShare: 0.00002, repoTop: "mermaid" }));
    expect(v).toMatchObject({ admit: false, rule: "unused" });
    expect(v.why).toContain("belong to mermaid");
  });
  test("downloads above the floor admit whatever the share; an unknown share fails open", () => {
    expect(verdict(npm({ downloads: 5_000, repoShare: 0.0001 })).admit).toBe(true);
    expect(verdict(npm({ downloads: 50, stars: 500 })).admit).toBe(true);
  });
});

describe("archived, deprecated and type stubs", () => {
  test("an archived repository stops counting: stars and pushes ignored, registry signals decide", () => {
    // A project that moved off GitHub keeps releasing from the registry: admitted on downloads.
    expect(verdict(npm({ archived: true, repo: "o/r", downloads: 5_000_000 })).admit).toBe(true);
    // Stars of an archived repository no longer admit.
    const v = verdict(npm({ archived: true, repo: "o/r", downloads: 50, stars: 9_000 }));
    expect(v).toMatchObject({ admit: false, rule: "archived" });
    expect(v.why).toContain("repository o/r is archived");
    // Without a release date, an archived repository's push does not count as maintenance: usage alone decides.
    expect(verdict(npm({ archived: true, repo: "o/r", lastRelease: undefined, lastCommit: daysAgo(2), downloads: 50, stars: 0 })).rule).toBe("unused");
  });
  test("an archive is said and exported whenever it ends the package or one of its lines, never for one still releasing", () => {
    // Archived and stale (doctrine, prisma-client-py): parked as stale, and the archive is in the reason and the list.
    const stale = verdict(npm({ archived: true, repo: "Eslint/Doctrine", lastRelease: daysAgo(2000) }));
    expect(stale).toMatchObject({ admit: false, rule: "stale", why: "repository Eslint/Doctrine is archived; no release in 365 days", archived: ["eslint/doctrine"] });
    // Moved off GitHub and still releasing: the archive ends nothing.
    expect(verdict(npm({ archived: true, repo: "o/r", downloads: 5_000_000 })).archived).toBeUndefined();
    // An older line's own repository archived (codemirror 5): exported on an admitted package too.
    expect(verdict(npm({ repo: "codemirror/dev", archivedLines: ["codemirror/codemirror"] }))).toMatchObject({ admit: true, archived: ["codemirror/codemirror"] });
    expect(verdict(npm()).archived).toBeUndefined();
  });
  test("a parked package's README is read once for the maintainers' end of development, about the whole project", async () => {
    expect(endedIn("# doctrine\n\n## Deprecation notice\n\n__This project is no longer maintained.__ See the ESLint website.")).toBe(true);
    expect(endedIn("<h1>Prisma Client Python</h1>\n\n> Prisma Client Python is no longer being maintained. See this issue")).toBe(true);
    expect(endedIn("# lib\n\nThis library has been deprecated in favour of lib2.")).toBe(true);
    expect(endedIn("# lib\n\nActive development has stopped; security fixes only.")).toBe(true);
    // One line ended, the package going on; or a statement about something else, or below the head.
    expect(endedIn("# lib\n\nVersion 1.x is no longer maintained; upgrade to 2.")).toBe(false);
    expect(endedIn("# lib\n\nThe v3 branch is no longer supported.")).toBe(false);
    expect(endedIn("# lib\n\nIE11 is no longer supported.")).toBe(false);
    expect(endedIn("# lib\n\nA fast, maintained parser. Supports Node 20+.")).toBe(false);
    expect(endedIn(`# lib\n\n${"x ".repeat(3000)}This project is no longer maintained.`)).toBe(false);

    const asked: string[] = [];
    const ended = async (r: string) => (asked.push(r), true);
    const stale = verdict(npm({ repo: "o/r", lastRelease: daysAgo(2000) }));
    expect(await withLifecycle(stale, "o/r", ended)).toMatchObject({ admit: false, rule: "stale", why: "the maintainers announced the end of development in the README of o/r; no release in 365 days" });
    // Admitted, deprecated, or already archived: no request, the verdict as is.
    const archived = verdict(npm({ archived: true, repo: "o/r", lastRelease: daysAgo(2000) }));
    for (const v of [verdict(npm({ repo: "o/r" })), verdict(npm({ repo: "o/r", deprecated: "gone" })), archived]) expect(await withLifecycle(v, "o/r", ended)).toBe(v);
    expect(await withLifecycle(stale, undefined, ended)).toBe(stale);
    expect(asked).toEqual(["o/r"]);
    expect(await withLifecycle(stale, "o/r", async () => false)).toBe(stale);
  });
  test("the repositories older npm versions name, newest line first, the current one left out", () => {
    const doc = {
      versions: { "5.0.0": { repository: { url: "git+https://github.com/codemirror/CodeMirror.git" } }, "6.0.0": { repository: "github:codemirror/basic-setup" }, "6.1.0": { repository: { url: "https://github.com/codemirror/basic-setup" } }, "4.0.0": { repository: "https://github.com/marijnh/CodeMirror/tree/master" }, "0.1.0": {} },
      time: { "4.0.0": "2014-01-01T00:00:00Z", "5.0.0": "2015-01-01T00:00:00Z", "6.0.0": "2022-01-01T00:00:00Z", "6.1.0": "2023-01-01T00:00:00Z", "0.1.0": "2011-01-01T00:00:00Z" },
    };
    expect(lineRepos(doc, "codemirror/basic-setup")).toEqual(["codemirror/codemirror", "marijnh/codemirror"]);
    expect(lineRepos(undefined, "o/r")).toEqual([]);
  });
  test("a deprecated package carries a notice with the message", () => {
    expect(verdict(npm({ deprecated: "use foo instead" }))).toEqual({
      admit: false, rule: "deprecated", why: "deprecated by its registry: use foo instead", notice: { kind: "deprecated", message: "use foo instead" },
    });
    expect(verdict(npm({ deprecated: "" }))).toMatchObject({ rule: "deprecated", notice: { kind: "deprecated" } });
  });
  test("type stubs are parked and name the typed package", () => {
    expect(typedPackage("pkg:npm/%40types/node")).toBe("node");
    expect(typedPackage("pkg:npm/%40types/babel__core")).toBe("@babel/core");
    expect(typedPackage("pkg:pypi/types-requests")).toBe("requests");
    expect(typedPackage("pkg:npm/typescript")).toBeUndefined();
    expect(verdict(npm({ purl: "pkg:npm/%40types/react" }))).toMatchObject({ admit: false, rule: "types", typesFor: "react" });
  });
  test("an ecosystem without thresholds admits", () => {
    expect(admit({ purl: "pkg:gem/rails" }, undefined, NOW)).toMatchObject({ admit: true, rule: "no-thresholds" });
  });
});

describe("registry parsers", () => {
  test("npm: newest published version from `time` (not `modified`), deprecation on latest", () => {
    const doc = { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "2.0.0": { deprecated: "gone" } }, time: { created: "2020-01-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", "1.0.0": "2021-01-01T00:00:00Z", "2.0.0": "2022-01-01T00:00:00Z", "3.0.0": "2023-01-01T00:00:00Z" } };
    expect(fromNpm(doc)).toEqual({ lastRelease: "2022-01-01T00:00:00Z", deprecated: "gone" });
    expect(fromNpm(undefined)).toEqual({ lastRelease: undefined });
  });
  test("PyPI: newest unyanked upload; inactive classifier or all releases yanked is deprecated", () => {
    const f = (t: string, yanked = false) => ({ upload_time_iso_8601: t, yanked });
    expect(fromPypi({ info: { classifiers: [] }, releases: { "1.0": [f("2024-01-01T00:00:00Z")], "1.1": [f("2025-01-01T00:00:00Z", true)], "0.1": [] } })).toEqual({ lastRelease: "2024-01-01T00:00:00Z" });
    expect(fromPypi({ info: { classifiers: ["Development Status :: 7 - Inactive"] }, releases: { "1.0": [f("2024-01-01T00:00:00Z")] } }).deprecated).toContain("Inactive");
    expect(fromPypi({ info: {}, releases: { "1.0": [f("2024-01-01T00:00:00Z", true)] } })).toEqual({ lastRelease: undefined, deprecated: "every release is yanked" });
  });
  test("crates.io validates the recent download count without coercion", () => {
    const unreadable = [
      ["missing document", undefined],
      ["missing crate", { versions: [] }],
      ["missing recent_downloads", { crate: {} }],
      ["null", { crate: { recent_downloads: null } }],
      ["numeric string", { crate: { recent_downloads: "10000" } }],
      ["negative", { crate: { recent_downloads: -1 } }],
      ["fractional", { crate: { recent_downloads: 1.5 } }],
      ["NaN", { crate: { recent_downloads: Number.NaN } }],
      ["infinity", { crate: { recent_downloads: Number.POSITIVE_INFINITY } }],
      ["unsafe integer", { crate: { recent_downloads: Number.MAX_SAFE_INTEGER + 1 } }],
    ] as const;
    for (const [label, doc] of unreadable) {
      expect(fromCargo(doc).downloads, label).toBeUndefined();
    }
    expect(fromCargo({ crate: { recent_downloads: 0 } }).downloads).toBe(0);
    expect(fromCargo({ crate: { recent_downloads: 9 }, versions: [{ created_at: "2025-02-01T00:00:00Z", yanked: true }, { created_at: "2025-01-01T00:00:00Z", yanked: false }] })).toEqual({ downloads: 9, lastRelease: "2025-01-01T00:00:00Z" });
    expect(fromGithub({ stargazers_count: 7, pushed_at: "2026-01-01T00:00:00Z", archived: true })).toEqual({ stars: 7, lastCommit: "2026-01-01T00:00:00Z", archived: true });
  });
  test("unknown registry counts preserve fail-open behavior; a valid zero stays known", () => {
    const noSignals = { purl: "pkg:cargo/example-crate", ...fromCargo(undefined) };
    expect(cargoVerdict(noSignals)).toMatchObject({ admit: true, rule: "fails-open", why: "no readable signal (fails open)" });

    const recent = { purl: "pkg:cargo/example-crate", ...fromCargo({ crate: { recent_downloads: "10000" }, versions: [{ created_at: daysAgo(30), yanked: false }] }) };
    expect(cargoVerdict(recent)).toMatchObject({ admit: true, rule: "fails-open", why: "maintained; usage unreadable (fails open)" });

    const zero = { purl: "pkg:cargo/example-crate", stars: undefined, ...fromCargo({ crate: { recent_downloads: 0 }, versions: [{ created_at: daysAgo(30), yanked: false }] }) };
    expect(cargoVerdict(zero)).toMatchObject({ admit: false, rule: "unused" });
  });
  test("all-yanked crates remain deprecated and admission keeps the notice", () => {
    const cargo = fromCargo({ crate: { recent_downloads: 20_000 }, versions: [{ created_at: daysAgo(30), yanked: true }] });
    expect(cargo.deprecated).toBe("every version is yanked");
    expect(cargoVerdict({ purl: "pkg:cargo/example-crate", ...cargo })).toMatchObject({
      admit: false,
      rule: "deprecated",
      notice: { kind: "deprecated", message: "every version is yanked" },
    });
  });
  test("Cargo signals always annotate the 90-day window, even when the registry response is unreadable", async () => {
    try {
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => ({ crate: { recent_downloads: 12_345 }, versions: [] }),
      })));
      const valid = await signals("pkg:cargo/example-crate");
      expect(valid).toMatchObject({ downloads: 12_345, downloadsWindow: "90d" });

      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
      const unreadable = await signals("pkg:cargo/example-crate");
      expect(unreadable.downloads).toBeUndefined();
      expect(unreadable.downloadsWindow).toBe("90d");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  test("repoShare: share of the top package of the same registry; missing package is unknown", () => {
    const lookup = [
      { name: "mermaid", downloads: 1_000_000, registry: { name: "npmjs.org" } },
      { name: "mermaid-es6", downloads: 20, registry: { name: "npmjs.org" } },
      { name: "mermaid-py", downloads: 9_000_000, registry: { name: "pypi.org" } },
    ];
    expect(repoShare(lookup, "mermaid-es6", "npm")).toEqual({ repoShare: 0.00002, repoTop: "mermaid" });
    expect(repoShare(lookup, "mermaid", "npm")).toEqual({ repoShare: 1 });
    expect(repoShare(lookup, "other", "npm")).toEqual({});
    expect(repoShare(undefined, "mermaid", "npm")).toEqual({});
  });
});
