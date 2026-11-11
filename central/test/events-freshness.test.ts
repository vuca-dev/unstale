// Change events' freshness timestamps: the registry's publish time when it has one, when central first read the
// source, when it first published the event; each kept once set, so the gap from release to catalog can be measured.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eventsChanged, publishEvents, recordNotes } from "../src/pipeline/events.ts";
import { catalogDir } from "../src/pipeline/paths.ts";
import { registryCache } from "../src/pipeline/registry.ts";
import { sha256 } from "../src/pipeline/util.ts";
import { EventLine } from "../src/schema/catalog.ts";

const T = { id: "next", name: "Next.js", components: ["pkg:npm/next"] };
const note = (version: string, over: Record<string, unknown> = {}) => ({
  technology: "next",
  tag: `v${version}`,
  version,
  date: "2026-10-01",
  url: `https://github.com/vercel/next.js/releases/tag/v${version}`,
  snapshot: `sha256:${sha256(version)}`,
  notes: `- Changes in ${version}`,
  ...over,
});
const at = (iso: string) => new Date(iso);

const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-events-fresh-"));
  vi.stubEnv("UNSTALE_NOTICE", join(process.env.UNSTALE_STORE, "no-notice.json"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.unstubAllEnvs();
});

/** The registry's publish times as `publishDates` caches them (npm `time`). */
function registryTimes(times: Record<string, string>): void {
  registryCache().put(`npm/times/${sha256("pkg:npm/next").slice(0, 32)}`, JSON.stringify({ checked: "2026-10-01T00:00:00Z", times }) + "\n");
}

function published(now: Date): Map<string, EventLine> {
  const out = new Map<string, EventLine>();
  for (const r of publishEvents("next", catalogDir(), now).refs)
    for (const l of gunzipSync(readFileSync(join(catalogDir(), r.path))).toString().trim().split("\n")) {
      const e = EventLine.parse(JSON.parse(l));
      out.set(e.id, e);
    }
  return out;
}

describe("change event freshness", () => {
  test("registry publish time, first seen and first published are each set once and kept", () => {
    registryTimes({ "16.0.0": "2026-09-30T21:14:05.123Z" });
    // The first read: history, so backfilled. 16.0.0 has a registry time; 15.5.0 (GitHub only) has none.
    recordNotes(T, "releases", [note("15.5.0"), note("16.0.0")], at("2026-10-01T06:00:00Z"));
    expect(eventsChanged("next")).toBe(true);
    let e = published(at("2026-10-01T06:10:00Z"));
    expect(eventsChanged("next")).toBe(false);
    // The same read again changes nothing; an event whose text changed is due for a publish.
    recordNotes(T, "releases", [note("15.5.0"), note("16.0.0")], at("2026-10-01T07:00:00Z"));
    expect(eventsChanged("next")).toBe(false);
    recordNotes(T, "releases", [note("15.5.0", { notes: "- Fixed again" }), note("16.0.0")], at("2026-10-01T08:00:00Z"));
    expect(eventsChanged("next")).toBe(true);
    published(at("2026-10-01T08:10:00Z"));
    expect(eventsChanged("next")).toBe(false);
    expect(e.get("next@16.0.0")!.freshness).toEqual({ registry_published: "2026-09-30T21:14:05.123Z", first_seen: "2026-10-01T06:00:00.000Z", first_published: "2026-10-01T06:10:00.000Z", backfilled: true });
    expect(e.get("next@15.5.0")!.freshness).toEqual({ first_seen: "2026-10-01T06:00:00.000Z", first_published: "2026-10-01T06:10:00.000Z", backfilled: true });

    // A release that appears later: not backfilled; its registry time arrives with the next read of the registry.
    recordNotes(T, "releases", [note("15.5.0"), note("16.0.0"), note("16.1.0", { date: "2026-10-03" })], at("2026-10-03T09:00:00Z"));
    e = published(at("2026-10-03T09:30:00Z"));
    expect(e.get("next@16.1.0")!.freshness).toEqual({ first_seen: "2026-10-03T09:00:00.000Z", first_published: "2026-10-03T09:30:00.000Z" });
    registryTimes({ "16.0.0": "2026-09-30T21:14:05.123Z", "16.1.0": "2026-10-03T08:41:00Z" });
    recordNotes(T, "releases", [note("15.5.0"), note("16.0.0"), note("16.1.0", { date: "2026-10-03" })], at("2026-10-03T12:00:00Z"));
    e = published(at("2026-10-03T12:30:00Z"));
    // Measured, not estimated: registry → seen 19 minutes, seen → published 30 minutes.
    expect(e.get("next@16.1.0")!.freshness).toEqual({ registry_published: "2026-10-03T08:41:00.000Z", first_seen: "2026-10-03T09:00:00.000Z", first_published: "2026-10-03T09:30:00.000Z" });
    // Earlier events keep their stamps through every later read and publish.
    expect(e.get("next@16.0.0")!.freshness.first_published).toBe("2026-10-01T06:10:00.000Z");
  });

  test("each source starts its own history; docs changes are never history; a release that leaves keeps its stamp", () => {
    recordNotes(T, "releases", [note("16.0.0")], at("2026-10-01T06:00:00Z"));
    // Guides first read later: what that read finds is history too. A docs change is observed as it happens.
    recordNotes(T, "guides", [note("16.0.0", { kind: "upgrade_guide", keyTag: "+guide.0123abcd", url: "https://nextjs.org/docs/upgrading" })], at("2026-10-02T06:00:00Z"));
    recordNotes(T, "docs", [note("16.0.0", { kind: "docs", keyTag: "+docs.89abcdef", url: "https://nextjs.org/docs/app" })], at("2026-10-02T06:00:00Z"));
    recordNotes(T, "guides", [note("17.0.0", { kind: "upgrade_guide", keyTag: "+guide.fedcba98" })], at("2026-10-05T06:00:00Z"));
    const e = published(at("2026-10-05T07:00:00Z"));
    expect(Object.fromEntries([...e].map(([id, x]) => [id, [x.kind, !!x.freshness.backfilled, x.freshness.first_seen.slice(0, 10)]]))).toEqual({
      "next@16.0.0": ["release_notes", true, "2026-10-01"],
      "next@16.0.0+guide.0123abcd": ["upgrade_guide", true, "2026-10-02"],
      "next@16.0.0+docs.89abcdef": ["docs", false, "2026-10-02"],
      // A guide read that names only the new one keeps the earlier guide (guides and docs accumulate).
      "next@17.0.0+guide.fedcba98": ["upgrade_guide", false, "2026-10-05"],
    });
    // The release list is read whole: a release no longer in it leaves the events; guides and docs stay.
    recordNotes(T, "releases", [], at("2026-10-06T06:00:00Z"));
    expect([...published(at("2026-10-06T07:00:00Z")).keys()].sort()).toEqual(["next@16.0.0+docs.89abcdef", "next@16.0.0+guide.0123abcd", "next@17.0.0+guide.fedcba98"]);
    // Back again: still the stamp it was first published with.
    recordNotes(T, "releases", [note("16.0.0")], at("2026-10-07T06:00:00Z"));
    expect(published(at("2026-10-07T07:00:00Z")).get("next@16.0.0")!.freshness.first_published).toBe("2026-10-05T07:00:00.000Z");
  });

  test("the prompt's date is kept when the registry's day differs", () => {
    recordNotes(T, "releases", [note("16.0.0", { date: "2026-10-01", noteDate: "2026-09-30" }), note("16.0.1", { noteDate: "2026-10-01" })], at("2026-10-01T06:00:00Z"));
    const e = published(at("2026-10-01T07:00:00Z"));
    expect([e.get("next@16.0.0")!.prompt_date, e.get("next@16.0.1")!.prompt_date]).toEqual(["2026-09-30", undefined]);
  });
});
