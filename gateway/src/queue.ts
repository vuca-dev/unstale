// The registration queue the gateway holds between coverage runs (vault: Central Scheduling and Infrastructure,
// "Registration gateway" and "Admission queue"). One row per public package: its demand (distinct requesters since
// the last run took it) and when it was first asked for. Votes are deduplicated and new packages address-limited in
// memory only (central's requesters.ts), so the rows hold no address and no pseudonym. The queue is never refused for
// budget: central's budget decides how fast it drains. `MAX_PENDING` only bounds storage against a flood.
import { AddressLimiter, Voters, type Refusal } from "../../central/src/onboarding/requesters.ts";

/** The SQL surface used: a Durable Object's `ctx.storage.sql`, or node:sqlite in tests. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface Settings {
  /** New packages one address may register per hour (central's UNSTALE_RATE_PER_HOUR). */
  perAddressPerHour: number;
  /** Rows held at most; beyond it a new package is refused until a run takes some. */
  maxPending: number;
  /** New packages held per UTC hour, all clients together: a plain counter (no address), so it outlives the object's
   * memory and bounds how fast anyone can fill the queue, however many addresses they use. 0 turns it off. */
  newPerHour: number;
  /** Coverage runs a new package may start early per UTC day; 0 waits for the schedule. */
  fastTrackPerDay: number;
  /** At least this long between two early runs. */
  fastTrackIntervalMs: number;
}

export function settingsFrom(vars: Record<string, string | undefined>): Settings {
  const int = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    perAddressPerHour: int(vars.RATE_PER_HOUR, 20),
    maxPending: int(vars.MAX_PENDING, 50_000),
    newPerHour: int(vars.NEW_PER_HOUR, 1000),
    fastTrackPerDay: int(vars.FAST_TRACK_PER_DAY, 0),
    fastTrackIntervalMs: int(vars.FAST_TRACK_INTERVAL_MINUTES, 15) * 60_000,
  };
}

/** A new package queued (with its place among new packages), a vote on a known one, or a refusal. */
export type Outcome =
  | { type: "queued"; position: number; length: number; fastTrack: boolean }
  | { type: "voted" }
  | ({ type: "refused" } & Refusal);

export interface Request {
  purl: string;
  demand: number;
}

export class PendingQueue {
  private readonly sql: Sql;
  private readonly settings: Settings;
  private readonly addresses: AddressLimiter;
  private readonly voters = new Voters();
  constructor(sql: Sql, settings: Settings) {
    this.sql = sql;
    this.settings = settings;
    this.addresses = new AddressLimiter(settings.perAddressPerHour);
    sql.exec("CREATE TABLE IF NOT EXISTS pending (purl TEXT PRIMARY KEY, demand INTEGER NOT NULL, first_seen INTEGER NOT NULL, known INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** One vote per requester and package, inside the address limit; over it the answer is the same, uncounted. */
  private vote(purl: string, address: string, known: boolean, now: number): void {
    if (this.voters.has(purl, address) || this.addresses.take(address, now)) return;
    this.voters.add(purl, address);
    this.sql.exec(
      "INSERT INTO pending (purl, demand, first_seen, known) VALUES (?, 1, ?, ?) ON CONFLICT(purl) DO UPDATE SET demand = demand + 1",
      purl,
      now,
      known ? 1 : 0,
    );
  }

  /** A client's request; `known` when central already has a job for the package (its status is published). */
  request(purl: string, address: string, known: boolean, now = Date.now()): Outcome {
    if (known) {
      this.vote(purl, address, true, now);
      return { type: "voted" };
    }
    if (this.held(purl)) {
      this.vote(purl, address, false, now);
      return { type: "queued", ...this.position(purl)!, fastTrack: false };
    }
    const hour = new Date(now).toISOString().slice(0, 13);
    const thisHour = this.meta("new_hour") === hour ? Number(this.meta("new_count") ?? 0) : 0;
    if (this.settings.newPerHour && thisHour >= this.settings.newPerHour)
      return { type: "refused", limit: "budget", retryAfter: Math.ceil((3600_000 - (now % 3600_000)) / 1000) };
    const refused = this.addresses.take(address, now);
    if (refused) return { type: "refused", ...refused };
    if (this.count() >= this.settings.maxPending) return { type: "refused", limit: "budget", retryAfter: 3600 };
    this.setMeta("new_hour", hour);
    this.setMeta("new_count", String(thisHour + 1));
    this.voters.add(purl, address);
    this.sql.exec("INSERT INTO pending (purl, demand, first_seen, known) VALUES (?, 1, ?, 0)", purl, now);
    return { type: "queued", ...this.position(purl)!, fastTrack: this.fastTrack(now) };
  }

  private meta(k: string): string | undefined {
    const v = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v;
    return v === undefined ? undefined : String(v);
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private count(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM pending").toArray()[0]?.n ?? 0);
  }

  held(purl: string): boolean {
    return this.sql.exec("SELECT 1 FROM pending WHERE purl = ?", purl).toArray().length > 0;
  }

  /** The place of a held new package: most requested first, then first asked (central drains new ones the same way). */
  position(purl: string): { position: number; length: number } | undefined {
    const rows = this.sql.exec("SELECT purl FROM pending WHERE known = 0 ORDER BY demand DESC, first_seen ASC, purl ASC").toArray();
    const i = rows.findIndex((r) => r.purl === purl);
    return i < 0 ? undefined : { position: i + 1, length: rows.length };
  }

  /** Everything held, for a coverage run to take. */
  list(): Request[] {
    return this.sql.exec("SELECT purl, demand FROM pending ORDER BY first_seen ASC, purl ASC")
      .toArray()
      .map((r) => ({ purl: String(r.purl), demand: Number(r.demand) }));
  }

  /** A deployed run took these: their demand is subtracted, so votes that arrived meanwhile stay for the next run. */
  ack(taken: Request[]): number {
    let removed = 0;
    for (const { purl, demand } of taken) {
      if (typeof purl !== "string" || !Number.isFinite(demand)) continue;
      this.sql.exec("UPDATE pending SET demand = demand - ? WHERE purl = ?", Math.max(0, Math.floor(demand)), purl);
      removed += this.sql.exec("DELETE FROM pending WHERE purl = ? AND demand <= 0 RETURNING purl", purl).toArray().length;
    }
    return removed;
  }

  /** Whether a new package may start a run now: within the day's count and the interval since the last one. */
  private fastTrack(now: number): boolean {
    if (!this.settings.fastTrackPerDay) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    const used = this.meta("fast_day") === day ? Number(this.meta("fast_count") ?? 0) : 0;
    const last = Number(this.meta("fast_last") ?? 0);
    if (used >= this.settings.fastTrackPerDay || now - last < this.settings.fastTrackIntervalMs) return false;
    this.setMeta("fast_day", day);
    this.setMeta("fast_count", String(used + 1));
    this.setMeta("fast_last", String(now));
    return true;
  }
}
