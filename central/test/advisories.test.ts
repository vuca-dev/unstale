// Security advisories (advisories.ts): OSV entries read into advisories, ranges resolved against the release index
// (SemVer, an ecosystem's order, explicit lists, unresolved otherwise), range syntax for the npm reference, the fix per
// release line inside the window, ids taken from the release-notes line a quote came from (never a neighbouring list
// item), and attaching advisories to records.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attachAdvisories, fixesInWindow, fromOsv, idsAtQuote, inRange, resolveRange, semverCmp, type Advisory, type AffectedRange } from "../src/pipeline/advisories.ts";
import { ecosystemOf, githubRepo, pep440Order } from "../src/pipeline/ecosystems.ts";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";

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

test("PEP 440 order: dev < pre-releases < final < post; epochs first; PyPI hooks by purl type", () => {
  const order = ["1.0.dev1", "1.0a1.dev2", "1.0a1", "1.0b2", "1.0rc1", "1.0", "1.0.post1.dev1", "1.0.post1", "1.0.1", "1!0.1"];
  for (let i = 1; i < order.length; i++) expect(pep440Order(order[i - 1]!, order[i]!)).toBeLessThan(0);
  expect(pep440Order("2.0", "2.0.0")).toBe(0);
  expect(pep440Order("1.0+local", "1.0")).toBe(0);
  expect(pep440Order("latest", "1.0")).toBeUndefined();
  expect(ecosystemOf("pkg:pypi/openai").osv).toBe("PyPI");
  expect(ecosystemOf("pkg:pypi/openai").compare).toBe(pep440Order);
});
