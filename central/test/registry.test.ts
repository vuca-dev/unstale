// Prerequisite names against the npm registry: one cached request per name, platform names never asked, a missing
// name moved to `conditions` as prose (fails open), the record's history saying what was checked.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkIncoming, checkStore } from "../src/pipeline/prereqs.ts";
import { applyChecks, asProse, checkNames, checkNpmName, type Fetcher } from "../src/pipeline/registry.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-registry-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

function registry(known: string[], fail: string[] = []): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    urls.push(url);
    const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
    if (fail.includes(name)) return new Response("busy", { status: 503 });
    return new Response(known.includes(name) ? "{}" : "{\"error\":\"Not found\"}", { status: known.includes(name) ? 200 : 404 });
  };
  return { fetcher, urls };
}

describe("npm registry check", () => {
  test("one request per distinct name, cached across calls; platform and impossible names make none", async () => {
    const r = registry(["typescript", "@prisma/client"]);
    const checks = await checkNames(["typescript", "typescript", "@prisma/client", "prisma-orm-x", "node", "npm", "Node.js 20"], r.fetcher);
    expect(Object.fromEntries([...checks].map(([k, v]) => [k, v.status]))).toEqual({
      typescript: "exists",
      "@prisma/client": "exists",
      "prisma-orm-x": "missing",
      node: "platform",
      npm: "platform",
      "Node.js 20": "missing",
    });
    expect(r.urls.sort()).toEqual([
      "https://registry.npmjs.org/@prisma%2Fclient",
      "https://registry.npmjs.org/prisma-orm-x",
      "https://registry.npmjs.org/typescript",
    ]);
    const again = registry([]);
    expect((await checkNpmName("typescript", again.fetcher)).status).toBe("exists");
    expect(again.urls).toEqual([]);
  });

  test("a registry that keeps failing leaves the name unchecked (kept), and nothing is cached", async () => {
    const r = registry([], ["flaky-pkg"]);
    expect((await checkNpmName("flaky-pkg", r.fetcher)).status).toBe("unchecked");
    expect(r.urls).toHaveLength(3);
    const ok = registry(["flaky-pkg"]);
    expect((await checkNpmName("flaky-pkg", ok.fetcher)).status).toBe("exists");
  }, 20_000);

  test("a missing name moves to conditions as prose; other ecosystems and existing names stay", async () => {
    const r = registry(["react"]);
    const checks = await checkNames(["react", "no-such-pkg-zz"], r.fetcher);
    const ps = [
      { ecosystem: "npm", name: "react", min: "19.0.0" },
      { ecosystem: "npm", name: "no-such-pkg-zz", min: "2.0.0", max: "3.0.0" },
      { ecosystem: "pypi", name: "no-such-pkg-zz" },
    ];
    expect(applyChecks(ps, checks)).toEqual({
      keep: [ps[0], ps[2]],
      prose: ["no-such-pkg-zz >= 2.0.0 <= 3.0.0"],
      missing: ["no-such-pkg-zz"],
    });
    expect(asProse({ ecosystem: "npm", name: "x" })).toBe("x");
  });

  test("incoming records are corrected before ingest and carry the history line", async () => {
    const r = registry(["typescript"]);
    const inc = { prerequisites: [{ ecosystem: "npm", name: "typescript", min: "5.1.0" }, { ecosystem: "npm", name: "ts-nope-zz", min: "1.0.0" }], conditions: [] } as never;
    const incs = [inc] as Array<{ prerequisites: Array<{ name: string }>; conditions: string[]; registry?: string }>;
    expect(await checkIncoming(incs as never, r.fetcher)).toBe(1);
    expect(incs[0]!.prerequisites.map((p) => p.name)).toEqual(["typescript"]);
    expect(incs[0]!.conditions).toEqual(["ts-nope-zz >= 1.0.0"]);
    expect(incs[0]!.registry).toBe("npm registry: ts-nope-zz missing, typescript exists; moved to conditions: ts-nope-zz");
  });

  test("a store: missing names bump revision once; a rerun adds nothing", async () => {
    const rec = (id: string, prerequisites: StoredRecord["prerequisites"]) =>
      ({ id, status: "active", revision: 1, label_version: 1, prerequisites, conditions: [], history: [] }) as unknown as StoredRecord;
    const s: TechStore = {
      technology: "next",
      records: { a: rec("a", [{ ecosystem: "npm", name: "react", min: "19.0.0" }]), b: rec("b", [{ ecosystem: "npm", name: "react-nope-zz", min: "1.0.0" }]), c: rec("c", []) },
      ingested: {},
    };
    const r = registry(["react"]);
    const out = await checkStore(s, r.fetcher);
    expect(out).toMatchObject({ records: 2, names: ["react", "react-nope-zz"], missing: [{ id: "b", name: "react-nope-zz", prose: "react-nope-zz >= 1.0.0" }], revisionBumps: 1 });
    expect(s.records.a!.revision).toBe(1);
    expect(s.records.a!.history).toEqual([{ action: "prerequisite-check", detail: "npm registry: react exists", revision: 1, label_version: 1 }]);
    expect(s.records.b).toMatchObject({ revision: 2, prerequisites: [], conditions: ["react-nope-zz >= 1.0.0"] });
    expect(s.records.c!.history).toEqual([]);
    const again = await checkStore(s, registry([]).fetcher);
    expect(again.revisionBumps).toBe(0);
    expect(s.records.a!.history).toHaveLength(1);
    expect(s.records.b!.history).toHaveLength(1);
  });
});
