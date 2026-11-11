// How fresh the catalog is: for each release, the time from its registry publish to central first reading it, and to
// its change events being published. Computed at export from the change events the exported indexes name (their
// `freshness` timestamps, events.ts) and published beside the catalog as `v1/freshness.json` (signed like the root),
// so the gap can be followed over time. Deterministic: no clock, no model call. The window is the 30 days up to the
// newest release published, so the same catalog gives the same bytes. Releases whose sources central first read when
// it began following them (`backfilled`) are left out: their gap is how long central has existed, not how fast it is.
import type { EventLine } from "../schema/catalog.ts";

export const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** A gap's distribution in minutes, over the releases that have both ends. */
export interface Gap {
  releases: number;
  median_minutes: number | null;
  p90_minutes: number | null;
}

export interface FreshnessDay {
  /** UTC day the releases' events were first published. */
  day: string;
  releases: number;
  /** Registry publish to events published, median in minutes (null when no release that day has a registry time). */
  median_minutes: number | null;
}

export interface FreshnessSummary {
  schema: 1;
  /** The last day of the window (the newest first publish), and its length. */
  until: string | null;
  window_days: number;
  releases: number;
  /** Registry publish to central first reading the release. */
  registry_to_seen: Gap;
  /** Central first reading the release to its events being published. */
  seen_to_published: Gap;
  /** End to end: registry publish to events published. */
  registry_to_published: Gap;
  /** One entry per day with releases, oldest first: the trend. */
  days: FreshnessDay[];
}

/** One release's times: the earliest of its events (release notes, an upgrade guide, a docs change). */
interface Release {
  registry: number | null;
  seen: number;
  published: number;
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The q-quantile by nearest rank, in whole minutes; null for none. */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return Math.round(sorted[rank - 1]! / 60_000);
}

const gap = (spans: number[]): Gap => ({ releases: spans.length, median_minutes: quantile(spans, 0.5), p90_minutes: quantile(spans, 0.9) });

/** The summary of these change events (each event once, whatever shards repeat it). */
export function freshnessSummary(events: Iterable<EventLine>): FreshnessSummary {
  const releases = new Map<string, Release>();
  const seenIds = new Set<string>();
  for (const e of events) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    if (e.freshness.backfilled) continue;
    const seen = ms(e.freshness.first_seen);
    const published = ms(e.freshness.first_published);
    if (seen === null || published === null) continue;
    const key = `${e.technology}@${e.version}`;
    const registry = ms(e.freshness.registry_published);
    const r = releases.get(key);
    if (!r) releases.set(key, { registry, seen, published });
    else {
      r.seen = Math.min(r.seen, seen);
      r.published = Math.min(r.published, published);
      r.registry ??= registry;
    }
  }
  let newest = -Infinity;
  for (const r of releases.values()) newest = Math.max(newest, r.published);
  const inWindow = Number.isFinite(newest) ? [...releases.values()].filter((r) => r.published > newest - WINDOW_DAYS * DAY_MS) : [];
  // A clock skewed between registry and central can give a negative span: counted as no gap, never as a gain.
  const span = (from: number, to: number): number => Math.max(0, to - from);
  const withRegistry = inWindow.filter((r) => r.registry !== null);
  const byDay = new Map<string, Release[]>();
  for (const r of inWindow) {
    const day = new Date(r.published).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }
  return {
    schema: 1,
    until: Number.isFinite(newest) ? new Date(newest).toISOString().slice(0, 10) : null,
    window_days: WINDOW_DAYS,
    releases: inWindow.length,
    registry_to_seen: gap(withRegistry.map((r) => span(r.registry!, r.seen))),
    seen_to_published: gap(inWindow.map((r) => span(r.seen, r.published))),
    registry_to_published: gap(withRegistry.map((r) => span(r.registry!, r.published))),
    days: [...byDay.keys()].sort().map((day) => {
      const rs = byDay.get(day)!;
      const spans = rs.filter((r) => r.registry !== null).map((r) => span(r.registry!, r.published));
      return { day, releases: rs.length, median_minutes: quantile(spans, 0.5) };
    }),
  };
}
