// Static export: a self-contained tree (root, indexes, every referenced shard verified, `.nojekyll`), byte-identical
// on a rerun, technology indexes byte-identical to what the coverage service serves (its `components`), pruned first,
// built aside so a failed export never replaces a good one.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DISCOVERY_VERSION } from "../src/onboarding/discovery.ts";
import { CoverageService, createCoverageServer } from "../src/onboarding/service.ts";
import { exportCatalog, savedJobs } from "../src/pipeline/export.ts";
import { catalogDir, centralDir } from "../src/pipeline/paths.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { sha256 } from "../src/pipeline/util.ts";
import { store } from "./catalog-fixture.ts";

const CHECKED = "2026-10-15T06:00:00Z";
const T0 = new Date("2026-10-01T00:00:00Z");
const days = (n: number): Date => new Date(T0.getTime() + n * 24 * 3600 * 1000);

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = createHash("sha256").update(readFileSync(join(d, e.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

function job(technology: string, purl: string, discovery_version: number) {
  const dir = join(centralDir(), "onboarding", "jobs");
  mkdirSync(dir, { recursive: true });
  const descriptor = { discovery_version, purl, id: technology, name: technology, latest: "1.0.0", tag: "v{version}", components: [purl, `${purl}-extra`] };
  const j = { schema: 1, purl, technology, name: technology, state: "monitoring", stage: "done", updated: CHECKED, descriptor, records: 2, releases_done: 1, releases_total: 1, docs_done: 0, docs_total: 0, docs_failed: 0 };
  writeFileSync(join(dir, `${sha256(purl)}.json`), JSON.stringify(j));
}

const previous = process.env.UNSTALE_STORE;
let out: string;
beforeEach(() => {
  process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-export-"));
  out = join(mkdtempSync(join(tmpdir(), "unstale-export-out-")), "site");
  publishTechnology(store(), CHECKED, catalogDir(), undefined, T0);
  publishTechnology({ ...store(), technology: "other" }, CHECKED, catalogDir(), undefined, T0);
  job("next", "pkg:npm/next", DISCOVERY_VERSION);
  job("other", "pkg:npm/other", DISCOVERY_VERSION - 1); // an older discovery: the service drops the descriptor
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
});

describe("export", () => {
  test("self-contained and byte-identical on a rerun; history and central state stay out", () => {
    const r = exportCatalog(catalogDir(), out, { now: T0 });
    expect(r).toMatchObject({ technologies: 2, shards: 4 });
    const first = files(out);
    expect(Object.keys(first)).toEqual(expect.arrayContaining([".nojekyll", "v1/root.json", "v1/tech/next.json", "v1/tech/other.json"]));
    expect(Object.keys(first).filter((p) => !p.startsWith("v1/") && p !== ".nojekyll")).toEqual([]);
    for (const tech of ["next", "other"]) {
      const index = JSON.parse(readFileSync(join(out, "v1", "tech", `${tech}.json`), "utf8")) as { shards: { path: string; sha256: string }[] };
      for (const s of index.shards) expect(first[s.path]).toBe(s.sha256);
    }
    expect(readFileSync(join(out, "v1", "root.json"))).toEqual(readFileSync(join(catalogDir(), "v1", "root.json")));
    exportCatalog(catalogDir(), out, { now: T0 });
    expect(files(out)).toEqual(first);
    expect(readdirSync(join(out, ".."))).toEqual(["site"]); // no partial or old tree left beside it
  });

  test("technology indexes are the bytes the service route serves, components included", async () => {
    exportCatalog(catalogDir(), out, { now: T0 });
    const server = createCoverageServer(new CoverageService(0));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      for (const tech of ["next", "other"]) {
        const served = Buffer.from(await (await fetch(`${base}/v1/tech/${tech}.json`)).arrayBuffer());
        expect(readFileSync(join(out, "v1", "tech", `${tech}.json`))).toEqual(served);
      }
    } finally {
      server.close();
    }
    expect(JSON.parse(readFileSync(join(out, "v1", "tech", "next.json"), "utf8")).components).toEqual(["pkg:npm/next", "pkg:npm/next-extra"]);
    expect(JSON.parse(readFileSync(join(out, "v1", "tech", "other.json"), "utf8")).components).toBeUndefined();
    expect(savedJobs().filter((j) => j.descriptor).map((j) => j.technology)).toEqual(["next"]);
  });

  test("the source is pruned first: only referenced and in-grace shards are exported", () => {
    const before = JSON.parse(readFileSync(join(catalogDir(), "v1", "tech", "next.json"), "utf8")).shards.map((s: { path: string }) => s.path) as string[];
    publishTechnology(store("Adds b, corrected."), CHECKED, catalogDir(), undefined, days(1));
    const old = before.find((p) => !JSON.parse(readFileSync(join(catalogDir(), "v1", "tech", "next.json"), "utf8")).shards.some((s: { path: string }) => s.path === p))!;
    exportCatalog(catalogDir(), out, { now: days(5) });
    expect(existsSync(join(out, old))).toBe(true); // inside the grace period: still served
    const r = exportCatalog(catalogDir(), out, { now: days(9) });
    expect(r.prune.deleted).toEqual([old]);
    expect(existsSync(join(out, old))).toBe(false);
    expect(existsSync(join(catalogDir(), old))).toBe(false);
  });

  test("a failed check leaves the previous export in place and no partial tree", () => {
    exportCatalog(catalogDir(), out, { now: T0 });
    const good = files(out);
    const shard = JSON.parse(readFileSync(join(catalogDir(), "v1", "tech", "next.json"), "utf8")).shards[0].path as string;
    copyFileSync(join(catalogDir(), "v1", "root.json"), join(catalogDir(), shard)); // wrong bytes under the shard's name
    expect(() => exportCatalog(catalogDir(), out, { now: T0 })).toThrow(/does not match its size and sha256/);
    expect(files(out)).toEqual(good);
    expect(readdirSync(join(out, ".."))).toEqual(["site"]);
  });

  test("refuses a directory that is not a previous export, or one overlapping the catalog", () => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "notes.txt"), "mine");
    expect(() => exportCatalog(catalogDir(), out, { now: T0 })).toThrow(/refusing to replace/);
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");
    expect(() => exportCatalog(catalogDir(), join(catalogDir(), "site"), { now: T0 })).toThrow(/overlaps/);
  });
});
