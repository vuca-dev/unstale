// The registration queue the gateway holds between coverage runs. One entry per public package: its demand (distinct
// requesters since the last run took it), when it was first asked for, and the run working it, if any. Votes are
// deduplicated, and new packages and votes are address-limited in separate buckets, in memory only (central's
// requesters.ts), so nothing stored holds an address or a pseudonym. The queue is never refused for budget: central's
// budget decides how fast it drains. `MAX_PENDING` only bounds storage against a flood. What central's budget does
// change is early runs: each coverage run reports until when the budget is spent (a limit at its cap: release-note
// tokens, new technologies or runs a day), and until then a new package is queued as always but starts no run, since
// a run could start nothing; the schedule takes it after the reset.
//
// Storage is billed per row, and the object stays on the Workers free tier: 5,000,000 rows read and 100,000 rows
// written a day, reset at 00:00 UTC. A row is every row a statement visits or writes, index rows included (a TEXT
// PRIMARY KEY on a rowid table is a second row per insert). Writes are the scarce allowance. So:
// - The queue is BUCKETS rows (`queue`, keyed by a hash of the package URL), each the JSON of its entries, not one row
//   per package. Waking the object reads at most BUCKETS rows however long the queue; every write is one row; an
//   acknowledgement rewrites at most BUCKETS rows however many packages it takes. A bucket holds about
//   MAX_PENDING / BUCKETS entries (some 40 KB at the default, a row may hold 2 MB).
// - Everything is read once per wake (the buckets and the few `meta` rows, WITHOUT ROWID) and kept in memory, in step
//   with every write (this object is the only writer). Status reads, positions and `/internal/queue` read nothing.
// - A write that changes nothing is skipped. A run's progress is kept in memory as reported, and written when its
//   state changes or RUN_SAVE_MS after it was last written (a wake shows counters at most that old, until the run's
//   next report, at most PROGRESS_HEARTBEAT_MS later; each answer carries central's save time, so a client keeps the
//   newer counters it already had).
// - Rows read and written are counted (the cursor's counters) per UTC day and per operation, kept in `meta` at most
//   every USAGE_FLUSH_MS (and after USAGE_IDLE_MS without requests), and shown on `/internal/usage`.
//
// Rows per operation, read/written, measured with the cursors' counters under `wrangler dev` on the same 56 held
// packages (before → now; the tests check the same bounds with node:sqlite's estimate, test/sqlite.ts):
//   new package          4/4 → 1/2 (its bucket, the hourly counter; fast-tracked + 0/1, the day's early runs)
//   vote, held or known  1/1 (2 written for a package's first vote) → 1/1; an uncounted vote 0/0
//   status read          0/0 → 0/0 (in memory since the wake)
//   wake                 N/0 → at most BUCKETS + 8 / 0 (meta, then the buckets)
//   a run's report       0/2 for a new state, then 1/1 for each package every 5 s → 1/1 per bucket changed, only
//                        for a new state or after RUN_SAVE_MS
//   `/internal/queue`    2N/0 → 0/0
//   acknowledgement      about 4N/2N → at most BUCKETS + 1 each (225/115 → 39/40 for 56)
//   a run's pulls        0/1 (`pulls_next`, each pull; `fast_held` once while it pulls; none for an unchanged value)
// Worst case a day at the defaults, every limit reached all day:
//   written: new 500/h × 24 × 2 = 24,000; counted votes 1,500/h × 24 = 36,000; runs' progress ≤ 100 packages worked
//   a day (central's UNSTALE_NEW_PER_DAY) × (3 states + 150 min / 10) ≈ 1,800; a pulled package's `waiting` once
//   (each pull's report writes ≤ BUCKETS, and a package enters it once: ≤ min(new 12,000, 288 pulls × 64) = 12,000,
//   never rewritten while it waits); acknowledgements ≤ 32 runs ×
//   (BUCKETS + 1) ≈ 2,100 (an acknowledgement per cycle since 18 October 2026: one per publish of a run, at most about
//   one every 15 minutes, so ≤ 96 × 65 ≈ 6,200; since a cycle may end early to publish its new packages' decisions,
//   at most about one every 7 minutes, so ≤ 206 × 65 ≈ 13,400); a run's pulls ≤ 1 every 5 minutes plus one a cycle
//   ≈ 500; usage kept ≤ 1 a 45 s = 1,920; budget and early runs ≤ 60. About 89,500 of 100,000.
//   read: about one per vote or new package (≈ 48,000), plus a wake at most every 70 s (an object is evicted only
//   after that long idle) × 72 ≈ 89,000; status reads and `/internal/queue` none. About 140,000 of 5,000,000.
// So NEW_PER_HOUR (500) and COUNTED_VOTES_PER_HOUR (1,500) bound the day: rows written ≈ 3 × NEW_PER_HOUR × 24 +
// COUNTED_VOTES_PER_HOUR × 24 + ~6,000. Only deliberate abuse beyond those (it cannot pass them) or raised settings
// can spend the allowance. MAX_PENDING bounds memory and bucket size, not rows.
import { AddressLimiter, Voters, type Refusal } from "../../central/src/onboarding/requesters.ts";

/** One statement's result: a Durable Object's cursor counts the rows it read and wrote (node:sqlite in tests
 * estimates them). */
export interface Cursor {
  toArray(): Record<string, unknown>[];
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
}

/** The SQL surface used: a Durable Object's `ctx.storage.sql`, or node:sqlite in tests. */
export interface Sql {
  exec(query: string, ...bindings: unknown[]): Cursor;
}

export interface Settings {
  /** New packages one address may register per hour (central's UNSTALE_RATE_PER_HOUR). */
  perAddressPerHour: number;
  /** Votes one address may cast per hour (central's UNSTALE_VOTES_PER_HOUR): a bucket of their own, so a repository
   * whose packages are mostly known does not spend its new-package allowance on votes. */
  votesPerAddressPerHour: number;
  /** Rows held at most; beyond it a new package is refused until a run takes some. */
  maxPending: number;
  /** New packages held per UTC hour, all clients together: a plain counter (no address), so it outlives the object's
   * memory and bounds how fast anyone can fill the queue, however many addresses they use. 0 turns it off. */
  newPerHour: number;
  /** Votes counted per UTC hour, all clients together (each is a row written); beyond it a vote is answered the same
   * and not counted, as over an address's own limit. Kept with the usage counters. 0 turns it off. */
  votesPerHour: number;
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
    perAddressPerHour: int(vars.RATE_PER_HOUR, 250),
    votesPerAddressPerHour: int(vars.VOTES_PER_HOUR, 1000),
    maxPending: int(vars.MAX_PENDING, 50_000),
    newPerHour: int(vars.NEW_PER_HOUR, 500),
    votesPerHour: int(vars.COUNTED_VOTES_PER_HOUR, 1500),
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

/** Where a coverage run is with a held package: started early for it, took it and has it waiting in its queue (at the
 * place and estimate it reports), working it, publishing it, or not taking it. */
export type RunState = "dispatched" | "waiting" | "running" | "publishing" | "declined";
export const RUN_STATES: readonly RunState[] = ["dispatched", "waiting", "running", "publishing", "declined"];

/** The public counters of a job a run reports while it works a package (central's Job, same names). */
export interface Progress {
  state: string;
  stage: string;
  records: number;
  releases_done: number;
  releases_total: number;
  docs_done: number;
  docs_total: number;
  /** When central last saved the job (ISO 8601): the order of reports, and the time a client is shown. */
  updated?: string;
  /** When the run's current cycle publishes, at the latest (ISO 8601): the records it counts are in the catalog then. */
  publish_by?: string;
  /** Waiting: its place in the run's queue (in its line, by demand) and when the run is estimated to start it (ISO
   * 8601, from the run's measured throughput and cycles; absent before it has measured any). */
  queue_position?: number;
  queue_length?: number;
  starts_at?: string;
}

export interface Run {
  state: RunState;
  /** When the package's run was asked for (dispatched) or first reported. */
  since: number;
  updated: number;
  job?: Progress;
}

/** A held package's place, the run working it and what a client is told around it. */
export interface View {
  position: number;
  length: number;
  run?: Run;
  typical?: number;
  /** Central's budget is spent until then (ms): no run takes a new package before it. */
  spentUntil?: number;
  /** A run is working the queue and reads it again at about this time (ms): it takes the package then. */
  pullsNext?: number;
}

/** A run that stopped reporting (cancelled, crashed, a failed deploy) is no longer shown. */
const RUN_SILENT_MS = 30 * 60_000;
/** Dispatched and never started (a long scheduled run ahead of it): shown as plain waiting. */
const RUN_UNSTARTED_MS = 6 * 3600_000;
/** Durations of recent early runs kept for the typical time a client is shown. */
const RUN_DURATIONS_KEPT = 10;
/** A run's progress in the same state is written at most this often (well inside RUN_SILENT_MS). */
const RUN_SAVE_MS = 10 * 60_000;
/** A run that said when it pulls next counts as pulling until this long after that time: its cycle's grace period and
 * publish come between two pulls, and a run that stopped without saying so (cancelled, crashed) is no longer waited for. */
export const PULLS_LATE_MS = 15 * 60_000;
/** Rows the queue is stored in. Changing it needs a new SCHEMA whose migration re-buckets the entries. */
export const BUCKETS = 64;

/** Packages in one batch request (index.ts: POST /coverage/status, /coverage/register). Each reads its published status
 * (a static file) and a new one its public registry, and a batch makes at most two calls to the object, so a full batch
 * stays inside the free plan's 50 subrequests. (Here, not in index.ts: a Worker's main module exports handlers only.) */
export const BATCH = 16;
/** The storage layout; anything older (or a new object) is migrated once. */
const SCHEMA = "2";
/** The usage counters are kept at most this often while requests continue, and once requests pause this long (an
 * idle object is evicted after about 70 s, so its last counts are kept first). */
const USAGE_FLUSH_MS = 5 * 60_000;
const USAGE_IDLE_MS = 45_000;
/** The free tier's daily allowance, shown beside the day's usage. */
export const ALLOWANCE = { rows_read: 5_000_000, rows_written: 100_000 };

interface Entry {
  demand: number;
  firstSeen: number;
  known: boolean;
  run?: Run;
}

/** The bucket a package is stored in: FNV-1a over its URL. Stable: it decides where existing entries are. */
export function bucketOf(purl: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < purl.length; i++) h = Math.imul(h ^ purl.charCodeAt(i), 0x01000193);
  return (h >>> 0) % BUCKETS;
}

type Stored = [purl: string, demand: number, firstSeen: number, known: 0 | 1, run?: [RunState, number, number, Progress | null]];

const decode = (json: string): [string, Entry][] =>
  (JSON.parse(json) as Stored[]).map(([purl, demand, firstSeen, known, run]) => [
    purl,
    { demand, firstSeen, known: known !== 0, ...(run ? { run: { state: run[0], since: run[1], updated: run[2], ...(run[3] ? { job: run[3] } : {}) } } : {}) },
  ]);

const encode = (entries: [string, Entry][]): string =>
  JSON.stringify(
    entries.map(([purl, e]): Stored =>
      e.run ? [purl, e.demand, e.firstSeen, e.known ? 1 : 0, [e.run.state, e.run.since, e.run.updated, e.run.job ?? null]] : [purl, e.demand, e.firstSeen, e.known ? 1 : 0],
    ),
  );

/** The held entries, by bucket, and the new packages among them in line order: most requested first, then first
 * asked, then by name (the order `position` documents). */
class Line {
  readonly rows = new Map<string, Entry>();
  private readonly buckets = new Map<number, Set<string>>();
  private readonly order: string[] = [];

  constructor(entries: Iterable<[string, Entry]>) {
    for (const [purl, e] of entries) this.add(purl, e);
    for (const [purl, e] of this.rows) if (!e.known) this.order.push(purl);
    this.order.sort((a, b) => (this.ahead(a, b) ? -1 : this.ahead(b, a) ? 1 : 0));
  }

  private add(purl: string, e: Entry): void {
    this.rows.set(purl, e);
    const b = bucketOf(purl);
    let members = this.buckets.get(b);
    if (!members) this.buckets.set(b, (members = new Set()));
    members.add(purl);
  }

  get length(): number {
    return this.order.length;
  }

  /** The entries stored in bucket `b`. */
  bucket(b: number): [string, Entry][] {
    return [...(this.buckets.get(b) ?? [])].map((purl) => [purl, this.rows.get(purl)!]);
  }

  private ahead(a: string, b: string): boolean {
    const x = this.rows.get(a)!;
    const y = this.rows.get(b)!;
    if (x.demand !== y.demand) return x.demand > y.demand;
    if (x.firstSeen !== y.firstSeen) return x.firstSeen < y.firstSeen;
    return a < b;
  }

  /** Where `purl` is (or would go) in the line: the number of new packages ahead of it. */
  private place(purl: string): number {
    let lo = 0;
    let hi = this.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.order[mid] !== purl && this.ahead(this.order[mid]!, purl)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The 0-based place of a held new package, or -1. */
  indexOf(purl: string): number {
    if (this.rows.get(purl)?.known !== false) return -1;
    const i = this.place(purl);
    return this.order[i] === purl ? i : -1;
  }

  /** An entry written: inserted, or changed. */
  set(purl: string, e: Entry): void {
    const old = this.rows.get(purl);
    if (old && old.demand === e.demand && old.firstSeen === e.firstSeen && old.known === e.known) {
      this.rows.set(purl, e);
      return;
    }
    this.remove(purl);
    this.add(purl, e);
    if (!e.known) this.order.splice(this.place(purl), 0, purl);
  }

  remove(purl: string): void {
    const i = this.indexOf(purl);
    if (i >= 0) this.order.splice(i, 1);
    if (this.rows.delete(purl)) this.buckets.get(bucketOf(purl))?.delete(purl);
  }
}

interface OpUsage {
  n: number;
  read: number;
  written: number;
}

/** Rows read and written today (UTC), in total and per operation, as the cursors counted them. */
export interface Usage {
  day: string;
  rows_read: number;
  rows_written: number;
  ops: Record<string, OpUsage>;
}

/** What `meta` keeps of the usage between wakes: the day's counts, when they were kept, and this hour's counted
 * votes. */
interface KeptUsage extends Usage {
  kept: number;
  votes?: [hour: string, count: number];
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const utcHour = (now: number) => new Date(now).toISOString().slice(0, 13);

export class PendingQueue {
  private readonly sql: Sql;
  private readonly settings: Settings;
  private readonly transaction: <T>(f: () => T) => T;
  private readonly timer?: (f: () => void, ms: number) => void;
  private readonly addresses: AddressLimiter;
  private readonly votes: AddressLimiter;
  private readonly voters = new Voters();
  /** Read once per wake; dropped when a write fails, so the next request reads what storage has. */
  private meta?: Map<string, string | undefined>;
  private line?: Line;
  /** Written by the current operation, at its end. */
  private readonly dirtyBuckets = new Set<number>();
  private readonly dirtyMeta = new Set<string>();
  /** When each entry's run was last written (its `updated` then). */
  private readonly runSaved = new Map<string, number>();
  // Usage: today's counts (restored from `meta` once per process), the current operation, and when they were kept.
  private usage: Usage;
  private op = "wake";
  private kept = 0;
  private unkept = false;
  private lastOp = 0;
  private timerSet = false;
  private restored = false;
  private votesHour: [string, number] = ["", 0];

  /** `transaction` makes a group of statements all or nothing (a Durable Object's `transactionSync`); `timer` lets the
   * usage counters be kept after requests pause (setTimeout); without it they are kept on the next request. */
  constructor(sql: Sql, settings: Settings, options: { transaction?: <T>(f: () => T) => T; timer?: (f: () => void, ms: number) => void } = {}) {
    this.sql = sql;
    this.settings = settings;
    this.transaction = options.transaction ?? ((f) => f());
    this.timer = options.timer;
    this.addresses = new AddressLimiter(settings.perAddressPerHour);
    this.votes = new AddressLimiter(settings.votesPerAddressPerHour);
    this.usage = { day: utcDay(Date.now()), rows_read: 0, rows_written: 0, ops: {} };
    this.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    this.exec("CREATE TABLE IF NOT EXISTS queue (bucket INTEGER PRIMARY KEY, entries TEXT NOT NULL)");
  }

  /** Runs a statement, counting its rows against today and the current operation. */
  private exec(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    const cursor = this.sql.exec(query, ...bindings);
    const rows = cursor.toArray();
    const read = cursor.rowsRead ?? 0;
    const written = cursor.rowsWritten ?? 0;
    const op = (this.usage.ops[this.op] ??= { n: 0, read: 0, written: 0 });
    op.read += read;
    op.written += written;
    this.usage.rows_read += read;
    this.usage.rows_written += written;
    if (read || written) this.unkept = true;
    return rows;
  }

  /** An operation: counted under `op`; its writes are all or nothing, and a failed one drops what is in memory. */
  private operate<T>(op: string, now: number, f: () => T, write = false): T {
    this.rollDay(now);
    this.op = op;
    (this.usage.ops[op] ??= { n: 0, read: 0, written: 0 }).n++;
    try {
      if (!write) return f();
      // Read (and migrated) before the transaction, so a migration's own transaction is never nested in it.
      this.state();
      return this.transaction(f);
    } catch (error) {
      this.forget();
      throw error;
    } finally {
      this.lastOp = now;
      this.op = "other";
      this.keepUsage(now);
    }
  }

  private forget(): void {
    this.meta = undefined;
    this.line = undefined;
    this.dirtyBuckets.clear();
    this.dirtyMeta.clear();
    this.runSaved.clear();
  }

  /** The held entries and `meta`, read once per wake (migrating an older layout first). */
  private state(): { meta: Map<string, string | undefined>; line: Line } {
    if (this.meta && this.line) return { meta: this.meta, line: this.line };
    const op = this.op;
    this.op = "wake";
    (this.usage.ops.wake ??= { n: 0, read: 0, written: 0 }).n++;
    try {
      let meta = new Map(this.exec("SELECT k, v FROM meta").map((r) => [String(r.k), String(r.v)] as [string, string | undefined]));
      if (meta.get("schema") !== SCHEMA) meta = this.transaction(() => this.migrate(meta));
      const line = new Line(this.exec("SELECT entries FROM queue").flatMap((r) => decode(String(r.entries))));
      for (const [purl, e] of line.rows) if (e.run) this.runSaved.set(purl, e.run.updated);
      this.restoreUsage(meta.get("usage"));
      meta.delete("usage");
      this.meta = meta;
      this.line = line;
      return { meta, line };
    } finally {
      this.op = op;
    }
  }

  /**
   * Once: an older object's tables become this layout in one transaction. `pending` (one rowid row per package, plus
   * its TEXT key's index) and `runs` become the buckets; `meta` becomes WITHOUT ROWID, with the hourly counter
   * (`new_hour`, `new_count`) and the early-run counter (`fast_day`, `fast_count`, `fast_last`) in one key each.
   */
  private migrate(old: Map<string, string | undefined>): Map<string, string | undefined> {
    this.op = "migrate";
    (this.usage.ops.migrate ??= { n: 0, read: 0, written: 0 }).n++;
    const tables = new Map(this.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table'").map((r) => [String(r.name), String(r.sql)]));
    const meta = new Map(old);
    if (meta.has("new_hour")) meta.set("new", `${meta.get("new_hour")} ${Number(meta.get("new_count") ?? 0) || 0}`);
    if (meta.has("fast_day") || meta.has("fast_last"))
      meta.set("fast", `${meta.get("fast_day") ?? ""} ${Number(meta.get("fast_count") ?? 0) || 0} ${Number(meta.get("fast_last") ?? 0) || 0}`);
    for (const k of ["new_hour", "new_count", "fast_day", "fast_count", "fast_last"]) meta.delete(k);
    meta.set("schema", SCHEMA);
    if (/without\s+rowid/i.test(tables.get("meta") ?? "")) this.exec("DELETE FROM meta");
    else {
      this.exec("DROP TABLE IF EXISTS meta");
      this.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    }
    for (const [k, v] of meta) if (v !== undefined) this.exec("INSERT INTO meta (k, v) VALUES (?, ?)", k, v);
    if (tables.has("pending")) {
      const runs = new Map<string, Run>();
      if (tables.has("runs"))
        for (const r of this.exec("SELECT purl, state, since, updated, job FROM runs"))
          runs.set(String(r.purl), { state: String(r.state) as RunState, since: Number(r.since), updated: Number(r.updated), ...(r.job ? { job: JSON.parse(String(r.job)) as Progress } : {}) });
      const line = new Line(
        this.exec("SELECT purl, demand, first_seen, known FROM pending").map((r): [string, Entry] => {
          const purl = String(r.purl);
          const run = runs.get(purl);
          return [purl, { demand: Number(r.demand), firstSeen: Number(r.first_seen), known: Number(r.known) !== 0, ...(run ? { run } : {}) }];
        }),
      );
      for (let b = 0; b < BUCKETS; b++) {
        const entries = line.bucket(b);
        if (entries.length) this.exec("INSERT INTO queue (bucket, entries) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET entries = excluded.entries", b, encode(entries));
      }
      this.exec("DROP TABLE pending");
    }
    this.exec("DROP TABLE IF EXISTS runs");
    this.op = "wake";
    return meta;
  }

  /** Writes what the current operation changed: each bucket and `meta` key once. */
  private commit(): void {
    const { meta, line } = this.state();
    for (const b of this.dirtyBuckets) {
      const entries = line.bucket(b);
      if (entries.length) this.exec("INSERT INTO queue (bucket, entries) VALUES (?, ?) ON CONFLICT(bucket) DO UPDATE SET entries = excluded.entries", b, encode(entries));
      else this.exec("DELETE FROM queue WHERE bucket = ?", b);
      for (const [purl, e] of entries) if (e.run) this.runSaved.set(purl, e.run.updated);
    }
    for (const k of this.dirtyMeta) {
      const v = meta.get(k);
      if (v === undefined) this.exec("DELETE FROM meta WHERE k = ?", k);
      else this.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
    }
    this.dirtyBuckets.clear();
    this.dirtyMeta.clear();
  }

  /** An entry changed (or removed: undefined); its bucket is written at the end of the operation. */
  private put(purl: string, e: Entry | undefined): void {
    const { line } = this.state();
    if (e) line.set(purl, e);
    else {
      line.remove(purl);
      this.runSaved.delete(purl);
    }
    this.dirtyBuckets.add(bucketOf(purl));
  }

  /** A `meta` key set (or removed: undefined), written at the end of the operation only if it changed. */
  private setMeta(k: string, v: string | undefined): void {
    const { meta } = this.state();
    if (meta.get(k) === v) return;
    if (v === undefined) meta.delete(k);
    else meta.set(k, v);
    this.dirtyMeta.add(k);
  }

  private getMeta(k: string): string | undefined {
    return this.state().meta.get(k);
  }

  /** One vote per requester and package, inside the address's and the hour's vote limits; over them the answer is
   * the same, uncounted. */
  private vote(purl: string, address: string, known: boolean, now: number): void {
    if (this.voters.has(purl, address)) return;
    const hour = utcHour(now);
    if (this.votesHour[0] !== hour) this.votesHour = [hour, 0];
    if (this.settings.votesPerHour && this.votesHour[1] >= this.settings.votesPerHour) return;
    if (this.votes.take(address, now)) return;
    this.operate(
      "vote",
      now,
      () => {
        // As before: a held entry keeps its first request and its kind.
        const held = this.state().line.rows.get(purl);
        this.put(purl, held ? { ...held, demand: held.demand + 1 } : { demand: 1, firstSeen: now, known });
        this.commit();
      },
      true,
    );
    // Counted only once written: a failed write is retried, not taken as a repeat.
    this.voters.add(purl, address);
    this.votesHour[1]++;
    this.unkept = true;
    // The operation above may have kept the counts just before this one: keep or schedule it too.
    this.keepUsage(now);
  }

  /** A client's request; `known` when central already has a job for the package (its status is published). */
  request(purl: string, address: string, known: boolean, now = Date.now()): Outcome {
    this.rollDay(now);
    // Read first (once per wake), so the hour's counted votes kept before are known.
    this.state();
    if (known) {
      this.vote(purl, address, true, now);
      return { type: "voted" };
    }
    if (this.held(purl)) {
      this.vote(purl, address, false, now);
      return { type: "queued", ...this.position(purl)!, fastTrack: false };
    }
    return this.operate(
      "register",
      now,
      (): Outcome => {
        const hour = utcHour(now);
        const [h, c] = (this.getMeta("new") ?? "").split(" ");
        const thisHour = h === hour ? Number(c) || 0 : 0;
        if (this.settings.newPerHour && thisHour >= this.settings.newPerHour)
          return { type: "refused", limit: "budget", retryAfter: Math.ceil((3600_000 - (now % 3600_000)) / 1000) };
        const refused = this.addresses.take(address, now);
        if (refused) return { type: "refused", ...refused };
        if (this.count() >= this.settings.maxPending) return { type: "refused", limit: "budget", retryAfter: 3600 };
        this.setMeta("new", `${hour} ${thisHour + 1}`);
        const fastTrack = this.fastTrack(now);
        this.put(purl, { demand: 1, firstSeen: now, known: false, ...(fastTrack ? { run: { state: "dispatched", since: now, updated: now } } : {}) });
        this.commit();
        this.voters.add(purl, address);
        return { type: "queued", ...this.position(purl)!, fastTrack };
      },
      true,
    );
  }

  private count(): number {
    return this.state().line.rows.size;
  }

  held(purl: string): boolean {
    return this.state().line.rows.has(purl);
  }

  /** The place of a held new package: most requested first, then first asked. Central drains new ones by demand too,
   * but breaks ties by adoption (registry downloads), which the gateway does not read: among equal demand this place
   * is an estimate. */
  position(purl: string): { position: number; length: number } | undefined {
    const { line } = this.state();
    const i = line.indexOf(purl);
    return i < 0 ? undefined : { position: i + 1, length: line.length };
  }

  /** What a client is shown about a held new package; undefined when it is not one. */
  view(purl: string, now = Date.now()): View | undefined {
    return this.operate("view", now, () => {
      const at = this.position(purl);
      if (!at) return undefined;
      const run = this.run(purl, now);
      const typical = this.typicalSeconds();
      const spentUntil = this.spentUntil(now);
      const pullsNext = this.pullsNext(now);
      return {
        ...at,
        ...(run && { run }),
        ...(typical !== undefined && { typical }),
        ...(spentUntil !== undefined && { spentUntil }),
        ...(pullsNext !== undefined && { pullsNext }),
      };
    });
  }

  /** Everything held, for a coverage run to take. */
  list(now = Date.now()): Request[] {
    return this.operate("list", now, () =>
      [...this.state().line.rows]
        .sort(([a, x], [b, y]) => x.firstSeen - y.firstSeen || (a < b ? -1 : a > b ? 1 : 0))
        .map(([purl, e]) => ({ purl, demand: e.demand })),
    );
  }

  /** A deployed run took these: their demand is subtracted, so votes that arrived meanwhile stay for the next run. */
  ack(taken: Request[], now = Date.now()): number {
    return this.operate(
      "ack",
      now,
      () => {
        const { line } = this.state();
        let removed = 0;
        let durations: number[] | undefined;
        for (const { purl, demand } of taken) {
          if (typeof purl !== "string" || !Number.isFinite(demand)) continue;
          const e = line.rows.get(purl);
          if (!e) continue;
          const left = e.demand - Math.max(0, Math.floor(demand));
          // The run published it, even when votes that arrived meanwhile keep the package held for the next run: its
          // time from request to acknowledgement joins the typical time.
          if (e.run && e.run.state !== "declined" && e.run.state !== "dispatched")
            durations = [...(durations ?? this.durations()), Math.round((now - e.run.since) / 1000)].slice(-RUN_DURATIONS_KEPT);
          if (left <= 0) {
            this.put(purl, undefined);
            removed++;
          } else if (left !== e.demand || e.run) this.put(purl, { demand: left, firstSeen: e.firstSeen, known: e.known });
        }
        if (durations) this.setMeta("run_durations", JSON.stringify(durations));
        this.commit();
        return removed;
      },
      true,
    );
  }

  /** A held package's run, while it is current; undefined when no run is working it. */
  run(purl: string, now = Date.now()): Run | undefined {
    const run = this.state().line.rows.get(purl)?.run;
    if (!run) return undefined;
    const silent = now - run.updated > (run.state === "dispatched" ? RUN_UNSTARTED_MS : RUN_SILENT_MS);
    return silent ? undefined : run;
  }

  /** What a run reports about the held packages it pulled; packages no longer held are ignored. Written when a
   * package's state changes, or RUN_SAVE_MS after its run was last written; in memory at once. */
  report(updates: { purl: string; state: RunState; job?: Progress }[], now = Date.now()): number {
    return this.operate(
      "report",
      now,
      () => {
        const { line } = this.state();
        let n = 0;
        for (const u of updates) {
          const e = line.rows.get(u.purl);
          if (!e) continue;
          n++;
          const prev = e.run;
          // A report of an older save of the job (two in flight, arriving out of order) never replaces a newer one.
          if (u.job?.updated && prev?.job?.updated && u.job.updated < prev.job.updated) continue;
          const job = u.job ?? prev?.job;
          const next: Entry = { ...e, run: { state: u.state, since: prev?.since ?? now, updated: now, ...(job ? { job } : {}) } };
          // A waiting package's place moves with every start and is reported every few minutes: kept in memory, written
          // only when it starts waiting (after a restart of the object the next report brings the place back).
          const resave = u.state !== "waiting" && now - (this.runSaved.get(u.purl) ?? 0) >= RUN_SAVE_MS;
          if (!prev || prev.state !== u.state || resave) this.put(u.purl, next);
          else line.set(u.purl, next);
        }
        this.commit();
        return n;
      },
      true,
    );
  }

  /** The early run asked for a package could not be started: it waits for the schedule like any other. */
  undispatched(purl: string, now = Date.now()): void {
    this.operate(
      "report",
      now,
      () => {
        const e = this.state().line.rows.get(purl);
        if (e?.run?.state !== "dispatched") return;
        this.put(purl, { demand: e.demand, firstSeen: e.firstSeen, known: e.known });
        this.commit();
      },
      true,
    );
  }

  private durations(): number[] {
    try {
      const v = JSON.parse(this.getMeta("run_durations") ?? "[]") as unknown;
      return Array.isArray(v) ? v.filter((n): n is number => Number.isFinite(n)) : [];
    } catch {
      return [];
    }
  }

  /** The median time of recent runs from request to published, in seconds; undefined before there are any. */
  typicalSeconds(): number | undefined {
    const d = [...this.durations()].sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] : undefined;
  }

  /** What the last coverage run reported: central's budget is spent until this time (ms); undefined clears it. */
  setBudget(spentUntil: number | undefined, now = Date.now()): void {
    this.operate(
      "report",
      now,
      () => {
        this.setMeta("budget_until", spentUntil === undefined ? undefined : String(spentUntil));
        this.commit();
      },
      true,
    );
  }

  /** Until when central's budget is spent (ms), while that is still ahead of `now`; undefined otherwise. */
  spentUntil(now = Date.now()): number | undefined {
    const until = Number(this.getMeta("budget_until"));
    return Number.isFinite(until) && until > now ? until : undefined;
  }

  /** What a run reports of its pulls: it reads the queue again at `next` (ms), or (undefined) no more. When it pulls no
   * more, an early run held back meanwhile may start now, for the new packages still held that asked since then (the
   * run took and published the others), within the day's count and interval as any early run; those packages are then
   * shown as dispatched. Returns them: dispatch the run when there are any. */
  setPulls(next: number | undefined, now = Date.now()): string[] {
    return this.operate(
      "report",
      now,
      () => {
        this.setMeta("pulls_next", next === undefined ? undefined : String(next));
        const since = Number(this.getMeta("fast_held"));
        let started: string[] = [];
        if (next === undefined && Number.isFinite(since)) {
          const waiting = [...this.state().line.rows].filter(([, e]) => !e.known && !e.run && e.firstSeen >= since);
          if (!waiting.length) this.setMeta("fast_held", undefined);
          else if (this.fastTrack(now)) {
            for (const [purl, e] of waiting) this.put(purl, { ...e, run: { state: "dispatched", since: now, updated: now } });
            started = waiting.map(([purl]) => purl);
          }
        }
        this.commit();
        return started;
      },
      true,
    );
  }

  /** When the run working the queue pulls next (ms), while it counts as pulling (PULLS_LATE_MS); undefined otherwise. */
  pullsNext(now = Date.now()): number | undefined {
    const next = Number(this.getMeta("pulls_next"));
    return Number.isFinite(next) && next + PULLS_LATE_MS > now ? next : undefined;
  }

  /** Whether a new package may start a run now: within the day's count and the interval since the last one, and not
   * while central's budget is spent (that run would start nothing, and would use up the day's early runs). Not while a
   * run is pulling the queue either: it takes the package within minutes, and a run started now would only wait
   * behind it (GitHub keeps one pending run per concurrency group, so each would cancel the last). That early run is
   * held back (`fast_held`: when the first was, using none of the day's count) and starts when the pulling run says it
   * is done, if a package that asked since then is still held (arrived after the run's last pull). Counted in one `meta` key: "<UTC day> <runs that day> <last run ms>". */
  private fastTrack(now: number): boolean {
    if (!this.settings.fastTrackPerDay || this.spentUntil(now) !== undefined) return false;
    if (this.pullsNext(now) !== undefined) {
      if (this.getMeta("fast_held") === undefined) this.setMeta("fast_held", String(now));
      return false;
    }
    const day = utcDay(now);
    const [d, c, l] = (this.getMeta("fast") ?? "").split(" ");
    const used = d === day ? Number(c) || 0 : 0;
    const last = Number(l) || 0;
    if (used >= this.settings.fastTrackPerDay || now - last < this.settings.fastTrackIntervalMs) return false;
    this.setMeta("fast", `${day} ${used + 1} ${now}`);
    this.setMeta("fast_held", undefined);
    return true;
  }

  // Usage

  /** A new UTC day starts the counts again; the day that ended is logged and kept first. */
  private rollDay(now: number): void {
    const day = utcDay(now);
    if (day === this.usage.day) return;
    if (this.restored) {
      if (this.unkept) this.keepUsage(now, true);
      console.log(`gateway rows ${this.usage.day}: ${this.usage.rows_read} read, ${this.usage.rows_written} written`);
    }
    this.usage = { day, rows_read: 0, rows_written: 0, ops: {} };
    this.unkept = false;
  }

  /** Adds the counts kept before this process (once): the day goes on where the last process left it. */
  private restoreUsage(json: string | undefined): void {
    if (this.restored) return;
    this.restored = true;
    let kept: KeptUsage | undefined;
    try {
      kept = json ? (JSON.parse(json) as KeptUsage) : undefined;
    } catch {
      kept = undefined;
    }
    if (!kept) return;
    this.kept = Number(kept.kept) || 0;
    if (Array.isArray(kept.votes)) this.votesHour = [String(kept.votes[0]), Number(kept.votes[1]) || 0];
    if (kept.day !== this.usage.day) return;
    this.usage.rows_read += Number(kept.rows_read) || 0;
    this.usage.rows_written += Number(kept.rows_written) || 0;
    for (const [op, u] of Object.entries(kept.ops ?? {})) {
      const mine = (this.usage.ops[op] ??= { n: 0, read: 0, written: 0 });
      mine.n += Number(u.n) || 0;
      mine.read += Number(u.read) || 0;
      mine.written += Number(u.written) || 0;
    }
  }

  /** Keeps today's counts in `meta`: at most every USAGE_FLUSH_MS while requests continue, and USAGE_IDLE_MS after
   * they pause (when a timer is available). A failure to keep them never fails the request. */
  private keepUsage(now: number, force = false): void {
    if (!this.unkept || !this.restored) return;
    if (!force && now - this.kept < USAGE_FLUSH_MS) {
      if (this.timer && !this.timerSet) {
        this.timerSet = true;
        this.timer(() => this.idle(), USAGE_IDLE_MS);
      }
      return;
    }
    const op = this.op;
    this.op = "usage";
    (this.usage.ops.usage ??= { n: 0, read: 0, written: 0 }).n++;
    try {
      // Kept with its own row counted: an upsert into WITHOUT ROWID `meta` reads none and writes one (measured); if
      // the cursor says otherwise, the difference is kept next time.
      const own = (this.usage.ops.usage ??= { n: 0, read: 0, written: 0 });
      const ahead = (u: Usage, d: number): Usage => ({ ...u, rows_written: u.rows_written + d, ops: { ...u.ops, usage: { ...own, written: own.written + d } } });
      const kept: KeptUsage = { ...ahead(this.usage, 1), kept: now, votes: this.votesHour };
      const before = this.usage.rows_read + this.usage.rows_written;
      this.exec("INSERT INTO meta (k, v) VALUES ('usage', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", JSON.stringify(kept));
      this.kept = now;
      this.unkept = this.usage.rows_read + this.usage.rows_written - before !== 1;
    } catch (error) {
      console.log(`gateway usage not kept: ${error instanceof Error ? error.message.slice(0, 200) : error}`);
    } finally {
      this.op = op;
    }
  }

  /** The timer: once requests have paused, the counts are kept; otherwise it waits for the pause. */
  private idle(): void {
    this.timerSet = false;
    const now = Date.now();
    const quiet = now - this.lastOp;
    if (quiet >= USAGE_IDLE_MS || now - this.kept >= USAGE_FLUSH_MS) this.keepUsage(now, true);
    else if (this.unkept && this.timer) {
      this.timerSet = true;
      this.timer(() => this.idle(), USAGE_IDLE_MS - quiet);
    }
  }

  /** Today's rows, the allowance and what is left of it, kept now; for the operator (`/internal/usage`). */
  usageToday(now = Date.now()) {
    this.rollDay(now);
    this.state();
    this.keepUsage(now, true);
    const hour = utcHour(now);
    const [h, c] = (this.getMeta("new") ?? "").split(" ");
    return {
      ...this.usage,
      allowance: ALLOWANCE,
      left: { rows_read: ALLOWANCE.rows_read - this.usage.rows_read, rows_written: ALLOWANCE.rows_written - this.usage.rows_written },
      held: this.count(),
      new_this_hour: h === hour ? Number(c) || 0 : 0,
      votes_this_hour: this.votesHour[0] === hour ? this.votesHour[1] : 0,
    };
  }
}
