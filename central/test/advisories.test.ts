// Security advisories (advisories.ts): OSV entries read into advisories, ranges resolved against the release index
// (SemVer, an ecosystem's order, explicit lists, unresolved otherwise), range syntax for the npm reference, the fix per
// release line inside the window, ids taken from the release-notes line a quote came from (never a neighbouring list
// item), and attaching advisories to records.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { attachAdvisories, basisOf, fetchAdvisories, fixesInWindow, fromOsv, idsAtQuote, inRange, listedPackages, resolveRange, semverCmp, toRecordAdvisory, type Advisory, type AffectedRange } from "../src/pipeline/advisories.ts";
import { canonicalPurl, cargoName, cargoPurl, ecosystemOf, githubRepo, listingLifetimeMs, pep440Order, semverOrder } from "../src/pipeline/ecosystems.ts";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
import { registryCache } from "../src/pipeline/registry.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-advisories-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const BODY = `### Security Fixes

**High:**
- [GHSA-8h8q-6873-q5fj: Denial of Service with Server Components](https://github.com/vercel/next.js/security/advisories/GHSA-8h8q-6873-q5fj)
- [GHSA-267c-6grr-h53f: Middleware / Proxy bypass in App Router applications via segment-prefetch routes](https://github.com/vercel/next.js/security/advisories/GHSA-267c-6grr-h53f)
- [GHSA-mg66-mrh9-m8jx: Denial of Service via connection exhaustion in applications using Cache Components](https://github.com/vercel/next.js/security/advisories/GHSA-mg66-mrh9-m8jx)
`;

const adv = (id: string, ranges: Array<[string, string?]>, summary = `Advisory ${id}`): Advisory => ({
  id,
  aliases: [],
  severity: "high",
  url: `https://github.com/advisories/${id}`,
  summary,
  published: "2026-05-11",
  affected: ranges.map(([range, patched]) => ({
    component: "pkg:npm/next",
    range,
    ...(patched ? { patched, fixed: patched } : {}),
    type: "SEMVER",
    introduced: /^>= (\S+?),/.exec(range)?.[1] ?? "0",
    listed: [],
  })),
});

const rng = (over: Partial<AffectedRange>): AffectedRange => ({ component: "pkg:npm/next", range: "", type: "SEMVER", listed: [], ...over });

function record(id: string, version: string, quote: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    technology: "next",
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "security",
    breaking: false,
    surface: "runtime_internal",
    subject: id.slice(5),
    subject_kind: "concept",
    summary: quote,
    benefit: ["security"],
    releases: [{ component: "pkg:npm/next", version, date: "2026-05-11", line: version.split(".")[0]! }],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    evidence: [{ kind: "release_notes", url: `https://github.com/vercel/next.js/releases/tag/v${version}`, quote, snapshot: "sha256:aa" }],
    related: [],
    sources: [`next@${version}#0.0`],
    history: [],
    ...over,
  };
}

describe("Cargo OSV and registry adapter", () => {
  const cargoRange = { type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.0" }] };

  test("registers crates.io with strict SemVer precedence and preserves crate identity", () => {
    const eco = ecosystemOf("pkg:cargo/serde");
    expect(eco.osv).toBe("crates.io");
    expect(eco.compare).toBe(semverOrder);
    expect(semverOrder("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(semverOrder("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(semverOrder("1.0.0+one", "1.0.0+two")).toBe(0);
    for (const invalid of ["1.2", "1.0.0-01", "1.0.0-", "01.0.0", "1.0.0+bad..meta"]) {
      expect(semverOrder(invalid, "1.0.0")).toBeUndefined();
      expect(semverOrder("1.0.0", invalid)).toBeUndefined();
    }
    expect(cargoName("pkg:cargo/serde_json@1.0.0?registry=foo#subpath")).toBe("serde_json");
    expect(cargoName("pkg:cargo/serde%2Fjson")).toBeUndefined();
    expect(cargoName("pkg:cargo/serde/extra")).toBeUndefined();
    expect(cargoName("pkg:cargo/%E0%A4%A")).toBeUndefined();
    expect(cargoPurl("serde_json")).toBe("pkg:cargo/serde_json");
    expect(() => cargoPurl("serde/json")).toThrow();
    expect(canonicalPurl("pkg:cargo/serde_json@1.0.0?x=y#subpath")).toBe("pkg:cargo/serde_json");
    expect(canonicalPurl("pkg:cargo/serde%2Fjson")).toBe("pkg:cargo/serde%2Fjson");
  });

  test("OSV affected entries use valid Cargo PURLs authoritatively or crates.io names without normalization", () => {
    const ours = new Set(["pkg:cargo/serde", "pkg:cargo/serde_json", "pkg:cargo/other-crate"]);
    const range = [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.1.0" }] }];
    const result = fromOsv({
      id: "RUSTSEC-2025-0001",
      affected: [
        { package: { ecosystem: "crates.io", name: "serde", purl: "pkg:cargo/serde@1.0.0" }, ranges: range },
        { package: { ecosystem: "crates.io", name: "serde", }, ranges: range },
        { package: { ecosystem: "crates.io", name: "unrelated" }, ranges: range },
        { package: { ecosystem: "crates.io" }, ranges: range },
        { package: { ecosystem: "crates.io", name: "serde", purl: "pkg:cargo/%E0%A4%A" }, ranges: range },
        { package: { ecosystem: "crates.io", name: "serde", purl: "pkg:npm/serde" }, ranges: range },
        { package: { ecosystem: "crates.io", name: "serde", purl: "pkg:cargo/other-crate@9.0.0" }, ranges: range },
        { package: { ecosystem: "crates.io", name: "serde_json" }, ranges: range },
      ],
    }, ours)!;
    expect(result.affected.map((r) => r.component)).toEqual([
      "pkg:cargo/serde", "pkg:cargo/serde", "pkg:cargo/other-crate", "pkg:cargo/serde_json",
    ]);
    expect(result.id).toBe("RUSTSEC-2025-0001");
  });

  test("GHSA preference, RustSec aliases and withdrawn records retain generic OSV behavior", () => {
    const ours = new Set(["pkg:cargo/serde"]);
    const affected = [{ package: { ecosystem: "crates.io", name: "serde" }, ranges: [cargoRange] }];
    const withAlias = fromOsv({ id: "GHSA-AAAA-BBBB-CCCC", aliases: ["RUSTSEC-2025-0001"], affected }, ours)!;
    expect(withAlias).toMatchObject({ id: "GHSA-AAAA-BBBB-CCCC", aliases: ["RUSTSEC-2025-0001"], url: "https://github.com/advisories/GHSA-AAAA-BBBB-CCCC" });
    const rustsec = fromOsv({ id: "RUSTSEC-2025-0002", affected }, ours)!;
    expect(rustsec).toMatchObject({ id: "RUSTSEC-2025-0002", url: "https://osv.dev/vulnerability/RUSTSEC-2025-0002" });
    const rustsecWithGhsa = fromOsv({ id: "RUSTSEC-2025-0003", aliases: ["GHSA-DDDD-EEEE-FFFF"], affected }, ours)!;
    expect(rustsecWithGhsa).toMatchObject({ id: "GHSA-DDDD-EEEE-FFFF", aliases: ["RUSTSEC-2025-0003"], url: "https://github.com/advisories/GHSA-DDDD-EEEE-FFFF" });
    expect(fromOsv({ id: "RUSTSEC-2025-0004", withdrawn: "2025-01-01", affected }, ours)).toBeUndefined();
  });

  test("fixed events resolve only through comparable versions in the Cargo release index", () => {
    const ours = new Set(["pkg:cargo/serde"]);
    const advisory = fromOsv({ id: "RUSTSEC-2025-0005", affected: [{ package: { ecosystem: "crates.io", name: "serde" }, ranges: [cargoRange] }] }, ours)!;
    expect(advisory.affected[0]).toMatchObject({ component: "pkg:cargo/serde", range: ">= 1.0.0, < 1.2.0", patched: "1.2.0", fixed: "1.2.0" });
    const index = ["1.0.0", "1.0.1", "1.1.9", "1.2.0"];
    expect(resolveRange(advisory.affected[0]!, index)).toEqual(["1.0.0", "1.0.1", "1.1.9"]);
    expect(resolveRange(rng({ component: "pkg:cargo/serde", type: "ECOSYSTEM", introduced: "1.0.0", fixed: "1.2.0" }), index)).toEqual(["1.0.0", "1.0.1", "1.1.9"]);
    expect(resolveRange(rng({ component: "pkg:cargo/serde", type: "ECOSYSTEM", introduced: "1.2", fixed: "2.0.0" }), index)).toBeUndefined();
    expect(fixesInWindow(advisory, [{ version: "1.2.0", date: "2026-06-01" }])).toEqual([{ line: "1", version: "1.2.0", date: "2026-06-01" }]);
    expect(fixesInWindow(advisory, [{ version: "1.1.9", date: "2026-06-01" }])).toEqual([]);

    const invalidBoundary = rng({ component: "pkg:cargo/serde", introduced: "1.2", fixed: "2.0.0" });
    expect(resolveRange(invalidBoundary, ["1.5.0"])).toBeUndefined();
    expect(resolveRange(rng({ component: "pkg:cargo/serde", introduced: "0", fixed: "1.2" }), ["1.0.0"])).toBeUndefined();
    const unresolved = toRecordAdvisory({ ...advisory, affected: [invalidBoundary] }, ["1.5.0"]);
    expect(unresolved.affected[0]).not.toHaveProperty("versions");
  });

  test("recognizes only exact crates.io package pages through the generic listed-package resolver", () => {
    const page = ecosystemOf("pkg:cargo/serde").registryPage!;
    expect(page("https://crates.io/crates/serde")).toBe("pkg:cargo/serde");
    expect(page("https://crates.io/crates/serde/1.0.0?tab=versions#readme")).toBe("pkg:cargo/serde");
    expect(ecosystemOf("pkg:cargo/serde_json").versionPage!("pkg:cargo/serde_json", "1.0.0+build")).toBe("https://crates.io/crates/serde_json/1.0.0%2Bbuild");
    expect(() => ecosystemOf("pkg:cargo/serde").versionPage!("pkg:cargo/serde/extra", "1.0.0")).toThrow();
    for (const url of [
      "https://docs.rs/serde",
      "https://crates.io.evil.example/crates/serde",
      "https://crates.io/api/v1/crates/serde",
      "https://crates.io/crates/serde%ZZ",
      "https://crates.io/crates/serde%2Fother",
      "https://crates.io/crates/serde/1.0/extra",
      "https://user@crates.io/crates/serde",
      "https://@crates.io/crates/serde",
      "https://:@crates.io/crates/serde",
      "https://crates.io:444/crates/serde",
      "http://crates.io/crates/serde",
    ]) expect(page(url)).toBeUndefined();
    expect([...listedPackages("- [serde](https://crates.io/crates/serde/1.0.0)\n", [page])]).toEqual(["pkg:cargo/serde"]);
  });

  test("crates.io ordinary dependencies include both normal and null kinds, excluding dev/build entries", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return Response.json({ dependencies: [
        { crate_id: "serde_json", kind: "normal" },
        { crate_id: "optional-runtime", kind: "normal", optional: true },
        { crate_id: "serde_json", kind: null },
        { crate_id: "dev-only", kind: "dev" },
        { crate_id: "build-only", kind: "build" },
        { crate_id: "unknown", kind: "other" },
        { crate_id: "omitted" },
      ] });
    });
    try {
      const deps = await ecosystemOf("pkg:cargo/app").dependencies!("pkg:cargo/app", "1.0.0");
      expect(deps).toEqual(["pkg:cargo/optional-runtime", "pkg:cargo/serde_json"]);
      expect(asked).toEqual(["https://crates.io/api/v1/crates/app/1.0.0/dependencies"]);
      vi.stubGlobal("fetch", async () => Response.json({ dependencies: [{ crate_id: "dev-only", kind: "dev" }, { crate_id: "bad/name", kind: null }] }));
      await expect(ecosystemOf("pkg:cargo/app").dependencies!("pkg:cargo/app", "1.0.0")).rejects.toThrow();
      vi.stubGlobal("fetch", async () => Response.json({}));
      await expect(ecosystemOf("pkg:cargo/app").dependencies!("pkg:cargo/app", "1.0.0")).rejects.toThrow(/malformed/);
      vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
      expect(await ecosystemOf("pkg:cargo/app").dependencies!("pkg:cargo/app", "1.0.0")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("advisories", () => {
  test("ranges in the advisory database's syntax, prereleases included", () => {
    expect(inRange("16.1.0", ">= 15.6.0-canary.0, < 16.1.5")).toBe(true);
    expect(inRange("16.1.5", ">= 15.6.0-canary.0, < 16.1.5")).toBe(false);
    expect(inRange("15.6.0-canary.3", ">= 15.6.0-canary.0, < 16.1.5")).toBe(true);
    expect(inRange("11.1.17", "<= 11.1.17")).toBe(true);
    expect(inRange("1.0.0", "~> nonsense")).toBe(false);
    expect(semverCmp("16.0.0-beta.0", "16.0.0")).toBeLessThan(0);
  });

  test("OSV entries: GHSA id first, other ids as aliases, intervals from events, our packages only, withdrawn dropped", () => {
    const ours = new Set(["pkg:npm/next", "pkg:npm/%40nestjs/core"]);
    const a = fromOsv(
      {
        id: "GHSA-aaaa-bbbb-cccc",
        aliases: ["CVE-2026-1"],
        summary: " Bypass ",
        published: "2026-05-11T10:00:00Z",
        database_specific: { severity: "MODERATE" },
        affected: [
          { package: { ecosystem: "npm", name: "next", purl: "pkg:npm/next" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "15.5.16" }, { introduced: "16.0.0" }, { fixed: "16.2.5" }] }] },
          { package: { ecosystem: "npm", name: "@nestjs/core" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "11.0" }, { last_affected: "11.1.17" }] }] },
          { package: { ecosystem: "npm", name: "other" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] },
        ],
      },
      ours,
    )!;
    expect(a).toMatchObject({ id: "GHSA-AAAA-BBBB-CCCC", aliases: ["CVE-2026-1"], severity: "medium", summary: "Bypass", published: "2026-05-11", url: "https://github.com/advisories/GHSA-AAAA-BBBB-CCCC" });
    expect(a.affected.map((r) => `${r.component} ${r.range} ${r.patched ?? "-"}`)).toEqual([
      "pkg:npm/next < 15.5.16 15.5.16",
      "pkg:npm/next >= 16.0.0, < 16.2.5 16.2.5",
      "pkg:npm/%40nestjs/core >= 11.0, <= 11.1.17 -",
    ]);
    // A PYSEC entry whose GHSA alias exists: the GHSA id is the advisory id.
    const py = fromOsv({ id: "PYSEC-2024-1", aliases: ["GHSA-zzzz-zzzz-zzzz", "CVE-2024-2"], affected: [{ package: { ecosystem: "PyPI", name: "django", purl: "pkg:pypi/django" }, versions: ["4.2.1"], ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "4.2" }, { fixed: "4.2.2" }] }] }] }, new Set(["pkg:pypi/django"]))!;
    expect(py).toMatchObject({ id: "GHSA-ZZZZ-ZZZZ-ZZZZ", aliases: ["CVE-2024-2", "PYSEC-2024-1"] });
    expect(fromOsv({ id: "GHSA-w", withdrawn: "2026-01-01", affected: [{ package: { purl: "pkg:npm/next" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }] }] }, ours)).toBeUndefined();
  });

  test("ranges resolve against the release index; an unreadable or unorderable range stays unresolved", () => {
    const index = ["15.5.15", "16.2.4", "15.5.16", "16.2.5", "16.3.0-canary.1"];
    expect(resolveRange(rng({ introduced: "16.0.0", fixed: "16.2.5" }), index)).toEqual(["16.2.4"]);
    expect(resolveRange(rng({ introduced: "0", fixed: "15.5.16" }), index)).toEqual(["15.5.15"]);
    expect(resolveRange(rng({ type: "ECOSYSTEM", introduced: "16.0", lastAffected: "16.2.5" }), index)).toEqual(["16.2.4", "16.2.5"]);
    expect(resolveRange(rng({ introduced: "16.3.0-canary.0" }), index)).toEqual(["16.3.0-canary.1"]);
    // An ecosystem with no version order: its explicit list, else unresolved.
    expect(resolveRange(rng({ component: "pkg:hex/phoenix", type: "ECOSYSTEM", introduced: "1.7", fixed: "1.7.2", listed: ["1.7", "1.7.1"] }), ["1.7", "1.7.1", "1.7.2"])).toEqual(["1.7", "1.7.1"]);
    expect(resolveRange(rng({ component: "pkg:hex/phoenix", type: "ECOSYSTEM", introduced: "1.7", fixed: "1.7.2" }), ["1.7.1"])).toBeUndefined();
    // PyPI orders by PEP 440.
    expect(resolveRange(rng({ component: "pkg:pypi/django", type: "ECOSYSTEM", introduced: "4.2", fixed: "4.2.2" }), ["4.1.9", "4.2", "4.2.1", "4.2.2", "4.2.2rc1"])).toEqual(["4.2", "4.2.1", "4.2.2rc1"]);
    expect(resolveRange(rng({ type: "GIT", introduced: "abc", fixed: "def" }), index)).toBeUndefined();
    // A version SemVer cannot read is never guessed.
    expect(resolveRange(rng({ introduced: "0", fixed: "2.0.0" }), ["1.0.0", "nightly"])).toBeUndefined();
  });

  test("npm siblings: a registry repository field names the technology's GitHub repository", () => {
    expect(githubRepo({ url: "git+https://github.com/nestjs/nest.git", directory: "packages/core" })).toBe("nestjs/nest");
    expect(githubRepo("github:vercel/next.js")).toBe("vercel/next.js");
    expect(githubRepo("https://gitlab.com/a/b")).toBeUndefined();
  });

  test("npm siblings: only a scope a component is published in from the repository is listed; a failed read fails the lookup", async () => {
    const repo = (r: string) => ({ repository: { url: `git+https://github.com/${r}.git` } });
    const answers: Record<string, unknown> = {
      "@types%2fws/latest": repo("DefinitelyTyped/DefinitelyTyped"),
      "@acme%2fcore/latest": repo("acme/acme"),
      "-/org/acme/package": { "@acme/core": "write", "@acme/cli": "write", "@acme/other": "write" },
      "@acme%2fcli/latest": repo("acme/acme"),
      "@acme%2fother/latest": repo("someone/else"),
    };
    const asked: string[] = [];
    let refuse = "";
    vi.stubGlobal("fetch", async (url: string) => {
      const key = url.replace("https://registry.npmjs.org/", "");
      asked.push(key);
      if (key === refuse) return new Response("", { status: 403 });
      return key in answers ? Response.json(answers[key]) : new Response("", { status: 404 });
    });
    try {
      const siblings = ecosystemOf("pkg:npm/ws").siblings!;
      const tech = (components: string[], r: string) => ({ ...TECHNOLOGIES.next!, repo: r, components });
      // A merged type stub's scope belongs to another repository: never listed.
      expect(await siblings(tech(["pkg:npm/ws", "pkg:npm/%40types/ws"], "websockets/ws"))).toEqual([]);
      expect(asked).toEqual(["@types%2fws/latest"]);
      // The refusal is asked first: once read, the listings are kept for a day (the test below).
      refuse = "@acme%2fother/latest";
      await expect(siblings(tech(["pkg:npm/%40acme/core"], "acme/acme"))).rejects.toThrow(/403/);
      refuse = "";
      expect(await siblings(tech(["pkg:npm/%40acme/core"], "acme/acme"))).toEqual(["pkg:npm/%40acme/cli", "pkg:npm/%40acme/core"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("npm listings: one scope's and one maintainer's listings are read once a day for every technology, kept with public fields only; a refusal is never kept", async () => {
    const manifest = (r: string) => ({ repository: { url: `git+https://github.com/${r}.git` }, maintainers: [{ name: "keeper", email: "keeper@example.org" }], readme: "long text" });
    const answers: Record<string, unknown> = {
      "@shared%2fa/latest": manifest("shared/mono"),
      "@shared%2fb/latest": manifest("shared/mono"),
      "@shared%2fc/latest": manifest("someone/else"),
      "-/org/shared/package": { "@shared/a": "write", "@shared/b": "write", "@shared/c": "write" },
      [`-/v1/search?text=${encodeURIComponent("maintainer:keeper")}&size=250&from=0`]: {
        total: 2,
        objects: [
          { package: { name: "@shared/a", description: "A", links: { repository: "https://github.com/shared/mono" }, publisher: { email: "keeper@example.org" } } },
          { package: { name: "@shared/b", description: "B", links: { repository: "https://github.com/shared/mono" } } },
        ],
      },
    };
    const asked: string[] = [];
    let status = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const key = url.replace("https://registry.npmjs.org/", "");
      asked.push(key);
      if (status) return new Response("", { status });
      return key in answers ? Response.json(answers[key]) : new Response("", { status: 404 });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const eco = ecosystemOf("pkg:npm/%40shared/a");
      const tech = (component: string) => ({ ...TECHNOLOGIES.next!, repo: "shared/mono", components: [component] });
      // A rate-limited read (retried, then given up) fails the lookup and keeps nothing.
      status = 429;
      const limited = expect(eco.siblings!(tech("pkg:npm/%40shared/a"))).rejects.toThrow(/429/);
      await vi.advanceTimersByTimeAsync(10_000);
      await limited;
      status = 0;
      asked.length = 0;
      // Two technologies of the scope at once: every listing and manifest is asked once.
      const [a, b] = await Promise.all([eco.siblings!(tech("pkg:npm/%40shared/a")), eco.siblings!(tech("pkg:npm/%40shared/b"))]);
      expect(a).toEqual(["pkg:npm/%40shared/a", "pkg:npm/%40shared/b"]);
      expect(b).toEqual(a);
      expect(asked.sort()).toEqual(["-/org/shared/package", "@shared%2fa/latest", "@shared%2fb/latest", "@shared%2fc/latest"]);
      // Later in the day (another cycle reads the same saved cache): nothing is asked, the maintainer's list once.
      vi.setSystemTime(Date.now() + 23 * 3600_000);
      asked.length = 0;
      expect(await eco.siblings!(tech("pkg:npm/%40shared/b"))).toEqual(a);
      const packages = [{ purl: "pkg:npm/%40shared/a", name: "@shared/a", description: "A" }, { purl: "pkg:npm/%40shared/b", name: "@shared/b", description: "B" }];
      expect(await eco.repositoryPackages!(tech("pkg:npm/%40shared/a"))).toEqual(packages);
      expect(await eco.repositoryPackages!(tech("pkg:npm/%40shared/b"))).toEqual(packages);
      expect(asked).toEqual([`-/v1/search?text=${encodeURIComponent("maintainer:keeper")}&size=250&from=0`]);
      // Only the fields the lookups use are kept: no address, no README.
      const kept = [...registryCache().entries()].filter(([name]) => name.startsWith("listings/")).map(([, v]) => v.toString("utf8")).join("\n");
      expect(kept).toContain('"maintainers":["keeper"]');
      expect(kept).not.toMatch(/example\.org|long text|publisher/);
      // Past its lifetime (30 hours at most), read again.
      vi.setSystemTime(Date.now() + 8 * 3600_000);
      asked.length = 0;
      expect(await eco.siblings!(tech("pkg:npm/%40shared/b"))).toEqual(a);
      expect(asked.sort()).toEqual(["-/org/shared/package", "@shared%2fa/latest", "@shared%2fb/latest", "@shared%2fc/latest"]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("npm listings: a 404 is kept, an empty later search page is not, and a new process reads what an earlier one kept", async () => {
    const asked: string[] = [];
    const page = (from: number) => `-/v1/search?text=${encodeURIComponent("maintainer:many")}&size=250&from=${from}`;
    const answers: Record<string, unknown> = {
      "@gone%2fcore/latest": { repository: "github:gone/gone", maintainers: [{ name: "many" }] },
      [page(0)]: { total: 300, objects: [{ package: { name: "@gone/core", links: { repository: "github:gone/gone" } } }] },
      [page(1)]: { total: 300, objects: [] },
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const key = url.replace("https://registry.npmjs.org/", "");
      asked.push(key);
      return key in answers ? Response.json(answers[key]) : new Response("", { status: 404 });
    });
    try {
      const tech = { ...TECHNOLOGIES.next!, repo: "gone/gone", components: ["pkg:npm/%40gone/core"] };
      const eco = ecosystemOf("pkg:npm/%40gone/core");
      // The scope has no public listing (404): no siblings, and the answer is kept.
      expect(await eco.siblings!(tech)).toEqual([]);
      expect(asked).toEqual(["@gone%2fcore/latest", "-/org/gone/package"]);
      // The maintainer's list ends early: unknown, and the empty page is asked again next time; the first is kept.
      asked.length = 0;
      expect(await eco.repositoryPackages!(tech)).toBeUndefined();
      expect(await eco.repositoryPackages!(tech)).toBeUndefined();
      expect(asked).toEqual([page(0), page(1), page(1)]);
      // Another process (a later cycle) starts with no memory and reads the saved answers: nothing is asked.
      vi.resetModules();
      const fresh = (await import("../src/pipeline/ecosystems.ts")).ecosystemOf("pkg:npm/%40gone/core");
      asked.length = 0;
      expect(await fresh.siblings!(tech)).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a detected new version asks OSV again once: a query cached before the detection is read again, one after it is fresh", async () => {
    const t = { ...TECHNOLOGIES.next!, id: "osv-since", components: ["pkg:pypi/osv-since"] };
    let queries = 0;
    vi.stubGlobal("fetch", async () => {
      queries++;
      return Response.json({ vulns: [] });
    });
    try {
      await fetchAdvisories(t);
      expect(queries).toBe(1);
      // Within the 12-hour window: no query, and none for a detection older than the cache.
      await fetchAdvisories(t);
      await fetchAdvisories(t, { since: new Date(Date.now() - 3600_000).toISOString() });
      expect(queries).toBe(1);
      // A detection after the cached query: asked again, then fresh for the same detection.
      const since = new Date(Date.now() + 1000).toISOString();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2000);
      await fetchAdvisories(t, { since });
      await fetchAdvisories(t, { since });
      expect(queries).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("npm listings: each lives 24 to 30 hours by its URL, so one scope's entries come due in pieces", () => {
    const urls = Array.from({ length: 200 }, (_, i) => `https://registry.npmjs.org/@big%2fp${i}/latest`);
    const lives = urls.map(listingLifetimeMs);
    expect(Math.min(...lives)).toBeGreaterThanOrEqual(24 * 3600_000);
    expect(Math.max(...lives)).toBeLessThan(30 * 3600_000);
    expect(new Set(lives.map((l) => Math.floor(l / 3600_000))).size).toBe(6);
    expect(urls.map(listingLifetimeMs)).toEqual(lives);
  });

  test("an OSV query whose connection drops is tried again; one that keeps failing names its cause", async () => {
    const t = { ...TECHNOLOGIES.next!, id: "osv-retry", components: ["pkg:pypi/django"] };
    const vuln = { id: "GHSA-aaaa-bbbb-cccc", affected: [{ package: { ecosystem: "PyPI", name: "django", purl: "pkg:pypi/django" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "4.2" }, { fixed: "4.2.2" }] }] }] };
    const dropped = () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
    let drops = 1;
    let calls = 0;
    vi.stubGlobal("fetch", async () => (++calls <= drops ? dropped() : Response.json({ vulns: [vuln] })));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const first = fetchAdvisories(t, { refresh: true });
      await vi.runAllTimersAsync();
      expect((await first).map((a) => a.id)).toEqual(["GHSA-AAAA-BBBB-CCCC"]);
      expect(calls).toBe(2);
      [calls, drops] = [0, 3];
      const failed = expect(fetchAdvisories(t, { refresh: true })).rejects.toThrow("OSV pkg:pypi/django: fetch failed (UND_ERR_SOCKET)");
      await vi.runAllTimersAsync();
      await failed;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  test("the fix per line inside the window: a canary-only or out-of-window patch does not count", () => {
    const a = adv("GHSA-x", [[">= 13.0.0, < 15.5.16", "15.5.16"], [">= 16.0.0, < 16.2.5", "16.2.5"], [">= 16.1.0-canary.0, < 16.1.0-canary.17", "16.1.0-canary.17"]]);
    const releases = [{ version: "15.5.16", date: "2026-05-11" }, { version: "16.2.5", date: "2026-05-11" }];
    expect(fixesInWindow(a, releases).map((f) => `${f.line}:${f.version}`)).toEqual(["15:15.5.16", "16:16.2.5"]);
    expect(fixesInWindow(a, [{ version: "16.2.5", date: "x" }])).toHaveLength(1);
  });

  test("ids come from the line the quote was taken from, not from a neighbouring item", () => {
    expect([...idsAtQuote(BODY, "Denial of Service via connection exhaustion in applications using Cache Components")]).toEqual(["GHSA-MG66-MRH9-M8JX"]);
    expect([...idsAtQuote(BODY, "Denial of Service with Server Components")]).toEqual(["GHSA-8H8Q-6873-Q5FJ"]);
    expect(idsAtQuote(BODY, "not in the notes at all").size).toBe(0);
  });

  test("attach: by id in the patched release, adding the backport line; judged; a new record when the notes omit it", async () => {
    const t = TECHNOLOGIES.next!;
    const releases = ["15.5.16", "16.2.5", "16.3.0"].map((v) => ({ version: v, date: "2026-05-11", url: `https://github.com/vercel/next.js/releases/tag/v${v}` }));
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "16.2.5.md"), BODY);
    const s: TechStore = {
      technology: "next",
      ingested: {},
      records: {
        "next:cache-components": record("next:cache-components", "16.2.5", "Denial of Service via connection exhaustion in applications using Cache Components"),
        "next:image": record("next:image", "16.3.0", "Fixed an SSRF in the image optimizer", { change_type: "fix", benefit: ["correctness"] }),
      },
    };
    const advisories = [
      adv("GHSA-MG66-MRH9-M8JX", [[">= 15.0.0, < 15.5.16", "15.5.16"], [">= 16.0.0, < 16.2.5", "16.2.5"]]),
      adv("GHSA-IMG0-IMG0-IMG0", [[">= 16.0.0, < 16.3.0", "16.3.0"]], "SSRF in Image Optimization"),
      adv("GHSA-NEW0-NEW0-NEW0", [[">= 16.0.0, < 16.3.0", "16.3.0"]], "Cache poisoning nobody wrote down"),
    ];
    const asked: string[] = [];
    const judge = async (state: Record<string, unknown>): Promise<Classification> => {
      const inc = (state.incoming as { summary: string }).summary;
      asked.push(inc);
      const cands = state.candidates as Record<string, { subject: string }>;
      const answers = Object.fromEntries(
        Object.entries(cands).map(([k, c]) => {
          const y = inc.startsWith("SSRF") && c.subject === "image" ? 0.9 : 0.1;
          return [`same_${k}`, { choice: y > 0.5 ? "yes" : "no", confidence: 0.9, probabilities: { yes: y, no: 1 - y } }];
        }),
      );
      return { classifier: "jev", model: "jev-1.13.0", answers };
    };
    const r = await attachAdvisories(t, s, advisories, releases, judge);
    expect(r).toMatchObject({ inWindow: 3, byId: 1, created: 1 });
    expect(asked).not.toContain("Advisory GHSA-MG66-MRH9-M8JX");
    const cc = s.records["next:cache-components"]!;
    expect(cc.advisories!.map((a) => a.id)).toEqual(["GHSA-MG66-MRH9-M8JX"]);
    expect(cc.releases.map((x) => x.version).sort()).toEqual(["15.5.16", "16.2.5"]);
    expect(cc.revision).toBe(2);
    // Resolved against the index: the edge compares version strings only.
    expect(cc.advisories![0]!.index).toEqual(["15.5.16", "16.2.5", "16.3.0"]);
    expect(cc.advisories![0]!.affected.map((x) => x.versions)).toEqual([[], []]);
    expect(s.records["next:image"]!.advisories![0]!.affected[0]!.versions).toEqual(["16.2.5"]);
    const img = s.records["next:image"]!;
    expect(img.advisories!.map((a) => a.id)).toEqual(["GHSA-IMG0-IMG0-IMG0"]);
    expect(img.benefit).toContain("security");
    expect(img.evidence.at(-1)).toMatchObject({ kind: "advisory", url: "https://github.com/advisories/GHSA-IMG0-IMG0-IMG0" });
    const made = Object.values(s.records).find((x) => x.advisories?.[0]?.id === "GHSA-NEW0-NEW0-NEW0")!;
    expect(made).toMatchObject({ change_type: "security", breaking: false, benefit: ["security"], summary: "Cache poisoning nobody wrote down" });
    expect(made.classifier).toBeUndefined();
    // A rerun changes nothing and asks nothing.
    const before = JSON.stringify(s);
    const n = asked.length;
    await attachAdvisories(t, s, advisories, releases, judge);
    expect(JSON.stringify(s)).toBe(before);
    expect(asked.length).toBe(n);
  });
});

describe("advisories before the release notes are read", () => {
  const t = TECHNOLOGIES.next!;
  const releases = ["16.2.5", "16.3.0"].map((v) => ({ version: v, date: "2026-05-11", url: `https://github.com/vercel/next.js/releases/tag/v${v}` }));
  const advisories = [
    adv("GHSA-MG66-MRH9-M8JX", [[">= 16.0.0, < 16.2.5", "16.2.5"]], "Denial of Service via connection exhaustion in applications using Cache Components"),
    adv("GHSA-IMG0-IMG0-IMG0", [[">= 16.0.0, < 16.3.0", "16.3.0"]], "SSRF in Image Optimization"),
    adv("GHSA-NEW0-NEW0-NEW0", [[">= 16.0.0, < 16.3.0", "16.3.0"]], "Cache poisoning nobody wrote down"),
  ];
  const asked: string[] = [];
  const judge = async (state: Record<string, unknown>): Promise<Classification> => {
    const inc = (state.incoming as { summary: string }).summary;
    asked.push(inc);
    const cands = state.candidates as Record<string, { subject: string }>;
    const answers = Object.fromEntries(
      Object.entries(cands).map(([k, c]) => {
        const y = inc.startsWith("SSRF") && c.subject === "image" ? 0.9 : 0.1;
        return [`same_${k}`, { choice: y > 0.5 ? "yes" : "no", confidence: 0.9, probabilities: { yes: y, no: 1 - y } }];
      }),
    );
    return { classifier: "jev", model: "jev-1.13.0", answers };
  };
  const holders = (s: TechStore, id: string) => Object.values(s.records).filter((r) => r.status === "active" && r.advisories?.some((a) => a.id === id)).map((r) => r.id);

  test("first pass: every advisory gets a record at once and nothing is judged; the notes, once read, take them over", async () => {
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "16.2.5.md"), BODY);
    const s: TechStore = { technology: "next", ingested: {}, records: {} };
    const unread = new Set(releases.map((r) => r.version));
    const first = await attachAdvisories(t, s, advisories, releases, async () => {
      throw new Error("no model call before the notes are read");
    }, undefined, undefined, unread);
    expect(first).toMatchObject({ inWindow: 3, judged: 0, created: 3, early: 3 });
    for (const a of advisories) expect(holders(s, a.id)).toHaveLength(1);
    const early = Object.values(s.records);
    expect(early.every((r) => r.change_type === "security" && r.evidence.every((e) => e.kind === "advisory"))).toBe(true);
    // Rerun before the notes are read: unchanged, still no model call.
    const snap = JSON.stringify(s);
    await attachAdvisories(t, s, advisories, releases, async () => {
      throw new Error("no model call");
    }, undefined, undefined, unread);
    expect(JSON.stringify(s)).toBe(snap);

    // The history lands: one record names GHSA-MG66 in 16.2.5's notes, another is the SSRF fix (no id), nothing
    // describes the third.
    s.records["next:cache-components"] = record("next:cache-components", "16.2.5", "Denial of Service via connection exhaustion in applications using Cache Components");
    s.records["next:image"] = record("next:image", "16.3.0", "Fixed an SSRF in the image optimizer", { change_type: "fix", benefit: ["correctness"] });
    const later = await attachAdvisories(t, s, advisories, releases, judge);
    // Named by id: merged with no model call; judged once each for the other two, as the stage would have after history.
    expect(asked.filter((x) => x.startsWith("Denial"))).toEqual([]);
    expect(asked).toEqual(["SSRF in Image Optimization", "Cache poisoning nobody wrote down"]);
    expect(later.standIns.map((x) => [x.advisory, x.into])).toEqual([
      ["GHSA-MG66-MRH9-M8JX", "next:cache-components"],
      ["GHSA-IMG0-IMG0-IMG0", "next:image"],
    ]);
    expect(later.settled).toBe(1);
    expect(holders(s, "GHSA-MG66-MRH9-M8JX")).toEqual(["next:cache-components"]);
    expect(holders(s, "GHSA-IMG0-IMG0-IMG0")).toEqual(["next:image"]);
    const kept = holders(s, "GHSA-NEW0-NEW0-NEW0");
    expect(kept).toHaveLength(1);
    expect(basisOf(s.records[kept[0]!]!, "GHSA-NEW0-NEW0-NEW0")).toBe("created");
    expect(basisOf(s.records["next:image"]!, "GHSA-IMG0-IMG0-IMG0")).toBe("judged");
    expect(s.records["next:image"]!.benefit).toContain("security");
    // Merged records keep their history, and their advisory evidence went with them.
    expect(Object.values(s.records).filter((r) => r.status === "merged")).toHaveLength(2);
    expect(s.records["next:image"]!.evidence.some((e) => e.kind === "advisory")).toBe(true);
    // Settled: a rerun asks nothing and changes nothing.
    const n = asked.length;
    const settled = JSON.stringify(s);
    await attachAdvisories(t, s, advisories, releases, judge);
    expect(asked.length).toBe(n);
    expect(JSON.stringify(s)).toBe(settled);
  });

  test("history read in part: only the read releases are judged; an advisory fixed in an unread one waits", async () => {
    const s: TechStore = { technology: "next", ingested: {}, records: {} };
    s.records["next:image"] = record("next:image", "16.3.0", "Fixed an SSRF in the image optimizer", { change_type: "fix", benefit: ["correctness"] });
    asked.length = 0;
    const r = await attachAdvisories(t, s, advisories, releases, judge, undefined, undefined, new Set(["16.2.5"]));
    // 16.3.0 is read: judged there; 16.2.5 is not: its advisory is a record of its own, unjudged.
    expect(asked).toEqual(["SSRF in Image Optimization", "Cache poisoning nobody wrote down"]);
    expect(r).toMatchObject({ created: 2, early: 1 });
    const mg = holders(s, "GHSA-MG66-MRH9-M8JX");
    expect(basisOf(s.records[mg[0]!]!, "GHSA-MG66-MRH9-M8JX")).toBe("early");
    expect(basisOf(s.records[holders(s, "GHSA-NEW0-NEW0-NEW0")[0]!]!, "GHSA-NEW0-NEW0-NEW0")).toBe("created");
  });

  test("a record made from an advisory, later named by id in the notes, merges into that record", async () => {
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "16.2.5.md"), BODY);
    const s: TechStore = { technology: "next", ingested: {}, records: {} };
    await attachAdvisories(t, s, advisories.slice(0, 1), releases, judge);
    const made = holders(s, "GHSA-MG66-MRH9-M8JX");
    expect(basisOf(s.records[made[0]!]!, "GHSA-MG66-MRH9-M8JX")).toBe("created");
    s.records["next:cache-components"] = record("next:cache-components", "16.2.5", "Denial of Service via connection exhaustion in applications using Cache Components");
    const r = await attachAdvisories(t, s, advisories.slice(0, 1), releases, judge);
    expect(r.standIns).toEqual([{ advisory: "GHSA-MG66-MRH9-M8JX", from: made[0], into: "next:cache-components" }]);
    expect(holders(s, "GHSA-MG66-MRH9-M8JX")).toEqual(["next:cache-components"]);
  });
});

test("PEP 440 order: dev < pre-releases < final < post; epochs first; PyPI hooks by purl type", () => {
  const order = ["1.0.dev1", "1.0a1.dev2", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1.dev1", "1.0.post1", "1.0.1", "1!0.1"];
  for (let i = 1; i < order.length; i++) expect(pep440Order(order[i - 1]!, order[i]!)).toBeLessThan(0);
  expect(pep440Order("2.0", "2.0.0")).toBe(0);
  expect(pep440Order("1.0+local", "1.0")).toBe(0);
  expect(pep440Order("latest", "1.0")).toBeUndefined();
  expect(ecosystemOf("pkg:pypi/openai").osv).toBe("PyPI");
  expect(ecosystemOf("pkg:pypi/openai").compare).toBe(pep440Order);
});
