// When a run reaches a waiting job: an estimate from the drain's measured throughput, the way `publish_by` says when a
// cycle's records are published. A client is told one place and one time, both from the drain's own queue.
//
// Lines: a new technology waits only behind new technologies ahead of it (the drain keeps `newSlots` for them whatever
// admitted work is due), and admitted work only behind admitted work; so a job's place is in its line, and each line
// has its own rate (starts a minute, steady state: the first fill of a drain's slots is not throughput).
//
// Cycles: a run starts jobs only inside a drain's window (`--minutes`); between two windows come the grace period and
// the publish. An estimate past the current window adds those gaps, one per window it spans, so a job a run will not
// reach this cycle is told the later cycle's time, never "the next pull".

export type Line = "new" | "admitted";

/** Starts a minute per line, as measured. */
export type Rates = Partial<Record<Line, number>>;

export interface Cadence {
  /** When the current window ends (ms): no job starts after it until the next window. */
  windowEnd: number;
  /** Gap after the current window before the next starts (ms): what is left of grace, and the publish. */
  gapMs: number;
  /** A full window and the gap after it (ms), for cycles after the next. */
  windowMs: number;
  cycleGapMs: number;
}

/**
 * When the job at `position` of its line starts (ms), at `perMinute` starts of that line a minute; undefined without
 * a rate. Position 1 starts at the next start of its line, so `position / rate` of window time.
 */
export function startsAt(now: number, position: number, perMinute: number | undefined, c: Cadence): number | undefined {
  if (!perMinute || !(perMinute > 0) || !Number.isFinite(perMinute) || position < 1 || c.windowMs <= 0) return undefined;
  let need = (position / perMinute) * 60_000;
  const left = Math.max(0, c.windowEnd - now);
  if (need <= left) return Math.round(now + need);
  need -= left;
  let t = Math.max(now, c.windowEnd) + c.gapMs;
  const full = Math.floor(need / c.windowMs);
  // Exactly at a window's end is that window's last start, not the next window's first.
  const whole = full > 0 && need === full * c.windowMs ? full - 1 : full;
  t += whole * (c.windowMs + c.cycleGapMs);
  return Math.round(t + need - whole * c.windowMs);
}

/** A time a client reads: "17:40 UTC", with the date when it is not today's (UTC). */
export function clockText(ms: number, now: number): string {
  const at = new Date(ms).toISOString();
  return at.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? `${at.slice(11, 16)} UTC` : `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}
