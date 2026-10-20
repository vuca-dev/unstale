// A record's release must belong to what the cited page could describe. Cases: TanStack Query's `latest` "Migrating to
// v5" guide, first read on 19 October 2026 at 5.104.x, gained an "Imperative QueryClient methods" section about
// `queryClient.query` (a later 5.x API) that the whole-guide ingestion dated 5.0.0; the client then showed the
// deprecation of `fetchQuery` "in effect now" at 5.90.6, where `queryClient.query` does not exist.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attribute, lineBound } from "../src/docs/attribute.ts";
import { guideBounds } from "../src/pipeline/fetch.ts";
import { combineRelease, recomputeReleases } from "../src/pipeline/lines.ts";
import { boundGuideRecords, combineReleases, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
import { techLocal } from "../src/state/client.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-bounds-"));
  process.env.UNSTALE_CENTRAL_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const C = "pkg:npm/%40tanstack/react-query";
const rel = (version: string, no_later_than?: string) => ({ component: C, version, date: "2026-10-19", line: version.split(".")[0]!, ...(no_later_than ? { no_later_than } : {}) });
const RELEASES = [
  { version: "4.44.0", date: "2026-04-01" },
  { version: "5.90.6", date: "2025-11-01" },
  { version: "5.104.5", date: "2026-10-18" },
  { version: "5.105.0", date: "2026-10-25" },
];

describe("a moving page's release bound", () => {
  test("lineBound: the newest release of the major once the line moved past x.0", () => {
    expect(lineBound("5", ["5.0.0", "5.0.3", "6.0.0-beta.1"])).toBeUndefined();
    expect(lineBound("5", ["5.0.0", "5.90.6", "5.104.5", "6.0.0", "5.105.0-rc.1"])).toBe("5.104.5");
    expect(lineBound("7", ["5.104.5"])).toBeUndefined();
  });

  test("an edit to the current major's guide after a minor release is bounded; one at x.0.x is not", () => {
    const s = { path: ["Imperative QueryClient methods"], status: "added" as const, added: 1, removed: 0, hunks: "+These methods are deprecated with the introduction of queryClient.query" };
    expect(attribute(s, { guideMajor: "5", maxMajor: "5", versions: new Set(["5.0.0", "5.104.5"]) })).toEqual({ by: "guide", version: "5.0.0", noLaterThan: "5.104.5" });
    expect(attribute(s, { guideMajor: "5", maxMajor: "5", versions: new Set(["5.0.0", "5.0.2"]) })).toEqual({ by: "guide", version: "5.0.0" });
    // A marker still dates the change exactly.
    expect(attribute({ ...s, hunks: "+Added in v5.91.0: queryClient.query" }, { guideMajor: "5", maxMajor: "5", versions: new Set(["5.0.0", "5.91.0", "5.104.5"]) })).toEqual({
      by: "marker",
      version: "5.91.0",
      marker: "Added in v5.91.0",
    });
  });

  test("a guide ingested whole is bounded by the releases of its line out by the day it was first read", () => {
    const t = { id: "tanstack-react-query-ce10f09c" } as Technology;
    const entry = (snapshot: string, extra: Record<string, string>) => ({ technology: t.id, kind: "upgrade_guide", tag: "guide-5", version: "5.0.0", url: "https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5", snapshot, keyTag: "+guide.x", ...extra });
    writeAtomic(
      join(dir, "guides", techLocal(t.id), "index.json"),
      JSON.stringify({
        checked: "2026-10-19T00:00:00Z",
        guides: [
          // Read on 19 October 2026: bounded by 5.104.5 (5.105.0 came later).
          entry("sha256:read", { date: "2026-10-19", read: "2026-10-19" }),
          // Written before the read day was kept: its date is the read day (5.0.0 is outside the window).
          entry("sha256:legacy", { date: "2026-10-19" }),
          // Dated its own x.0.0 release's day: the read day is not known, so no bound.
          { ...entry("sha256:dated", { date: "2026-03-15" }), version: "6.0.0", tag: "guide-6" },
        ],
      }),
    );
    const b = guideBounds(t, [...RELEASES, { version: "6.0.0", date: "2026-03-15" }, { version: "6.1.0", date: "2026-04-01" }]);
    expect(Object.fromEntries(b)).toEqual({ "sha256:read": { version: "5.0.0", noLaterThan: "5.104.5" }, "sha256:legacy": { version: "5.0.0", noLaterThan: "5.104.5" } });
  });

  test("combining: an exact release inside the bound is the introducing one; bounds narrow", () => {
    expect(combineRelease(rel("5.0.0", "5.104.5"), rel("5.91.0"))).toEqual(rel("5.91.0"));
    expect(combineRelease(rel("5.91.0"), rel("5.0.0", "5.104.5"))).toEqual(rel("5.91.0"));
    expect(combineRelease(rel("5.0.0", "5.104.5"), rel("5.0.0", "5.95.0"))).toEqual(rel("5.0.0", "5.95.0"));
    // An exact release past the bound is a later mention: the bound stands.
    expect(combineRelease(rel("5.0.0", "5.90.0"), rel("5.104.0"))).toEqual(rel("5.0.0", "5.90.0"));
    expect(combineRelease(rel("5.2.0"), rel("5.1.0"))).toEqual(rel("5.1.0"));
    expect(combineReleases([rel("5.0.0", "5.104.5")], [rel("5.91.0")])).toEqual([rel("5.91.0")]);
  });

  const record = (over: Partial<StoredRecord>): StoredRecord => ({
    id: "tanstack-react-query-ce10f09c:queryclient.query",
    technology: "tanstack-react-query-ce10f09c",
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "deprecation",
    breaking: false,
    surface: "code_api",
    subject: "queryClient.query",
    subject_kind: "literal",
    summary: "Introduced as the replacement for queryClient.fetchQuery.",
    benefit: [],
    releases: [rel("5.0.0")],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: ["queryClient.fetchQuery"],
    evidence: [{ kind: "upgrade_guide", url: "https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5", quote: "q", snapshot: "sha256:read" }],
    related: [],
    sources: ["tanstack-react-query-ce10f09c@5.0.0+guide.read#0.0"],
    history: [],
    ...over,
  });

  test("records already ingested from a bounded guide get the bound; one with another source keeps its release", () => {
    const bounds = new Map([["sha256:read", { version: "5.0.0", noLaterThan: "5.104.5" }]]);
    const guideOnly = record({});
    const withNotes = record({ id: "x:y", evidence: [...record({}).evidence, { kind: "release_notes", url: "https://github.com/TanStack/query/releases/tag/v5.0.0", quote: "q", snapshot: "sha256:notes" }] });
    const s: TechStore = { technology: "t", records: { [guideOnly.id]: guideOnly, [withNotes.id]: withNotes }, ingested: {} };
    expect(boundGuideRecords(s, bounds)).toBe(1);
    expect(guideOnly.releases).toEqual([rel("5.0.0", "5.104.5")]);
    expect(guideOnly.revision).toBe(2);
    expect(withNotes.releases).toEqual([rel("5.0.0")]);
    expect(boundGuideRecords(s, bounds)).toBe(0);
  });

  test("recomputing releases keeps a bound that only page sources support", () => {
    const store = { releaseIndex: { depth: 1, releases: [{ version: "5.0.0", date: "2023-10-17", line: "5" }] } } as Pick<TechStore, "releaseIndex">;
    const r = record({ releases: [rel("5.0.0", "5.104.5")] });
    expect(recomputeReleases(r, store, [C])[0]!.no_later_than).toBe("5.104.5");
    const exact = record({ releases: [rel("5.0.0", "5.104.5")], sources: [...r.sources, "tanstack-react-query-ce10f09c@5.0.0#1.0"] });
    expect(recomputeReleases(exact, store, [C])[0]!.no_later_than).toBeUndefined();
  });
});
