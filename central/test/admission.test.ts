// Admission rules (eval/scope/RESULTS.md): release-based freshness, stars for the repository's main package only,
// archived repositories, deprecated packages with a notice, type stubs parked; unreadable signals fail open.
import { describe, expect, test } from "vitest";
import { admit, fromCargo, fromGithub, fromNpm, fromPypi, repoShare, THRESHOLDS, typedPackage, type Signals } from "../src/pipeline/admission.ts";

const NOW = Date.parse("2026-10-16T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const npm = (over: Partial<Signals> = {}): Signals => ({ purl: "pkg:npm/left-pad", lastRelease: daysAgo(30), downloads: 5_000, stars: 50, ...over });
const verdict = (s: Signals) => admit(s, THRESHOLDS.npm, NOW);

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
  test("crates.io and GitHub", () => {
    expect(fromCargo({ crate: { recent_downloads: 9 }, versions: [{ created_at: "2025-02-01T00:00:00Z", yanked: true }, { created_at: "2025-01-01T00:00:00Z", yanked: false }] })).toEqual({ downloads: 9, lastRelease: "2025-01-01T00:00:00Z" });
    expect(fromGithub({ stargazers_count: 7, pushed_at: "2026-01-01T00:00:00Z", archived: true })).toEqual({ stars: 7, lastCommit: "2026-01-01T00:00:00Z", archived: true });
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
