// The catalog's freshness summary: registry publish → central first seen → events published, median and 90th
// percentile over the 30 days up to the newest release, backfilled sources left out; exported and signed with the
// catalog, the same bytes for the same catalog.
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { recordNotes } from "../src/pipeline/events.ts";
import { catalogSigner, exportCatalog } from "../src/pipeline/export.ts";
import { freshnessSummary, quantile } from "../src/pipeline/freshness.ts";
import { catalogDir } from "../src/pipeline/paths.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { sha256 } from "../src/pipeline/util.ts";
import type { EventLine } from "../src/schema/catalog.ts";
import { store } from "./catalog-fixture.ts";

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();
const T0 = Date.parse("2026-10-01T00:00:00Z");

/** An event of `version`, read `seenH` hours and published `pubH` hours after a registry publish at `t`. */
function ev(version: string, t: number, seenH: number, pubH: number, over: Partial<EventLine["freshness"]> = {}, id = `next@${version}`): EventLine {
  return {
    id,
    technology: "next",
    version,
    freshness: { registry_published: iso(t), first_seen: iso(t + seenH * H), first_published: iso(t + pubH * H), ...over },
  } as EventLine;
}

describe("freshness summary", () => {
  test("median and 90th percentile of each gap, one release per version, backfilled left out", () => {
    const events = [
      ev("1.0.0", T0, 1, 2),
      ev("1.0.1", T0 + 24 * H, 2, 3),
      ev("1.0.2", T0 + 48 * H, 3, 5),
      ev("1.0.3", T0 + 72 * H, 10, 12),
      // A second source of 1.0.3 (an upgrade guide) read later: the release counts once, at its earliest times.
      ev("1.0.3", T0 + 72 * H, 20, 21, {}, "next@1.0.3#guide"),
      // Read when central began following the technology: its gap is not freshness.
      ev("0.9.0", T0 - 400 * 24 * H, 9_000, 9_001, { backfilled: true }),
    ];
    const s = freshnessSummary(events);
    expect(s.releases).toBe(4);
    expect(s.registry_to_seen).toEqual({ releases: 4, median_minutes: 120, p90_minutes: 600 });
    expect(s.seen_to_published).toEqual({ releases: 4, median_minutes: 60, p90_minutes: 120 });
    expect(s.registry_to_published).toEqual({ releases: 4, median_minutes: 180, p90_minutes: 720 });
    expect(s.until).toBe("2026-10-04");
    expect(s.days.map((d) => [d.day, d.releases, d.median_minutes])).toEqual([
      ["2026-10-01", 1, 120],
      ["2026-10-02", 1, 180],
      ["2026-10-03", 1, 300],
      ["2026-10-04", 1, 720],
    ]);
    // Deterministic, whatever order the events come in.
    expect(JSON.stringify(freshnessSummary([...events].reverse()))).toBe(JSON.stringify(s));
  });

  test("only the 30 days up to the newest release; a release without a registry time counts for the central gap only", () => {
    const s = freshnessSummary([
      ev("1.0.0", T0, 1, 2),
      ev("2.0.0", T0 + 31 * 24 * H, 1, 4),
      ev("2.0.1", T0 + 32 * 24 * H, 1, 3, { registry_published: null }),
    ]);
    expect(s.releases).toBe(2);
    expect(s.registry_to_published).toEqual({ releases: 1, median_minutes: 240, p90_minutes: 240 });
    expect(s.seen_to_published).toEqual({ releases: 2, median_minutes: 120, p90_minutes: 180 });
    expect(freshnessSummary([])).toMatchObject({ until: null, releases: 0, registry_to_seen: { releases: 0, median_minutes: null, p90_minutes: null } });
    expect(quantile([5 * 60_000], 0.9)).toBe(5);
  });
});

describe("freshness in the export", () => {
  const T = { id: "next", name: "Next.js", components: ["pkg:npm/next"] };
  const note = (version: string) => ({
    technology: "next",
    tag: `v${version}`,
    version,
    date: "2026-09-30",
    url: `https://github.com/vercel/next.js/releases/tag/v${version}`,
    snapshot: `sha256:${sha256(version)}`,
    notes: `- Changes in ${version}`,
  });
  const previous = process.env.UNSTALE_STORE;
  beforeEach(() => {
    process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-freshness-"));
    vi.stubEnv("UNSTALE_NOTICE", join(process.env.UNSTALE_STORE, "no-notice.json"));
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.UNSTALE_STORE;
    else process.env.UNSTALE_STORE = previous;
    vi.unstubAllEnvs();
  });

  test("published as v1/freshness.json, signed, from the events the exported indexes name; the same bytes on a rerun", () => {
    const CHECKED = "2026-10-15T06:00:00Z";
    // The first read of the release list is backfill; a release found on a later read is fresh.
    recordNotes(T, "releases", [note("16.0.0")], new Date(T0));
    publishTechnology(store(), CHECKED, catalogDir(), undefined, new Date(T0));
    recordNotes(T, "releases", [note("16.0.0"), note("16.1.0")], new Date(T0 + 24 * H));
    publishTechnology(store(), CHECKED, catalogDir(), undefined, new Date(T0 + 27 * H));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sign = catalogSigner(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const out = join(mkdtempSync(join(tmpdir(), "unstale-freshness-out-")), "site");
    exportCatalog(catalogDir(), out, { now: new Date(T0 + 27 * H), jobs: [], sign });
    const body = readFileSync(join(out, "v1", "freshness.json"));
    expect(verify(null, body, publicKey, Buffer.from(readFileSync(join(out, "v1", "freshness.json.sig"), "utf8"), "hex"))).toBe(true);
    const s = JSON.parse(body.toString());
    expect(s).toMatchObject({ schema: 1, window_days: 30, releases: 1, seen_to_published: { releases: 1, median_minutes: 180, p90_minutes: 180 } });
    const again = join(mkdtempSync(join(tmpdir(), "unstale-freshness-out-")), "site");
    exportCatalog(catalogDir(), again, { now: new Date(T0 + 40 * H), jobs: [], sign });
    expect(readFileSync(join(again, "v1", "freshness.json")).equals(body)).toBe(true);
  });
});
