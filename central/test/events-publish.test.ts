// Change events in the published catalog: signed, content-addressed shards in the records' layout, named in the
// index's `events`; exported and verified with the records, pruned after their grace like them, and leaving the record
// shards (what older clients read) byte for byte as they were.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { recordNotes } from "../src/pipeline/events.ts";
import { catalogSigner, exportCatalog } from "../src/pipeline/export.ts";
import { catalogDir } from "../src/pipeline/paths.ts";
import { pruneCatalog } from "../src/pipeline/prune.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { sha256 } from "../src/pipeline/util.ts";
import { EventLine, TechIndex } from "../src/schema/catalog.ts";
import { store } from "./catalog-fixture.ts";

const REPO = join(import.meta.dirname, "..", "..");
const CHECKED = "2026-10-15T06:00:00Z";
const T0 = new Date("2026-10-01T00:00:00Z");
const days = (n: number): Date => new Date(T0.getTime() + n * 24 * 3600 * 1000);
const T = { id: "next", name: "Next.js", components: ["pkg:npm/next"] };
const note = (version: string, notes: string) => ({
  technology: "next",
  tag: `v${version}`,
  version,
  date: "2026-09-30",
  url: `https://github.com/vercel/next.js/releases/tag/v${version}`,
  snapshot: `sha256:${sha256(notes)}`,
  notes,
});

const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-events-pub-"));
  vi.stubEnv("UNSTALE_NOTICE", join(process.env.UNSTALE_STORE, "no-notice.json"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.unstubAllEnvs();
});

const index = (dir = catalogDir()) => TechIndex.parse(JSON.parse(readFileSync(join(dir, "v1", "tech", "next.json"), "utf8")));

describe("change events in the catalog", () => {
  test("one content-addressed shard per release line, named in the index's events; record shards unchanged", () => {
    const before = mkdtempSync(join(tmpdir(), "unstale-events-pub-"));
    publishTechnology(store(), CHECKED, before, undefined, T0);
    recordNotes(T, "releases", [note("15.5.0", "## Fixes\n- Fixes `next build` on Windows"), note("16.0.0", "## Breaking\n- Node.js 20 is required"), note("16.1.0", "- Adds `images.qualities`")], T0);
    const p = publishTechnology(store(), CHECKED, catalogDir(), undefined, T0);
    const idx = index();
    expect(idx.events?.map((e) => [e.line, e.records])).toEqual([["15", 1], ["16", 2]]);
    for (const e of idx.events!) {
      expect(e.path).toMatch(new RegExp(`^v1/shards/next/${e.line}\\.events\\.${e.sha256.slice(0, 16)}\\.jsonl\\.gz$`));
      const gz = readFileSync(join(catalogDir(), e.path));
      expect([gz.length, sha256(gz)]).toEqual([e.bytes, e.sha256]);
      for (const l of gunzipSync(gz).toString().trim().split("\n")) expect(EventLine.parse(JSON.parse(l)).line).toBe(e.line);
    }
    expect(p.bytes).toBe([...idx.shards, ...idx.events!].reduce((s, x) => s + x.bytes, 0));
    // The records an older client reads: the same shards, the same bytes, as a publish without events.
    expect(idx.shards).toEqual(index(before).shards);
    for (const s of idx.shards) expect(readFileSync(join(catalogDir(), s.path))).toEqual(readFileSync(join(before, s.path)));
  });

  test("exported with the records: checked against the index, which is signed; a tampered shard stops the export", () => {
    recordNotes(T, "releases", [note("16.0.0", "## Breaking\n- Node.js 20 is required")], T0);
    publishTechnology(store(), CHECKED, catalogDir(), undefined, T0);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const out = join(mkdtempSync(join(tmpdir(), "unstale-events-site-")), "site");
    exportCatalog(catalogDir(), out, { now: T0, jobs: [], sign: catalogSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString()) });
    const ref = index(out).events![0]!;
    expect(readFileSync(join(out, ref.path))).toEqual(readFileSync(join(catalogDir(), ref.path)));
    // The deploy's guard (ingest.yml) verifies event shards as it verifies record shards.
    const key = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
    const verifyCatalog = () => spawnSync(process.execPath, [join(REPO, ".github", "scripts", "verify-catalog.mjs"), out], { env: { ...process.env, UNSTALE_CATALOG_KEY: key }, encoding: "utf8" });
    const ok = verifyCatalog();
    expect(ok.status, ok.stderr).toBe(0);
    writeFileSync(join(out, ref.path), Buffer.concat([readFileSync(join(out, ref.path)), Buffer.from([0])]));
    const bad = verifyCatalog();
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain(`${ref.path}: ${ref.bytes + 1} bytes`);
    // A source shard that does not match its index is refused before anything replaces the export.
    writeFileSync(join(catalogDir(), ref.path), "not gzip");
    expect(() => exportCatalog(catalogDir(), join(mkdtempSync(join(tmpdir(), "unstale-events-site-")), "site"), { now: T0, jobs: [], sign: undefined })).toThrow(/does not match its size and sha256/);
  });

  test("a superseded event shard keeps its grace period and is then pruned; the current one never is", () => {
    recordNotes(T, "releases", [note("16.0.0", "## Breaking\n- Node.js 20 is required")], T0);
    publishTechnology(store(), CHECKED, catalogDir(), undefined, T0);
    const old = index().events![0]!.path;
    // A new release on line 16: a new shard for the line, the old one unreferenced from now.
    recordNotes(T, "releases", [note("16.0.0", "## Breaking\n- Node.js 20 is required"), note("16.1.0", "- Adds `images.qualities`")], days(1));
    publishTechnology(store(), CHECKED, catalogDir(), undefined, days(1));
    const current = index().events![0]!.path;
    expect(current).not.toBe(old);
    expect(pruneCatalog(catalogDir(), { now: days(5) }).kept).toEqual([old]);
    const r = pruneCatalog(catalogDir(), { now: days(9) });
    expect(r.deleted).toEqual([old]);
    expect([existsSync(join(catalogDir(), old)), existsSync(join(catalogDir(), current))]).toEqual([false, true]);
    expect(pruneCatalog(catalogDir(), { now: days(400) }).deleted).toEqual([]);
  });
});
