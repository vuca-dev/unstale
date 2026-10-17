// Another package's advisory (advisories.ts step 8): a release-notes item that names only advisory ids OSV attributes
// to other packages, worded as a dependency update, is not a security fix of this technology. Case: react-hook-form
// 7.69.0 names React Server Components' CVE-2025-55182, -55183, -55184 and -67779 ("chore: ..."; the PR bumps react in
// its own devDependencies; the release installs no dependency). OSV and npm registry responses recorded on 17 October
// 2026 (details, references and long ranges trimmed).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { advisoryPackages, attachAdvisories, releaseDependencies, sourceItem, type Advisory, type ForeignCheck } from "../src/pipeline/advisories.ts";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";

const FIX = join(import.meta.dirname, "fixtures", "foreign-advisory");
const OSV: Record<string, unknown> = JSON.parse(readFileSync(join(FIX, "osv.json"), "utf8"));
const NPM_7_69_0 = readFileSync(join(FIX, "npm-react-hook-form-7.69.0.json"), "utf8");

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-foreign-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});
afterEach(() => vi.unstubAllGlobals());

const RHF: Technology = {
  id: "react-hook-form-f35a6c18",
  name: "react-hook-form",
  repo: "react-hook-form/react-hook-form",
  components: ["pkg:npm/react-hook-form"],
  tag: /^v(\d+\.\d+\.\d+)$/,
  clean: (b) => b,
};

// The release body as fetched, plus two items this test adds: an own fix that mentions another package's advisory
// for comparison, and a bump naming an id OSV does not know.
const BODY = `📏 feat: align <Watch /> API with useWatch (#13192)
🤦🏻‍♂️ chore: update @deprecated names prop on <Watch /> (#13198)
🏥 chore: safely call function methods on elements (#13190)
🪖 chore: cve-2025-67779 (#13196)
🪖 chore: cve-2025-55184 & cve-2025-55183 (#13194)
🪖 chore: CVE-2025-55182 Critical RCE vulnerabilty (#13175)
🐞 fix(validation): sanitize field paths against prototype pollution, as in CVE-2025-55183 (#13200)
🪖 chore: bump example deps for CVE-2099-0001 (#13201)
🐞 fix(reset): preserve isValid state when keepIsValid option is used (#13173)
`;
const URL = "https://github.com/react-hook-form/react-hook-form/releases/tag/v7.69.0";
const releases = [{ version: "7.69.0", date: "2025-12-20", url: URL }];

function record(id: string, quote: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: `${RHF.id}:${id}`,
    technology: RHF.id,
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "security",
    breaking: false,
    surface: "runtime_internal",
    subject: id,
    subject_kind: "literal",
    summary: "A security update addressed it.",
    benefit: ["security"],
    releases: [{ component: "pkg:npm/react-hook-form", version: "7.69.0", date: "2025-12-20", line: "7" }],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    evidence: [{ kind: "release_notes", url: URL, quote, snapshot: "sha256:48c8" }],
    related: [],
    sources: [`${RHF.id}@7.69.0#0.${id.length}`],
    history: [{ action: "created", revision: 1, label_version: 1 }],
    ...over,
  };
}

function store(): TechStore {
  const recs = [
    // As stored by the scout run (quotes as extracted: the "chore:" prefix is not in them).
    record("cve-2025-55182", "CVE-2025-55182 Critical RCE vulnerabilty", { summary: "A critical RCE vulnerability was addressed.", benefit: ["security", "correctness"] }),
    record("cve-2025-55183", "cve-2025-55184 & cve-2025-55183"),
    record("cve-2025-55184", "cve-2025-55184 & cve-2025-55183"),
    record("cve-2025-67779", "cve-2025-67779"),
    // This package's own fix, naming another package's advisory for comparison: not worded as an update.
    record("field-paths", "sanitize field paths against prototype pollution, as in CVE-2025-55183"),
    // An id OSV does not know: as before.
    record("example-deps", "bump example deps for CVE-2099-0001"),
    // Not security: never looked at.
    record("reset", "preserve isValid state when keepIsValid option is used", { change_type: "fix", benefit: ["correctness"] }),
  ];
  return { technology: RHF.id, ingested: {}, records: Object.fromEntries(recs.map((r) => [r.id, r])) };
}

const noJudge = async (): Promise<Classification> => {
  throw new Error("no model call expected");
};

/** OSV and the npm registry from the recordings: `GET /v1/vulns/<id>`, react-hook-form 7.69.0, 404 otherwise. */
function stubOsv(): string[] {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).startsWith("https://registry.npmjs.org/")) {
      asked.push(String(url));
      return String(url) === "https://registry.npmjs.org/react-hook-form/7.69.0" ? new Response(NPM_7_69_0, { status: 200 }) : new Response("{}", { status: 404 });
    }
    const id = decodeURIComponent(String(url).replace("https://api.osv.dev/v1/vulns/", ""));
    asked.push(id);
    const v = Object.values(OSV).find((x) => (x as { id: string }).id.toUpperCase() === id.toUpperCase());
    return v ? new Response(JSON.stringify(v), { status: 200 }) : new Response('{"code":5,"message":"Vulnerability not found"}', { status: 404 });
  });
  return asked;
}

describe("another package's advisory", () => {
  test("OSV attribution follows aliases (a CVE entry names no package, its GHSA does) and is cached", async () => {
    const asked = stubOsv();
    const p = await advisoryPackages(RHF, "CVE-2025-55182");
    expect([...p!].sort()).toEqual(["pkg:npm/react-server-dom-parcel", "pkg:npm/react-server-dom-turbopack", "pkg:npm/react-server-dom-webpack"]);
    expect(asked).toEqual(["CVE-2025-55182", "GHSA-fv66-9v8q-g76r"]);
    expect(await advisoryPackages(RHF, "CVE-2099-0001")).toBeUndefined();
    // Cached: offline and a fresh cache ask nothing; an id never asked cannot be answered offline.
    const n = asked.length;
    expect((await advisoryPackages(RHF, "CVE-2025-55182", { offline: true }))!.size).toBe(3);
    await advisoryPackages(RHF, "CVE-2025-55182");
    await expect(advisoryPackages(RHF, "CVE-2025-67779", { offline: true })).rejects.toThrow(/offline/);
    expect(asked.length).toBe(n);
  });

  test("a release's runtime dependencies from the registry (peer and development ones are not installed), cached", async () => {
    const asked = stubOsv();
    expect(await releaseDependencies(RHF, "pkg:npm/react-hook-form", "7.69.0")).toEqual([]);
    // Not published at that version: installs nothing (null), unlike unknown (undefined).
    expect(await releaseDependencies(RHF, "pkg:npm/react-hook-form", "0.0.0-unpublished")).toBeNull();
    expect(await releaseDependencies(RHF, "pkg:npm/react-hook-form", "7.69.0", { offline: true })).toEqual([]);
    expect(asked.filter((u) => u.includes("registry"))).toHaveLength(2);
    // No hook for the ecosystem: unknown.
    expect(await releaseDependencies(RHF, "pkg:golang/github.com/a/b", "1.0.0")).toBeUndefined();
  });

  test("the source item of an id-only quote is the one line that contains it", () => {
    expect(sourceItem(BODY, "cve-2025-67779")).toBe("🪖 chore: cve-2025-67779 (#13196)");
    expect(sourceItem(BODY, "CVE-2025-55182 Critical RCE vulnerabilty")).toBe("🪖 chore: CVE-2025-55182 Critical RCE vulnerabilty (#13175)");
    expect(sourceItem(BODY, "not in the notes")).toBeUndefined();
  });

  test("relabelled as a dependency update; own fixes, unknown ids and other records kept; idempotent; restored", async () => {
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", RHF.id, "7.69.0.md"), BODY);
    stubOsv();
    const s = store();
    const dependencies = (c: string, v: string) => releaseDependencies(RHF, c, v);
    const check: ForeignCheck = { packages: RHF.components, lookup: (id) => advisoryPackages(RHF, id), dependencies };
    const report = await attachAdvisories(RHF, s, [], releases, noJudge, check);
    expect(report.foreign).toEqual([
      { record: `${RHF.id}:cve-2025-55182`, ids: ["CVE-2025-55182"] },
      { record: `${RHF.id}:cve-2025-55183`, ids: ["CVE-2025-55183", "CVE-2025-55184"] },
      { record: `${RHF.id}:cve-2025-55184`, ids: ["CVE-2025-55183", "CVE-2025-55184"] },
      { record: `${RHF.id}:cve-2025-67779`, ids: ["CVE-2025-67779"] },
    ]);
    expect(report.recordsChanged).toBe(4);
    const rce = s.records[`${RHF.id}:cve-2025-55182`]!;
    expect(rce).toMatchObject({ change_type: "other", benefit: ["none"], revision: 2, label_version: 2 });
    expect(rce.history.at(-1)).toMatchObject({ action: "foreign-advisory" });
    expect(rce.history.at(-1)!.detail).toContain("pkg:npm/react-server-dom-webpack");
    expect(rce.history.at(-1)!.detail).toMatch(/\(was security; security, correctness\)$/);
    for (const id of ["field-paths", "example-deps"]) expect(s.records[`${RHF.id}:${id}`]).toMatchObject({ change_type: "security", benefit: ["security"], revision: 1 });
    expect(s.records[`${RHF.id}:reset`]).toMatchObject({ change_type: "fix", revision: 1 });

    // A rerun changes nothing.
    const before = JSON.stringify(s);
    await attachAdvisories(RHF, s, [], releases, noJudge, check);
    expect(JSON.stringify(s)).toBe(before);

    // OSV cannot be read: unchanged.
    const down: ForeignCheck = { packages: RHF.components, lookup: async () => Promise.reject(new Error("OSV down")), dependencies };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await attachAdvisories(RHF, s, [], releases, noJudge, down);
    err.mockRestore();
    expect(JSON.stringify(s)).toBe(before);

    // OSV now attributes CVE-2025-55182 to this package too: the record gets its labels back.
    const ours: ForeignCheck = {
      packages: RHF.components,
      lookup: async (id) => {
        const p = await advisoryPackages(RHF, id);
        return id === "CVE-2025-55182" && p ? new Set([...p, "pkg:npm/react-hook-form"]) : p;
      },
      dependencies,
    };
    const back = await attachAdvisories(RHF, s, [], releases, noJudge, ours);
    expect(back.foreignRestored).toEqual([`${RHF.id}:cve-2025-55182`]);
    expect(rce).toMatchObject({ change_type: "security", benefit: ["security", "correctness"], revision: 3 });
    expect(s.records[`${RHF.id}:cve-2025-67779`]).toMatchObject({ change_type: "other", benefit: ["none"] });

    // OSV no longer knows an id: missing data restores nothing.
    const gone = await attachAdvisories(RHF, s, [], releases, noJudge, { packages: RHF.components, lookup: async () => undefined, dependencies });
    expect(gone.foreignRestored).toEqual([]);
    expect(s.records[`${RHF.id}:cve-2025-67779`]).toMatchObject({ change_type: "other" });
  });

  test("npm aliases install their target; PyPI requirements only an extra installs are left out", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://registry.npmjs.org/a/1.0.0")
        return new Response(JSON.stringify({ dependencies: { x: "npm:@s/y@^1.2.0", z: "^2" }, optionalDependencies: { w: "npm:v" }, bundleDependencies: ["b"] }));
      if (url === "https://pypi.org/pypi/p/1.0/json")
        return new Response(JSON.stringify({ info: { requires_dist: ["Requests_Toolbelt (>=1.0)", 'sphinx ; extra == "docs"', 'pywin32 ; extra == "docs" or sys_platform == "win32"'] } }));
      return new Response("{}", { status: 404 });
    });
    expect(await releaseDependencies(RHF, "pkg:npm/a", "1.0.0")).toEqual(["pkg:npm/%40s/y", "pkg:npm/b", "pkg:npm/v", "pkg:npm/w", "pkg:npm/x", "pkg:npm/z"]);
    expect(await releaseDependencies(RHF, "pkg:pypi/p", "1.0")).toEqual(["pkg:pypi/pywin32", "pkg:pypi/requests-toolbelt"]);
  });

  test("an id among this technology's own advisories is never looked up and keeps the record", async () => {
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", RHF.id, "7.69.0.md"), BODY);
    const s = store();
    const own: Advisory = { id: "GHSA-OWN0-OWN0-OWN0", aliases: ["CVE-2025-67779"], url: "https://github.com/advisories/GHSA-OWN0-OWN0-OWN0", summary: "x", published: "2025-12-20", affected: [] };
    const asked: string[] = [];
    await attachAdvisories(RHF, s, [own], releases, noJudge, { packages: RHF.components, lookup: async (id) => (asked.push(id), new Set(["pkg:npm/react"])), dependencies: async () => [] });
    expect(asked).not.toContain("CVE-2025-67779");
    expect(s.records[`${RHF.id}:cve-2025-67779`]).toMatchObject({ change_type: "security" });
  });
  test("kept when the release ships the other package's fix (a runtime dependency of any of its packages, a dependency the item names, bundled code) or nothing can be known", async () => {
    const body = `- fix(express): update body-parser to 1.20.4 for CVE-2025-15284 (#16001)
- chore(deps): bump qs for CVE-2025-15284 (#16002)
- chore: update the bundled qs copy for CVE-2025-15284 (#16003)
- chore(deps): bump qs in the docs site for CVE-2025-15284 (#16004)
`;
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", RHF.id, "7.70.0.md"), body);
    const u = "https://github.com/react-hook-form/react-hook-form/releases/tag/v7.70.0";
    const at = (id: string, quote: string) =>
      record(id, quote, { releases: [{ component: "pkg:npm/react-hook-form", version: "7.70.0", date: "2026-01-10", line: "7" }], evidence: [{ kind: "release_notes", url: u, quote, snapshot: "sha256:bb" }] });
    const recs = () => [
      at("body-parser", "update body-parser to 1.20.4 for CVE-2025-15284"),
      at("qs", "bump qs for CVE-2025-15284"),
      at("bundled", "update the bundled qs copy for CVE-2025-15284"),
      at("docs-site", "bump qs in the docs site for CVE-2025-15284"),
    ];
    const fresh = (): TechStore => ({ technology: RHF.id, ingested: {}, records: Object.fromEntries(recs().map((r) => [r.id, r])) });
    const s = fresh();
    const rel = [{ version: "7.70.0", date: "2026-01-10", url: u }];
    const lookup = async () => new Set(["pkg:npm/qs"]);
    // Installs body-parser and qs: the first two ship the fix; bundled code always does; the docs site never ships.
    const r = await attachAdvisories(RHF, s, [], rel, noJudge, { packages: RHF.components, lookup, dependencies: async () => ["pkg:npm/body-parser"] });
    expect(r.foreign.map((x) => x.record)).toEqual([`${RHF.id}:docs-site`, `${RHF.id}:qs`]);
    const s2 = fresh();
    const r2 = await attachAdvisories(RHF, s2, [], rel, noJudge, { packages: RHF.components, lookup, dependencies: async () => ["pkg:npm/body-parser", "pkg:npm/qs"] });
    // The release installs qs itself: whatever the item says it bumped, users may get the fix; kept.
    expect(r2.foreign).toEqual([]);
    expect(r2.foreignRestored).toEqual([]);
    // An ecosystem without the dependencies hook (or a release the registry does not list): nothing relabelled.
    const s3 = fresh();
    const r3 = await attachAdvisories(RHF, s3, [], rel, noJudge, { packages: RHF.components, lookup, dependencies: async () => undefined });
    expect(r3.foreign).toEqual([]);
    // The dependency sits in a sibling package of the technology (not a component the record lists): kept.
    const sibling = "pkg:npm/%40rhf/platform";
    const r4 = await attachAdvisories(RHF, fresh(), [], rel, noJudge, { packages: [...RHF.components, sibling], lookup, dependencies: async (c) => (c === sibling ? ["pkg:npm/qs"] : []) });
    expect(r4.foreign).toEqual([]);
    // Another ecosystem's package (a Go module): the registry's npm dependencies cannot answer; kept.
    const r5 = await attachAdvisories(RHF, fresh(), [], rel, noJudge, { packages: RHF.components, lookup: async () => new Set(["pkg:golang/github.com/cloudflare/circl"]), dependencies: async () => [] });
    expect(r5.foreign).toEqual([]);
  });
});
