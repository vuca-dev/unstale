// The term-rarity sample: the selection rule's parts, counting only terms not yet counted against the recorded commits,
// and publishing counts in `terms` with `sample_n` and the repositories in the index.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { publishTechnology, shardLine } from "../src/pipeline/publish.ts";
import { cloneDir, declaredMajor, declaresAtMajor, excluded, majorsFor, manifestPaths, namingTopics, sampleCounts, saveSample, type SampleFile } from "../src/pipeline/sample.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-sample-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const meta = (over: Record<string, unknown> = {}) => ({
  full_name: "acme/shop",
  fork: false,
  archived: false,
  is_template: false,
  stargazers_count: 10,
  size: 1000,
  description: "An online shop",
  topics: [] as string[],
  default_branch: "main",
  ...over,
});

describe("sample selection rule", () => {
  test("declared major of a range", () => {
    expect(["^16.1.0", "16.2.6", "~16.0", ">=16.0.0 <17", "16", "16.x", "npm:next@^16.1.0"].map(declaredMajor)).toEqual(Array(7).fill("16"));
    expect([undefined, "latest", "*", "workspace:*", "github:vercel/next.js", 16].map(declaredMajor)).toEqual(Array(6).fill(undefined));
  });

  test("a package.json qualifies by dependencies or devDependencies at the major, not peerDependencies", () => {
    const names = ["prisma", "@prisma/client"];
    expect(declaresAtMajor({ dependencies: { "@prisma/client": "^7.2.0" } }, names, "7")).toBe("@prisma/client@^7.2.0");
    expect(declaresAtMajor({ devDependencies: { prisma: "7.1.0" } }, names, "7")).toBe("prisma@7.1.0");
    expect(declaresAtMajor({ dependencies: { prisma: "^6.19.0" } }, names, "7")).toBeUndefined();
    expect(declaresAtMajor({ peerDependencies: { prisma: "^7.0.0" } }, names, "7")).toBeUndefined();
  });

  test("exclusions by metadata: evaluation repositories and their forks, forks, archived, templates, own org, teaching words, size", () => {
    const t = TECHNOLOGIES.next!;
    expect(excluded(meta(), t)).toBeUndefined();
    expect(excluded(meta({ full_name: "Snouzy/workout-cool" }), t)).toBe("evaluation repository");
    expect(excluded(meta({ fork: true, parent: { full_name: "invoicerr-app/invoicerr" } }), t)).toBe("fork of an evaluation repository");
    expect(excluded(meta({ fork: true }), t)).toBe("fork");
    expect(excluded(meta({ archived: true }), t)).toBe("archived");
    expect(excluded(meta({ is_template: true }), t)).toBe("template repository");
    expect(excluded(meta({ full_name: "vercel/commerce" }), t)).toBe("the technology's own organisation");
    expect(excluded(meta({ full_name: "jo/nextjs-dashboard-tutorial" }), t)).toBe('not a project ("tutorial")');
    expect(excluded(meta({ full_name: "jo/airbnbClone" }), t)).toBe('not a project ("Clone")');
    expect(excluded(meta({ description: "A starter for SaaS apps" }), t)).toBe('not a project ("starter")');
    expect(excluded(meta({ topics: ["nextjs-example"] }), t)).toBe('not a project ("example")');
    expect(excluded(meta({ size: 250_000 }), t)).toBe("over 200 MB");
    expect(excluded(meta({ full_name: "EUDIPLO/eudiplo" }), TECHNOLOGIES.nestjs!)).toBe("evaluation repository");
    expect(excluded(meta({ fork: true, source: { full_name: "cedarjs/cedar" } }), TECHNOLOGIES.prisma!)).toBe("fork of an evaluation repository");
  });

  test("majors by rule: current, previous (current - 1), mix (ceil(n/2) previous first)", () => {
    expect(majorsFor({ pool: "adoption", major: "current", n: 5 }, "16")).toEqual([{ major: "16", take: 5 }]);
    expect(majorsFor({ pool: "adoption", major: "previous", n: 5 }, "7")).toEqual([{ major: "6", take: 5 }]);
    expect(majorsFor({ pool: "code-search", major: "mix", n: 5 }, "12")).toEqual([
      { major: "11", take: 3 },
      { major: "12", take: 2 },
    ]);
  });

  test("adoption topic candidates: the repository's topics equal to its repository or unscoped package name", () => {
    expect(namingTopics(["nextjs", "react", "vercel", "node"], TECHNOLOGIES.next!)).toEqual(["nextjs"]);
    expect(namingTopics(["orm", "prisma", "prisma-client"], TECHNOLOGIES.prisma!)).toEqual(["prisma"]);
    expect(namingTopics(["nest", "nestjs", "nodejs"], TECHNOLOGIES.nestjs!)).toEqual(["nest"]);
  });

  test("adoption manifests: package.json blobs, shallowest first, none under fixtures, tests, node_modules or examples", () => {
    const tree = ["apps/web/package.json", "package.json", "test/fixtures/a/package.json", "node_modules/x/package.json", "examples/blog/package.json", "packages/ui/package.json", "src/package.json.bak"];
    expect(manifestPaths(tree.map((path) => ({ path, type: "blob" })))).toEqual(["package.json", "apps/web/package.json", "packages/ui/package.json"]);
  });
});

describe("counting and publishing", () => {
  test("only terms not yet counted are counted, against the recorded commits; counts are capped at n", () => {
    const repo = "acme/shop";
    const d = cloneDir("next", repo);
    mkdirSync(d, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(d, "a.ts"), "x");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
    const commit = git("rev-parse", "HEAD");
    const s: SampleFile = { technology: "next", rule: "", query: "", major: "16", drawn: "", candidates: 1, passed_over: [], counts: { "next/image": 1 }, repos: [{ repo, commit, stars: 1, manifest: "package.json", declares: "next@16" }] };
    saveSample(s);
    const asked: string[][] = [];
    const counter = (dirs: string[], terms: string[]) => {
      asked.push(terms);
      expect(dirs).toEqual([d]);
      return Object.fromEntries(terms.map((t) => [t, t === "constructor" ? 1 : 7]));
    };
    const out = sampleCounts("next", ["next/image", "cacheLife", "constructor"], counter)!;
    expect(asked).toEqual([["cacheLife", "constructor"]]);
    expect(out.counts).toEqual({ cacheLife: 1, constructor: 1, "next/image": 1 });
    expect(sampleCounts("next", ["cacheLife"], counter)!.n).toBe(1);
    expect(asked).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(process.env.UNSTALE_CENTRAL_DIR!, "sample", "next", "sample.json"), "utf8")).counts.cacheLife).toBe(1);
  });

  test("published terms carry their counts (own keys only); the index carries sample_n and the repositories", () => {
    const r = {
      id: "next:x", technology: "next", status: "active", revision: 1, label_version: 1, change_type: "fix", breaking: false, surface: "code_api",
      subject: "x", subject_kind: "literal", summary: "s", benefit: ["none"],
      releases: [{ component: "pkg:npm/next", version: "16.1.0", date: "2026-01-01", line: "16" }],
      prerequisites: [], conditions: [], requires: [], introduces: [], terms: ["cacheLife", "constructor", "toString"], replaces: [],
      evidence: [{ kind: "release_notes", url: "u", quote: "q", snapshot: "sha256:a" }], related: [], sources: [], history: [],
    } as unknown as StoredRecord;
    const counts = { cacheLife: 3, constructor: 2 };
    expect((shardLine(r, true, counts) as { terms: unknown }).terms).toEqual([["cacheLife", 3], ["constructor", 2], ["toString", 0]]);
    const store: TechStore = { technology: "next", records: { [r.id]: r }, ingested: {} };
    const dir = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    const { index } = publishTechnology(store, "2026-10-15T00:00:00Z", dir, { n: 5, repos: [{ repo: "a/b", commit: "c".repeat(40) }], counts });
    expect(index).toMatchObject({ sample_n: 5, sample: [{ repo: "a/b", commit: "c".repeat(40) }] });
    const none = publishTechnology(store, "2026-10-15T00:00:00Z", mkdtempSync(join(tmpdir(), "unstale-pub-")));
    expect(none.index.sample_n).toBe(0);
    expect("sample" in none.index).toBe(false);
  });
});
