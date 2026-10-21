// Records read only from another technology's upgrade guide (ingested before `ownGuide`) are retracted, so the next
// publish drops them; a record with any other source keeps its place.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchGuides, foreignGuides } from "../src/pipeline/fetch.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { retractForeignGuideRecords, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
import { techLocal } from "../src/state/client.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-foreign-"));
  process.env.UNSTALE_CENTRAL_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const T: Technology = { id: "npm-to-yarn-eec817e0", name: "npm-to-yarn", repo: "nebrelbug/npm-to-yarn", components: ["pkg:npm/npm-to-yarn"], tag: /^v(\d+\.\d+\.\d+)$/, clean: (b) => b };
const C = T.components[0]!;
// A docs generator's own guide (ownGuide rule 4) and the package's own.
const FOREIGN = "https://docusaurus.io/docs/migration/v3";
const OWN = "https://npm-to-yarn.example.dev/docs/migrating-to-v3";
const guide = (url: string, snap: string) => ({ technology: T.id, kind: "upgrade_guide", tag: "guide-3", version: "3.0.0", date: "2026-10-19", url, snapshot: `sha256:${snap}`, keyTag: `+guide.${snap.slice(0, 8)}` });

const record = (id: string, urls: string[], over: Partial<StoredRecord> = {}): StoredRecord => ({
  id,
  technology: T.id,
  status: "active",
  revision: 1,
  label_version: 1,
  change_type: "removal",
  breaking: true,
  surface: "code_api",
  subject: id,
  subject_kind: "literal",
  summary: "Removed.",
  benefit: [],
  releases: [{ component: C, version: "3.0.0", date: "2026-10-19", line: "3" }],
  prerequisites: [],
  conditions: [],
  requires: [],
  introduces: [],
  terms: [],
  replaces: [],
  evidence: urls.map((url) => ({ kind: "upgrade_guide" as const, url, quote: "q", snapshot: "sha256:x" })),
  related: [],
  sources: [`${T.id}@3.0.0+guide.aaaaaaaa#0.0`],
  history: [],
  ...over,
});

describe("records read only from another technology's upgrade guide", () => {
  test("are retracted; one with another source, or from the technology's own guide, stays", async () => {
    const gdir = join(dir, "guides", techLocal(T.id));
    writeAtomic(join(gdir, "index.json"), JSON.stringify({ checked: "2026-10-20T00:00:00Z", guides: [guide(FOREIGN, "aaaaaaaa11"), guide(OWN, "bbbbbbbb22")] }));
    writeAtomic(join(gdir, "3.aaaaaaaa.md"), "# foreign");
    writeAtomic(join(gdir, "3.bbbbbbbb.md"), "# own");
    // The same rule decides what is no longer a source and what is retracted.
    expect(foreignGuides(T)).toEqual(new Set([FOREIGN]));
    expect((await fetchGuides(T, [], { offline: true })).map((g) => g.url)).toEqual([OWN]);

    const wrong = record(`${T.id}:wrong`, [FOREIGN]);
    const own = record(`${T.id}:own`, [OWN]);
    const mixed = record(`${T.id}:mixed`, [FOREIGN, "https://github.com/nebrelbug/npm-to-yarn/releases/tag/v3.0.0"]);
    const linked = record(`${T.id}:linked`, [OWN], { related: [wrong.id] });
    const s: TechStore = { technology: T.id, records: Object.fromEntries([wrong, own, mixed, linked].map((r) => [r.id, r])), ingested: { k: wrong.id } };

    expect(retractForeignGuideRecords(s, foreignGuides(T))).toEqual([wrong.id]);
    expect(s.records[wrong.id]!.status).toBe("retracted");
    expect(s.records[wrong.id]!.history.at(-1)!.detail).toContain(FOREIGN);
    expect([own, mixed, linked].map((r) => r.status)).toEqual(["active", "active", "active"]);
    expect(linked.related).toEqual([]);
    // Idempotent: a later run retracts nothing more and leaves the store as it was.
    const before = JSON.stringify(s);
    expect(retractForeignGuideRecords(s, foreignGuides(T))).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);

    // Published as a retraction stub, so clients drop it.
    const out = mkdtempSync(join(tmpdir(), "unstale-foreign-catalog-"));
    const p = publishTechnology(s, "2026-10-20T00:00:00Z", out);
    const lines = p.index.shards.flatMap((sh) => gunzipSync(readFileSync(join(out, sh.path))).toString().trim().split("\n").map((l) => JSON.parse(l)));
    expect(lines.find((l) => l.id === wrong.id)).toEqual({ status: "retracted", id: wrong.id });
    expect(lines.filter((l) => l.status === "active").map((l) => l.id).sort()).toEqual([linked.id, mixed.id, own.id].sort());
  });

  test("no guide index: nothing is foreign", () => {
    expect(foreignGuides({ ...T, id: "no-guides" })).toEqual(new Set());
  });
});
