// An upgrade guide listed on a monorepo's shared docs site names the version line of the package the site is named
// after: electron-builder's "What's new in v27" was read as electron-updater 27.0.0, a version electron-updater never
// published (its latest is 6.8.11), and the client proposed "electron-updater 6.8.10 → 27.0.0". Such a guide is read
// at the technology's release that shipped with it (published the same day as a sibling's version), else it is no
// source and its records lose that release.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchGuides, guideBounds, guideVersions, indexGuideVersions, shippedWith } from "../src/pipeline/fetch.ts";
import { registryCache } from "../src/pipeline/registry.ts";
import { relineGuideRecords, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { sha256, writeAtomic } from "../src/pipeline/util.ts";
import { techLocal } from "../src/state/client.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-sibling-line-"));
  process.env.UNSTALE_CENTRAL_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const times = (purl: string, t: Record<string, string>) => registryCache().put(`npm/times/${sha256(purl).slice(0, 32)}`, JSON.stringify({ checked: now(), times: t }) + "\n");
const siblings = (t: Technology, purls: string[]) =>
  writeAtomic(join(dir, "advisories", techLocal(t.id), "repository-packages.json"), JSON.stringify({ checked: now(), packages: purls.map((purl) => ({ purl, name: purl.slice(8), description: "" })) }));
const guide = (t: Technology, url: string, major: string, snap: string) => {
  const g = { technology: t.id, kind: "upgrade_guide", tag: `guide-${major}`, version: `${major}.0.0`, date: "2026-10-20", url, snapshot: `sha256:${snap}`, keyTag: `+guide.${snap.slice(0, 8)}`, via: "linked", read: "2026-10-20" };
  writeAtomic(join(dir, "guides", techLocal(t.id), `${major}.${snap.slice(0, 8)}.md`), `# What's new in v${major}\n`);
  return g;
};

const record = (t: Technology, id: string, snapshots: string[], versions: string[]): StoredRecord => ({
  id,
  technology: t.id,
  status: "active",
  revision: 1,
  label_version: 1,
  change_type: "behavior_change",
  breaking: false,
  surface: "runtime_internal",
  subject: id,
  subject_kind: "literal",
  summary: "Changed.",
  benefit: [],
  releases: versions.map((version) => ({ component: t.components[0]!, version, date: "2026-10-20", line: version.split(".")[0]!, ...(version === "27.0.0" ? { no_later_than: "27.1.0" } : {}) })),
  prerequisites: [],
  conditions: [],
  requires: [],
  introduces: [],
  terms: [],
  replaces: [],
  evidence: snapshots.map((snapshot) => ({ kind: "upgrade_guide" as const, url: "https://example.dev/" + snapshot, quote: "q", snapshot })),
  related: [],
  sources: [],
  history: [],
});

describe("a guide for a version the technology never published", () => {
  test("shippedWith: the technology's own major start published the same day as the sibling's version", () => {
    const published = new Map([["6.8.11", "2026-10-01"], ["7.0.0", "2026-11-02"], ["7.0.1", "2026-11-02"]]);
    expect(shippedWith(published, ["2026-11-02"])).toBe("7.0.0");
    expect(shippedWith(published, ["2026-10-01"])).toBeUndefined(); // a patch is no major's counterpart
    expect(shippedWith(published, [])).toBeUndefined();
  });

  test("is no source when unmapped, is read at the release that shipped with it when mapped, and a published one is untouched", async () => {
    const T: Technology = { id: "electron-updater-ffc22827", name: "electron-updater", repo: "electron-userland/electron-builder", components: ["pkg:npm/electron-updater"], tag: /^electron-updater@(\d+\.\d+\.\d+)$/, clean: (b) => b };
    const V27 = guide(T, "https://www.electron.build/docs/migration/whats-new-v27", "27", "aaaaaaaa11");
    const V26 = guide(T, "https://www.electron.build/docs/migration/whats-new-v26", "26", "bbbbbbbb22");
    const V6 = guide(T, "https://www.electron.build/docs/migration/updater-v6", "6", "cccccccc33");
    writeAtomic(join(dir, "guides", techLocal(T.id), "index.json"), JSON.stringify({ checked: now(), guides: [V27, V26, V6] }));
    times("pkg:npm/electron-updater", { "6.0.0": "2023-06-01T10:00:00Z", "6.8.11": "2026-10-01T10:00:00Z", "7.0.0": "2026-09-15T10:00:00Z" });
    times("pkg:npm/electron-builder", { "26.0.0": "2026-09-15T09:58:00Z", "27.0.0-alpha.6": "2026-10-10T00:00:00Z" });
    siblings(T, ["pkg:npm/electron-updater", "pkg:npm/electron-builder"]);

    const moved = await indexGuideVersions(T, { offline: true });
    expect(Object.fromEntries(moved)).toEqual({
      "sha256:aaaaaaaa11": { from: "27.0.0" },
      "sha256:bbbbbbbb22": { from: "26.0.0", to: "7.0.0", date: "2026-09-15" },
    });
    const notes = await fetchGuides(T, [], { offline: true });
    expect(notes.map((g) => [g.url, g.version, g.date])).toEqual([
      [V26.url, "7.0.0", "2026-09-15"],
      [V6.url, "6.0.0", "2026-10-20"],
    ]);

    // Records already read from them: moved to the release that shipped with it, or the release dropped (a record left
    // with none retracted); another source's release stays.
    const only27 = record(T, `${T.id}:only27`, ["sha256:aaaaaaaa11"], ["27.0.0"]);
    const mixed = record(T, `${T.id}:mixed`, ["sha256:aaaaaaaa11", "sha256:other"], ["6.8.11", "27.0.0"]);
    const from26 = record(T, `${T.id}:from26`, ["sha256:bbbbbbbb22"], ["26.0.0"]);
    const own = record(T, `${T.id}:own`, ["sha256:cccccccc33"], ["6.0.0"]);
    const s: TechStore = { technology: T.id, records: Object.fromEntries([only27, mixed, from26, own].map((r) => [r.id, r])), ingested: {} };
    expect(relineGuideRecords(s, moved)).toEqual({ moved: 1, dropped: 1, retracted: [only27.id] });
    expect(s.records[only27.id]!.status).toBe("retracted");
    expect(mixed.releases.map((x) => x.version)).toEqual(["6.8.11"]);
    expect(from26.releases).toEqual([{ component: "pkg:npm/electron-updater", version: "7.0.0", date: "2026-09-15", line: "7" }]);
    expect(own.releases.map((x) => x.version)).toEqual(["6.0.0"]);
    expect(own.history).toEqual([]);
    // Bounds are given at the mapped release (a moving guide read after 7.1.0 shipped), none for a dropped guide.
    const bounds = guideBounds(T, [{ version: "7.0.0", date: "2026-09-15" }, { version: "7.1.0", date: "2026-10-01" }], moved);
    expect(bounds.get("sha256:bbbbbbbb22")).toEqual({ version: "7.0.0", noLaterThan: "7.1.0" });
    expect(bounds.has("sha256:aaaaaaaa11")).toBe(false);
    // Idempotent.
    const before = JSON.stringify(s);
    expect(relineGuideRecords(s, moved)).toEqual({ moved: 0, dropped: 0, retracted: [] });
    expect(JSON.stringify(s)).toBe(before);
  });

  test("a registry that cannot be read checks nothing", async () => {
    const T: Technology = { id: "unread-00000000", name: "unread", repo: "o/unread", components: ["pkg:npm/unread"], tag: /^v(\d+\.\d+\.\d+)$/, clean: (b) => b };
    expect(await guideVersions(T, [{ version: "27.0.0", snapshot: "sha256:x" }], { offline: true })).toEqual(new Map());
    // Nor does a repository-packages lookup that failed (npm has the hook): the guide may yet map.
    const U: Technology = { ...T, id: "nosiblings-00000000", components: ["pkg:npm/nosiblings"] };
    times("pkg:npm/nosiblings", { "1.0.0": "2026-01-01T00:00:00Z" });
    expect(await guideVersions(U, [{ version: "27.0.0", snapshot: "sha256:x" }], { offline: true })).toEqual(new Map());
  });
});
