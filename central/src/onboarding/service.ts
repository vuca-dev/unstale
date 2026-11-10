import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HttpClient, DEFAULT_HTTP, FetchFailure } from "../collector/http.ts";
import { ExtractFailure } from "../collector/extract.ts";
import { ClassifierError } from "../pipeline/classify/adapter.ts";
import { HttpError } from "../pipeline/llm.ts";
import { latestVersion } from "../docs/monitor.ts";
import { dailyPass, DOCS_PASS, extract, lastPass } from "../docs/extract.ts";
import {
  discoverTechnology,
  DISCOVERY_VERSION,
  releasePattern,
  packageIdentity,
  cargoPurl,
  technologyId,
  pipelineTechnology,
  type PublicTechnology,
} from "./discovery.ts";
import { catalogDir, centralDir } from "../pipeline/paths.ts";
import { advisoryReleases, fetchGuides, fetchReleases, foreignGuides, type GuideNote } from "../pipeline/fetch.ts";
import { logUsage, readJson, sha256, withUsagePhase, writeAtomic } from "../pipeline/util.ts";
import { reconcileLinkedEvidence, reconcileSources } from "./source-quality.ts";
import { synthesize } from "./synthesis.ts";
import { mergeChunkDuplicates, mergeSplitRecords } from "../pipeline/match.ts";
import { publishTechnology } from "../pipeline/publish.ts";
import { typeStubDeprecations } from "../pipeline/type-stubs.ts";
import { JOB_FILE, servedIndex } from "../pipeline/export.ts";
import { loadStore, retractForeignGuideRecords, saveStore } from "../pipeline/store.ts";
import { advisoryStage } from "../pipeline/advisories.ts";
import { LockTimeout, withTechLock, withTechLockSync } from "../pipeline/lock.ts";
import { makeClassifier } from "../pipeline/pipeline.ts";
import { admit, signals, THRESHOLDS, weeklyDownloads, withLifecycle, type Verdict } from "../pipeline/admission.ts";
import { AddressLimiter, DailyBudget, Voters, clientAddress, limitsFromEnv, nextPeriod, noteTokens, quarterKey, type Hold, type Limits, type Refusal } from "./limits.ts";
import { deprecationOf, publishDeprecation } from "./notices.ts";
import { npmPurl } from "../pipeline/ecosystems.ts";
import { clockText, startsAt, type Line, type Rates } from "./eta.ts";
import { PUBLISH_MS } from "./progress.ts";
let classifier: ReturnType<typeof makeClassifier> | undefined;
const advisoryClassifier = () => (classifier ??= makeClassifier());
/** The judge of the token-free first pass: never asked (no notes are read, so nothing is judged), and refusing if it
 * were, so the pass can never spend a model call. */
const noModel = async (): Promise<never> => {
  throw new Error("the advisories first pass makes no model call");
};
import { TECHNOLOGIES } from "../pipeline/technologies.ts";
// Docs requests in flight across all jobs; at most two per host, so more jobs at once never press one site harder.
const docsHttp = new HttpClient({ ...DEFAULT_HTTP, concurrency: Number(process.env.UNSTALE_DOCS_CONCURRENCY ?? 16) || 16, perHost: 2 });
export interface Job {
  schema: 1;
  purl: string;
  technology: string;
  name: string;
  state:
    | "queued"
    | "discovering"
    | "analyzing"
    | "partial"
    | "monitoring"
    | "blocked"
    | "failed";
  stage: string;
  updated: string;
  retry_at?: string;
  descriptor?: PublicTechnology;
  records: number;
  releases_done: number;
  releases_total: number;
  docs_done: number;
  docs_total: number;
  docs_failed: number;
  enumeration?: string;
  failures?: number;
  completed?: string[];
  /** Upgrade guides extracted, by `<keyTag>:audience-v1` (a guide is ingested whole once; edits come as docs notes). */
  guides_done?: string[];
  /** Legacy: page ids of the old inline docs loop; unused, never public. */
  docs_completed?: string[];
  docs_checked?: string;
  next_task?: "history" | "docs";
  /** Why the package passed admission; checked once, before the first crawl or extraction. */
  admitted?: string;
  /** Distinct requesters (a count only; who asked is never stored). The queue's order: most requested first. Never
   * public: a published count would tell how many people use a package. */
  demand?: number;
  /** Weekly registry downloads, read once while the technology is new: among new ones of equal demand, the most
   * adopted drain first. Never public. */
  downloads?: number;
  /** Release-note tokens this technology used in a calendar quarter (the per-technology cap). */
  quarter?: { key: string; tokens: number };
  /** The quarter in which this technology passed its cap: its remaining notes wait behind other technologies. */
  overflow?: string;
  /** Recent release tags (public): two packages of one repository with the same tags are one technology. */
  stream?: string[];
  /** This package is covered as part of that package's technology (same repository and release stream). */
  merged_into?: string;
  /** Packages covered as part of this technology. */
  siblings?: string[];
  /** When the registry's deprecation was published as a record (once). */
  deprecation_notice?: string;
  /** Archived repositories that end a line of this package (`owner/name`, lowercase; admission.ts `Verdict.archived`).
   * Public: a client matches it against the repository its installed version names. */
  archived?: string[];
  /** When `archived` was last read for an admitted package (weekly; a parked one reads it at each admission check).
   * Never public. */
  lifecycle_checked?: string;
  /** The `LIFECYCLE_RULES` that `lifecycle_checked` read with. A parked package checked under older rules is checked
   * again at once, not at its weekly retry. Never public. */
  lifecycle_rules?: number;
  /** When the token-free first pass ran (advisories published ahead of the release history): the job keeps its place
   * among new technologies until its first slice, which clears it. Never public. */
  advisories_first?: string;
  /** A slice still running when its drain ended (killed with the cycle, resumed by the next): its work time so far,
   * the cycles it spanned, its stage then, whether it is a monitored technology's refresh, and whether it started as
   * a new technology's (admission during the slice moves the job out of that line). Cleared when a slice settles.
   * Never public. */
  interrupted?: { ms: number; cycles: number; stage: string; refresh?: boolean; first?: boolean };
  /** Rate-limited (HTTP 429): not started again before this time. Never public. */
  paused_until?: string;
  /** When the technology was first seen monitored (its first coverage done). Every later slice is monitoring in the
   * usage log, also one that continues a refresh which yielded (queued) partway. Never public. */
  monitored?: string;
  /** Last successful upstream release-list check (not a read from its freshness cache). Operator-only. */
  release_checked?: string;
  /** Last completed refresh, independently of votes or intermediate state writes. Operator-only. */
  refresh_completed?: string;
  registry_polled?: string;
  registry_version?: string;
  registry_checked?: string;
  change_detected?: string;
}

/** Work time after which an interrupted slice is not resumed: two full cycles (20 minutes each), about 12 times the
 * longest slice measured (a 638-page docs pass, 199 s). Slices are meant to take about a minute. */
export const SLICE_LIMIT_MS = 40 * 60_000;
/** Cycles after which an interrupted slice is not resumed whatever its known work time: a run cancelled or crashed
 * mid-cycle records no time. */
export const SLICE_LIMIT_CYCLES = 4;
/** A stopped slice is retried after the refresh period, so it holds a slot for at most two cycles in eighteen. */
const STOPPED_RETRY_MS = 6 * 3600_000;
/** The first pause after a rate limit, doubled for each rate limit that follows one, up to the last. */
const RATE_PAUSE_MS = [60_000, 15 * 60_000] as const;
/** A refusal for rate (HTTP 429) from any service a job reads: `HTTP 429` (the collector's client), `<url>: 429`
 * (the registry and GitHub readers). */
const RATE_LIMITED = /(?:HTTP |: )429\b/;
/** Whether a job's error is a rate limit, and the server's Retry-After when it sent one. It says nothing about the
 * package: it is the runner's own request rate. */
export function rateLimit(error: unknown): { retryAfterMs?: number } | undefined {
  if (error instanceof FetchFailure && error.httpStatus !== undefined)
    return error.httpStatus === 429 ? (error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) : undefined;
  return RATE_LIMITED.test(String(error instanceof Error ? error.message : error)) ? {} : undefined;
}
const clock = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Tags compared per package, and the share two packages must have in common to be one release stream. */
const STREAM_TAGS = 100;
const SAME_STREAM = 0.8;
export function sameStream(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length < 2 || b.length < 2) return false;
  const x = new Set(a.slice(0, STREAM_TAGS));
  const y = new Set(b.slice(0, STREAM_TAGS));
  const common = [...x].filter((t) => y.has(t)).length;
  return common / (x.size + y.size - common) >= SAME_STREAM;
}
const advisoryRecords = (n: number) => `${n} security advisory record${n === 1 ? "" : "s"}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The package URL of a package name in the same ecosystem as `purl` (PyPI names PEP 503-normalised). */
export const typedPurl = (purl: string, name: string): string =>
  purl.startsWith("pkg:cargo/")
    ? cargoPurl(name)
    : purl.startsWith("pkg:pypi/")
      ? `pkg:pypi/${name.toLowerCase().replace(/[-_.]+/g, "-")}`
      : npmPurl(name);
const requestSchema = z.object({ purl: z.string().max(230) }).strict();
const jobPath = (purl: string) =>
  join(centralDir(), "onboarding", "jobs", `${sha256(purl)}.json`);
const now = () => new Date().toISOString();
// Job timeline: one line per saved state, public identity and counters only, so stage durations (queue wait, per
// release, per docs page) can be measured before any completion estimate is shown. Fails open: a timeline write never
// fails a job.
export const timelinePath = () => join(centralDir(), "onboarding", "timeline.jsonl");
/** The last drain's throughput per line (eta.ts), for the estimates a drain gives before it has measured its own. */
const throughputPath = () => join(centralDir(), "onboarding", "throughput.json");
/** A drain's own rate is used once it has run this long; before, the last drain's. */
const MEASURE_MS = 5 * 60_000;

/** A waiting job's place in its line (eta.ts), the estimate of when a run starts it, and the stage a client reads. */
export interface Place {
  line: Line;
  position: number;
  length: number;
  /** When a run is estimated to start it (ISO 8601), from the measured throughput of its line; absent without one. */
  starts_at?: string;
  stage: string;
}
function timeline(job: Job) {
  try {
    mkdirSync(join(centralDir(), "onboarding"), { recursive: true });
    const { purl, technology, state, records, releases_done, releases_total, docs_done, docs_total, next_task } = job;
    appendFileSync(timelinePath(), JSON.stringify({ at: job.updated, purl, technology, state, records, releases_done, releases_total, docs_done, docs_total, next_task }) + "\n");
  } catch {
    /* measurement only */
  }
}
export class CoverageService {
  readonly jobs = new Map<string, Job>();
  private running = new Set<string>();
  private interval: NodeJS.Timeout | undefined;
  /** Batch mode (`drain`): the time after which no job is started; 0 while serving. */
  private draining = 0;
  /** The drain ended before its deadline to publish its newly pulled packages' decisions (`drain`'s `early`). */
  private endedEarly = false;
  /** Batch mode before `drain`: requests are queued but nothing starts (`hold`). */
  private held = false;
  /** Jobs started since construction (a drain reports its share). */
  private launched = 0;
  /** The budget limits that held work back since the drain began, by limit: a drain that starts nothing says why. */
  private holds = new Map<Hold["limit"], Hold>();
  /** Running jobs that started as new technologies (tier 1): what the slots kept for them hold. */
  private runningNew = new Set<string>();
  /** Running slices: when each started, whether it is a refresh, and whether it started as a new technology's (for the
   * jobs a drain's end interrupts). */
  private slices = new Map<string, { at: number; refresh: boolean; first: boolean }>();
  /** Running slices resumed after an interruption: they never hold the slots kept for new technologies. */
  private runningCarried = new Set<string>();
  /** Interrupted slices stopped when this process loaded the jobs (stopSlice). */
  private stopped = 0;
  /** Rate limited: nothing starts before this time; the pause doubles while rate limits follow one another. */
  private pausedUntil = 0;
  private pauseMs = 0;
  /** This drain's starts per line, the first fill of its slots apart (not throughput), and when it began. */
  private lineStarts: Record<Line, number> = { new: 0, admitted: 0 };
  private fill: Record<Line, number> = { new: 0, admitted: 0 };
  private drainStart = 0;
  /** This drain's slices by kind (new technology, refresh, other admitted work): started, and settled by outcome. */
  private tally = blankTally();
  /** Rate-limit pauses begun this drain (a 429 while one holds extends it, and is not counted again). */
  private pauses = 0;
  private measuredDrain?: DrainMetrics;
  private graceMs = 0;
  readonly concurrency: number;
  /** The advisories stage after a technology's history is published (off: `advisories: false` or UNSTALE_NO_ADVISORIES=1). */
  readonly advisories: boolean;
  /** Token-free first passes at once (advisories before history, `advisoryPass`); 0: none. Apart from `concurrency`. */
  readonly advisoriesFirst: number;
  /** Jobs in a first pass now. */
  private passing = new Set<string>();
  readonly limits: Limits;
  readonly addresses: AddressLimiter;
  /** Votes per address, a bucket apart from new technologies. */
  readonly votes: AddressLimiter;
  private readonly budget: DailyBudget;
  private readonly voters = new Voters();
  /** Admission of a package before any crawl or model call; the default reads registry and GitHub signals. */
  private readonly admission: (purl: string, repo: string | undefined) => Promise<Verdict>;
  /** Weekly downloads by purl, for the order of new technologies; a count left out reads as 0. */
  private readonly adoption: (purls: string[]) => Promise<Map<string, number>>;
  /** Jobs whose adoption this process already tried to read: an unreadable count is read again by the next process. */
  private readonly adoptionTried = new Set<string>();
  constructor(
    concurrency = 2,
    opts: {
      advisories?: boolean;
      /** First passes at once (default 0: off; the batch drain turns them on). */
      advisoriesFirst?: number;
      limits?: Limits;
      admission?: (purl: string, repo: string | undefined) => Promise<Verdict>;
      adoption?: (purls: string[]) => Promise<Map<string, number>>;
    } = {},
  ) {
    this.concurrency = concurrency;
    this.advisories =
      opts.advisories ?? process.env.UNSTALE_NO_ADVISORIES !== "1";
    this.advisoriesFirst = this.advisories ? Math.max(0, Math.floor(opts.advisoriesFirst ?? 0)) : 0;
    this.limits = opts.limits ?? limitsFromEnv();
    this.addresses = new AddressLimiter(this.limits.perAddressPerHour);
    this.votes = new AddressLimiter(this.limits.votesPerAddressPerHour);
    this.budget = new DailyBudget(this.limits);
    this.admission =
      opts.admission ??
      (async (purl, repo) =>
        withLifecycle(admit(await signals(purl, repo), THRESHOLDS[/^pkg:(\w+)\//.exec(purl)?.[1] ?? ""]), repo));
    this.adoption = opts.adoption ?? weeklyDownloads;
    const folder = join(centralDir(), "onboarding", "jobs");
    if (existsSync(folder))
      for (const file of readdirSync(folder).filter((f) =>
        JOB_FILE.test(f),
      )) {
        const job = readJson<Job>(join(folder, file));
        if (job) {
          if (
            job.descriptor &&
            job.descriptor.discovery_version !== DISCOVERY_VERSION
          ) {
            const old = job.descriptor;
            old.tag = releasePattern(old.purl, old.repo, old.directory);
            if (old.repo)
              withTechLockSync(old.id, "onboarding", () => {
                if (reconcileSources(pipelineTechnology(old)))
                  publishTechnology(loadStore(old.id), now(), catalogDir());
              });
            delete job.descriptor;
            delete job.docs_checked;
            job.docs_completed = [];
            job.docs_done = 0;
            job.docs_failed = 0;
            job.state = "queued";
            job.stage =
              "Refreshing public source identity and documentation scope";
          }
          if (["discovering", "analyzing", "partial"].includes(job.state)) {
            // Interrupted without a drain's end to say so (a cancelled run, or a state saved before this field): one
            // cycle, its time unknown.
            job.interrupted ??= { ms: 0, cycles: 1, stage: job.stage };
            if (job.interrupted.ms >= SLICE_LIMIT_MS || job.interrupted.cycles >= SLICE_LIMIT_CYCLES) this.stopSlice(job);
            else {
              job.state = "queued";
              job.stage = "Resuming interrupted coverage";
            }
          }
          // Rate limits were once counted as the job's failures (backoff up to 6 h for 429s the runner caused): such a
          // job is retried now, its count cleared.
          if (job.failures && (job.state === "failed" || (job.state === "monitoring" && job.stage.includes("refresh failed ("))) && RATE_LIMITED.test(job.stage)) {
            job.failures = 0;
            if (job.state === "failed") {
              delete job.retry_at;
              this.save(job, "queued", "Waiting for a coverage worker");
            } else {
              job.retry_at = now();
              this.persist(job);
            }
          }
          // A package parked by admission under older lifecycle rules is checked again now: what the rules added (an
          // archived repository, an announced end of development) reaches clients without waiting a week.
          if (job.state === "blocked" && !job.admitted && job.retry_at && (job.lifecycle_rules ?? 0) < LIFECYCLE_RULES && job.stage.startsWith("Not admitted for monitoring:")) {
            job.retry_at = now();
            this.persist(job);
          }
          this.jobs.set(job.purl, job);
        }
      }
  }
  /** A slice interrupted past SLICE_LIMIT_MS of work (or SLICE_LIMIT_CYCLES) is not resumed every cycle: it is stopped,
   * counted as a failure, its stage named, and retried after STOPPED_RETRY_MS. A monitored technology keeps its
   * coverage and stays `monitoring`. */
  private stopSlice(job: Job) {
    const { ms, cycles, stage, refresh, first } = job.interrupted!;
    delete job.interrupted;
    job.failures = (job.failures ?? 0) + 1;
    const at = Date.now() + STOPPED_RETRY_MS;
    job.retry_at = new Date(at).toISOString();
    const why = `"${stage}" did not finish in ${Math.round(ms / 60_000)} minutes over ${cycles} cycles; retried after ${clock(at)} UTC`;
    sliceFailed(job, first ?? this.tier(job) === 1, !!refresh, "stopped");
    if (refresh) this.save(job, "monitoring", `${job.records} verified records; refresh stopped: ${why}`);
    else this.save(job, "failed", `Stopped: ${why}`);
    this.stopped++;
  }
  /** Persists counters (a vote) without a timeline line: the timeline records state changes. */
  private persist(job: Job) {
    writeAtomic(jobPath(job.purl), JSON.stringify(job, null, 1));
  }
  private save(job: Job, state = job.state, stage = job.stage) {
    job.state = state;
    job.stage = stage;
    job.updated = now();
    if (state === "monitoring" && !job.merged_into) job.monitored ??= job.updated;
    writeAtomic(jobPath(job.purl), JSON.stringify(job, null, 1));
    timeline(job);
  }
  status(purl: string): Job | undefined {
    packageIdentity(purl);
    return this.jobs.get(purl);
  }
  /**
   * A client's request. A known technology answers with its job, and the request is a vote: one per requester and
   * technology, within the address's vote limit (a vote over it is not counted; the answer is the same). A new one
   * passes the address's limit of new technologies, a separate bucket, and is queued: the budget limits how fast the
   * queue drains, never who may enter.
   */
  register(purl: string, address: string): Job | Refusal {
    packageIdentity(purl);
    const existing = this.jobs.get(purl);
    if (existing) {
      this.vote(existing, address);
      return existing;
    }
    const refused = this.addresses.take(address);
    if (refused) return refused;
    const job = this.submit(purl);
    this.vote(job, address, false);
    return job;
  }
  private vote(job: Job, address: string, limited = true) {
    const target = (job.merged_into && this.jobs.get(job.merged_into)) || job;
    if (this.voters.has(target.purl, address)) return;
    if (limited && this.votes.take(address)) return;
    this.voters.add(target.purl, address);
    target.demand = (target.demand ?? 0) + 1;
    this.persist(target);
  }
  private due(job: Job): boolean {
    // A blocked job is retried only when it set a time (admission); a job with no official sources stays blocked.
    return (
      !job.merged_into &&
      !(Date.parse(job.paused_until ?? "") > Date.now()) &&
      (job.state === "queued" ||
        (["failed", "monitoring", "blocked"].includes(job.state) && Date.parse(job.retry_at ?? "") <= Date.now()))
    );
  }
  /** 0: refreshes, retries and continued history of admitted technologies; 1: new; 2: past their quarterly cap. */
  private tier(job: Job): number {
    if (job.overflow === quarterKey()) return 2;
    // Admitted by the first pass only: still new, in the same line as before it.
    if (job.advisories_first && !job.completed?.length && job.state !== "monitoring") return 1;
    return job.admitted || job.state === "monitoring" || job.completed?.length ? 0 : 1;
  }
  /** Whether a job is being worked now (its state alone does not say: `partial` continues through the docs pass). */
  working(purl: string): boolean {
    return this.running.has(purl);
  }
  /** Slots a waiting new technology may always take: refreshes and continued history (tier 0, and tier 2) fill at
   * most the rest while one waits, so a new package starts at the next free slot however much admitted work is due.
   * It never jumps the line of new technologies, which keeps its own order. One slot in three; none with one slot. */
  get newSlots(): number {
    return this.concurrency > 1 ? Math.max(1, Math.floor(this.concurrency / 3)) : 0;
  }
  /**
   * The drain order: by tier, then most requested first (pure demand, no aging). Among new technologies of equal demand
   * the most adopted (weekly registry downloads) go first, a proxy for impact; an unread count is 0. Remaining ties keep
   * arrival order (a continued job goes to the back).
   */
  queue(): Job[] {
    const adoption = (j: Job) => (this.tier(j) === 1 ? (j.downloads ?? 0) : 0);
    return [...this.jobs.values()]
      .filter((j) => this.due(j))
      .sort((a, b) => this.tier(a) - this.tier(b) || Number(!!b.change_detected) - Number(!!a.change_detected) || (b.demand ?? 0) - (a.demand ?? 0) || adoption(b) - adoption(a));
  }
  /** The line a waiting job is in (eta.ts): new technologies wait only behind new ones (`newSlots`), the rest behind
   * the rest. */
  private line(job: Job): Line {
    return this.tier(job) === 1 ? "new" : "admitted";
  }
  /** Starts a minute per line: this drain's own once it has run MEASURE_MS, otherwise the last drain's. */
  rates(at = Date.now()): Rates {
    const own = this.measured(at);
    let last: Rates = {};
    if (!own.new || !own.admitted) last = readJson<{ rates?: Rates }>(throughputPath())?.rates ?? {};
    const out: Rates = {};
    for (const l of ["new", "admitted"] as const) {
      const r = own[l] ?? last[l];
      if (r !== undefined) out[l] = r;
    }
    return out;
  }
  /** This drain's starts a minute per line after its first fill, once it has run MEASURE_MS; a line that started
   * nothing since has no rate (it may have had nothing waiting). */
  private measured(at: number): Rates {
    const elapsed = Math.min(at, this.draining || at) - this.drainStart;
    if (!this.drainStart || elapsed < MEASURE_MS) return {};
    const out: Rates = {};
    for (const l of ["new", "admitted"] as const) {
      const n = this.lineStarts[l] - this.fill[l];
      if (n > 0) out[l] = n / (elapsed / 60_000);
    }
    return out;
  }
  /**
   * Every waiting job's place in its line, the queue computed once, and when a run is estimated to start it (only in
   * a drain, from its line's measured rate and the drain's cycles; none while the budget holds work back). A
   * monitored technology waiting for its refresh counts in its line (it takes a start) but is shown no place: it has
   * its coverage, a place is noise there.
   */
  waiting(at = Date.now()): Map<string, Place> {
    const queue = this.queue().filter((j) => !this.running.has(j.purl));
    const count: Record<Line, number> = { new: 0, admitted: 0 };
    const placed = queue.map((job) => {
      const line = this.line(job);
      return { job, line, position: ++count[line] };
    });
    const rates = this.draining && !this.holds.size ? this.rates(at) : {};
    const windowMs = this.draining - this.drainStart;
    const cadence = {
      windowEnd: this.draining,
      gapMs: Math.max(0, this.draining + this.graceMs - Math.max(at, this.draining)) + PUBLISH_MS,
      windowMs,
      cycleGapMs: this.graceMs + PUBLISH_MS,
    };
    const out = new Map<string, Place>();
    for (const { job, line, position } of placed) {
      if (job.state === "monitoring") continue;
      const length = count[line];
      const t = this.draining ? startsAt(at, position, rates[line], cadence) : undefined;
      const what = line === "new" ? "new technologies" : "technologies continuing coverage";
      const when = t === undefined ? "" : `; a run reaches it at about ${clockText(t, at)}`;
      out.set(job.purl, {
        line,
        position,
        length,
        ...(t !== undefined && { starts_at: new Date(t).toISOString() }),
        // A failed or blocked job due for its retry waits too: its stage says why it failed, the place is the retry's.
        stage: `${job.stage} (${job.state === "queued" ? "" : "retry: "}position ${position} of ${length} ${what}${when})`,
      });
    }
    return out;
  }
  /** A job's public fields, with its place when it waits. */
  private placed(job: Job, place: Place | undefined) {
    const fields = publicJob(job);
    if (!place) return fields;
    return { ...fields, stage: place.stage, queue_position: place.position, queue_length: place.length, ...(place.starts_at && { starts_at: place.starts_at }) };
  }
  /** Reads adoption for waiting new technologies that lack it, once per process each, for at most `timeout` ms so a
   * slow registry never holds up a drain; an unreadable count stays unset (fails open: 0 in the order). */
  async readAdoption(timeout = 120_000): Promise<void> {
    const want = [...this.jobs.values()].filter((j) => this.due(j) && this.tier(j) === 1 && j.downloads === undefined && !this.adoptionTried.has(j.purl));
    if (!want.length) return;
    for (const j of want) this.adoptionTried.add(j.purl);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Map<string, number>>((resolve) => (timer = setTimeout(() => resolve(new Map()), timeout)));
    const counts = await Promise.race([this.adoption(want.map((j) => j.purl)).catch(() => new Map<string, number>()), late]);
    clearTimeout(timer);
    for (const j of want) {
      const n = counts.get(j.purl);
      if (n === undefined || !Number.isFinite(n)) continue;
      j.downloads = n;
      this.persist(j);
    }
  }
  /** A job as clients see it: internal fields dropped; a waiting job carries its place in the queue. */
  publicStatus(job: Job) {
    return this.placed(job, this.waiting().get(job.purl));
  }
  submit(purl: string): Job {
    packageIdentity(purl);
    const existing = this.jobs.get(purl);
    if (existing) return existing;
    const known = Object.values(TECHNOLOGIES).find((t) =>
      t.components.includes(purl),
    );
    const job: Job = {
      schema: 1,
      purl,
      technology: known?.id ?? technologyId(purl),
      name: known?.name ?? packageIdentity(purl),
      state: "queued",
      stage: "Waiting for a coverage worker",
      updated: now(),
      records: 0,
      releases_done: 0,
      releases_total: 0,
      docs_done: 0,
      docs_total: 0,
      docs_failed: 0,
    };
    this.jobs.set(purl, job);
    this.save(job);
    this.pump();
    return job;
  }
  start() {
    const tick = () => {
      void this.readAdoption();
      this.pump();
    };
    tick();
    this.interval = setInterval(tick, 5000);
    return this;
  }
  stop() {
    clearInterval(this.interval);
  }
  /** Batch mode: queue requests without starting any job until `drain`. */
  hold(): this {
    this.held = true;
    return this;
  }
  /**
   * Requests gathered elsewhere (the gateway's queue): `demand` distinct requesters per package, already deduplicated
   * and address-limited there. A known package gains the votes; a new one is queued. Invalid identities are skipped.
   */
  enqueue(requests: Iterable<{ purl: string; demand: number }>): string[] {
    const taken: string[] = [];
    for (const { purl, demand } of requests) {
      try {
        packageIdentity(purl);
      } catch {
        continue;
      }
      const job = this.jobs.get(purl) ?? this.submit(purl);
      const target = (job.merged_into && this.jobs.get(job.merged_into)) || job;
      target.demand = (target.demand ?? 0) + Math.max(0, Math.floor(demand));
      this.persist(target);
      taken.push(purl);
    }
    return taken;
  }
  /**
   * Batch mode for an ephemeral runner: works the queue until nothing more can start (empty, not yet due, or the
   * budget spent) or `deadline` passes, then waits for running jobs up to `grace` ms. A job still running then is
   * resumed by the next run (an interrupted job is requeued on load). Requests enqueued meanwhile join the queue.
   * `drained`: nothing more could start, before the deadline or once the grace period's jobs finished (work may be
   * left only when it is false). `held` names the budget limits that refused work during the drain, each with its cap and when it
   * resets, so a drain that started nothing (or less than the queue held) says why.
   */
  async drain(
    deadline: number,
    grace = 10 * 60_000,
    poll = 500,
    early?: { due: () => boolean; graceMs: number },
  ): Promise<{ started: number; unfinished: number; drained: boolean; early?: true; held?: Hold[]; rate_limited?: number; stopped?: number }> {
    this.draining = deadline;
    this.tally = blankTally();
    this.pauses = 0;
    const tokensBefore = this.budget.tokensLeft();
    const pool = docsHttp.poolWaits();
    const cpu = process.cpuUsage();
    this.graceMs = grace;
    this.endedEarly = false;
    this.holds.clear();
    this.held = false;
    const before = this.launched;
    // The first fill of the slots is not throughput: the rates a client's estimate uses start after it.
    this.drainStart = Date.now();
    this.lineStarts = { new: 0, admitted: 0 };
    this.pump();
    this.fill = { ...this.lineStarts };
    // A finished job starts the next itself, and the queue is looked at every poll (a rate-limit pause ends); when
    // nothing is running, nothing more starts and no rate-limited job resumes before the deadline, the queue is done.
    // First passes are token-free: they go on while the budget holds every slice back.
    // `early`: the cycle ends before its deadline so that it publishes now (its newly pulled packages are decided); the
    // shorter grace keeps that publish minutes away, and a slice still running then resumes in the next cycle.
    let ended = false;
    while (Date.now() < deadline && !(ended = !!early?.due()) && (this.pump() || this.running.size || this.passing.size || this.resumesBefore(deadline)))
      await new Promise((r) => setTimeout(r, poll));
    // Nothing starts from here, as past a deadline (pump). The estimates keep the full cycle's window: later cycles
    // are full ones unless they too end early, so a later estimate stays on the safe side.
    this.endedEarly = ended;
    const drained = !ended && Date.now() < deadline;
    const stop = Date.now() + (ended ? early!.graceMs : grace);
    while ((this.running.size || this.passing.size) && Date.now() < stop) await new Promise((r) => setTimeout(r, poll));
    // A slice still running is killed with this cycle and resumed by the next: its work time so far is kept, so one
    // that cannot finish is stopped instead of being resumed first every cycle (stopSlice).
    for (const purl of this.running) {
      const job = this.jobs.get(purl)!;
      const slice = this.slices.get(purl)!;
      const prev = job.interrupted;
      job.interrupted = { ms: (prev?.ms ?? 0) + Date.now() - slice.at, cycles: (prev?.cycles ?? 0) + 1, stage: job.stage, refresh: prev?.refresh ?? slice.refresh, first: prev?.first ?? slice.first };
      this.persist(job);
    }
    this.keepRates();
    this.measuredDrain = {
      slices: this.tally,
      pauses: this.pauses,
      tokens: Number.isFinite(tokensBefore) ? Math.max(0, tokensBefore - this.budget.tokensLeft()) : null,
      docs_pool: { waits: docsHttp.poolWaits().waits - pool.waits, waited_ms: docsHttp.poolWaits().waited_ms - pool.waited_ms },
      cpu_s: ((used) => Math.round((used.user + used.system) / 1e5) / 10)(process.cpuUsage(cpu)),
      max_rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
    };
    const held = [...this.holds.values()];
    const paused = [...this.jobs.values()].filter((j) => Date.parse(j.paused_until ?? "") > Date.now()).length;
    // A rate-limited job is work left: the next cycle retries it.
    const done = !paused && (drained || (!this.running.size && !this.queue().length));
    return {
      started: this.launched - before,
      unfinished: this.running.size,
      drained: done,
      ...(ended ? { early: true as const } : {}),
      ...(held.length ? { held } : {}),
      ...(paused ? { rate_limited: paused } : {}),
      ...(this.stopped ? { stopped: this.stopped } : {}),
    };
  }
  /** The last drain's own measurements (its final line's `metrics`). */
  metrics(): DrainMetrics | undefined {
    return this.measuredDrain;
  }
  /** Unique monitored jobs, independent of slice counts. Unknown ages stay explicit during migration. */
  freshness(at = Date.now()) {
    const jobs = [...this.jobs.values()].filter((j) => !j.merged_into && (j.monitored || j.state === "monitoring"));
    const ages = jobs.flatMap((j) => {
      const checked = Date.parse(j.release_checked ?? "");
      return Number.isFinite(checked) ? [Math.max(0, at - checked) / 1000] : [];
    }).sort((a, b) => a - b);
    const percentile = (p: number) => ages.length ? Math.round(ages[Math.ceil(ages.length * p) - 1]!) : null;
    return { monitored: jobs.length, release_check_unknown: jobs.length - ages.length,
      release_check_age_s: { p50: percentile(0.5), p95: percentile(0.95), max: ages.length ? Math.round(ages[ages.length - 1]!) : null },
      release_checks_over_6h: ages.filter((s) => s > 6 * 3600).length,
      registry_check_unknown: jobs.filter((j) => !j.registry_checked).length,
      registry_check_oldest: jobs.filter((j) => j.registry_checked).map((j) => j.registry_checked!).sort()[0] ?? null,
      detected_waiting: jobs.filter((j) => j.change_detected).length,
      refresh_due: jobs.filter((j) => this.due(j)).length };
  }
  /** Cheap detection before the drain starts: no model, GitHub, docs crawl or gateway write. At most
   * two registry requests in flight, 200 primary packages and 60 seconds per cycle, oldest polled first.
   * Full refreshes remain due independently, so advisories, sibling packages and delayed GitHub notes still run.
   */
  async pollChanges(opts: { limit?: number; milliseconds?: number; read?: (purl: string) => Promise<string | undefined> } = {}) {
    if (this.running.size || this.passing.size) throw new Error("registry polling must precede worker startup");
    const pausePath = join(centralDir(), "onboarding", "registry-poll.json");
    const pause = readJson<{ retry_at: string }>(pausePath);
    if (Date.parse(pause?.retry_at ?? "") > Date.now())
      return { attempted: 0, checked: 0, changed: 0, paused_until: pause!.retry_at };
    const http = new HttpClient({ ...DEFAULT_HTTP, concurrency: 2, perHost: 2, timeoutMs: 5000, retries: 0,
      maxRetryAfterMs: 0, maxBytes: 4 * 1024 * 1024 });
    const read = opts.read ?? ((purl: string) => latestVersion(http, purl, { throwRateLimits: true }));
    let paused = false;
    const deadline = Date.now() + (opts.milliseconds ?? 60_000);
    const jobs = [...this.jobs.values()].filter((j) => j.state === "monitoring" && !j.merged_into && j.descriptor
      && !(Date.parse(j.paused_until ?? "") > Date.now()))
      .sort((a, b) => (Date.parse(a.registry_polled ?? "") || 0) - (Date.parse(b.registry_polled ?? "") || 0))
      .slice(0, opts.limit ?? 200);
    let attempted = 0, checked = 0, changed = 0;
    const worker = async () => {
      while (!paused && Date.now() < deadline) {
        const job = jobs.shift();
        if (!job) return;
        attempted++;
        job.registry_polled = now();
        let version: string | undefined;
        try { version = await read(job.purl); } catch (e) {
          // A provider refusal stops the polling lane, including across cycles, without blocking other work.
          if (e instanceof FetchFailure && e.httpStatus === 429) {
            paused = true;
            const existing = Date.parse(readJson<{ retry_at: string }>(pausePath)?.retry_at ?? "") || 0;
            writeAtomic(pausePath, JSON.stringify({ retry_at: new Date(Math.max(existing, Date.now() + Math.max(60_000, e.retryAfterMs ?? 0))).toISOString() }));
          }
        }
        if (typeof version === "string" && /^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(version)) {
          checked++;
          job.registry_checked = now();
          const previous = job.registry_version ?? job.descriptor!.latest;
          if (previous !== version) {
            changed++;
            job.change_detected ??= now();
            // Respect server-directed rate pauses; due() still enforces paused_until.
            job.retry_at = now();
          }
          job.registry_version = version;
        }
        this.persist(job);
      }
    };
    await Promise.all([worker(), worker()]);
    return { attempted, checked, changed };
  }
  /** This drain's measured rates, for the next drain's first minutes; a line it measured nothing for keeps the last. */
  private keepRates(): void {
    const own = this.measured(Date.now());
    if (!own.new && !own.admitted) return;
    const last = readJson<{ rates?: Rates }>(throughputPath())?.rates ?? {};
    writeAtomic(throughputPath(), JSON.stringify({ at: now(), rates: { ...last, ...own } }));
  }
  /** Whether a rate-limit pause ends before `deadline` with work to start then. */
  private resumesBefore(deadline: number): boolean {
    const now = Date.now();
    if (this.pausedUntil > now && this.pausedUntil < deadline && this.queue().length) return true;
    for (const j of this.jobs.values()) {
      const t = Date.parse(j.paused_until ?? "");
      if (t > now && t < deadline) return true;
    }
    return false;
  }
  /** A rate limit: nothing starts for a pause (doubled while rate limits follow one another, at least the server's
   * Retry-After); returns when the pause ends. */
  private ratePause(retryAfterMs = 0): number {
    const t = Date.now();
    if (t >= this.pausedUntil) this.pauses++;
    if (t >= this.pausedUntil) this.pauseMs = this.pauseMs ? Math.min(RATE_PAUSE_MS[1], this.pauseMs * 2) : RATE_PAUSE_MS[0];
    this.pausedUntil = Math.max(this.pausedUntil, t + Math.max(this.pauseMs, retryAfterMs));
    return this.pausedUntil;
  }
  /** The budget limits at their cap now (see DailyBudget.spent). */
  spent(): Hold[] {
    return this.budget.spent();
  }
  /** A budget refusal: the limits now at their cap join what this drain reports as holding work back (read once per
   * limit, so the jobs of a long drain refused one by one do not read the budget file twice each). */
  private heldBack(limit: Hold["limit"]) {
    if (this.holds.has(limit)) return;
    for (const h of this.budget.spent()) this.holds.set(h.limit, h);
  }
  /** Every job as `GET /coverage` answers it (the queue order computed once), for a static copy of the answers. */
  statuses(): ReturnType<typeof publicJob>[] {
    const waiting = this.waiting();
    return [...this.jobs.values()].map((job) => {
      // A package covered as part of another technology answers with that technology's counters, so a client never
      // reads its own zeros (it never extracts anything itself) as a source that yielded nothing.
      const host = job.merged_into ? this.jobs.get(job.merged_into) : undefined;
      const fields = this.placed(job, waiting.get(job.purl));
      return host
        ? { ...fields, records: host.records, releases_done: host.releases_done, releases_total: host.releases_total, docs_done: host.docs_done, docs_total: host.docs_total, docs_failed: host.docs_failed }
        : fields;
    });
  }
  /** Starts what the queue and the budget allow, in queue order except that admitted work leaves `newSlots` to a
   * waiting new technology (a second pass fills what no new technology took); returns how many jobs it started. A
   * drain past its deadline starts nothing. */
  private pump(): number {
    const started = this.pumpJobs();
    this.pumpAdvisories();
    return started;
  }
  private pumpJobs(): number {
    if (this.held || (this.draining && (this.endedEarly || Date.now() >= this.draining)) || Date.now() < this.pausedUntil) return 0;
    const queue = this.queue();
    // Keep one slot moving through overdue monitored jobs, oldest due first. Other slots retain demand order
    // and the existing new-package reservation, so historical backfill and onboarding continue to progress.
    if (![...this.slices.values()].some((slice) => slice.refresh)) {
      const oldest = queue.filter((j) => j.state === "monitoring" && this.tier(j) === 0 && !this.running.has(j.purl))
        .sort((a, b) => Date.parse(a.retry_at!) - Date.parse(b.retry_at!))[0];
      if (oldest) {
        queue.splice(queue.indexOf(oldest), 1);
        queue.unshift(oldest);
      }
    }
    let waitingNew = queue.filter((j) => this.tier(j) === 1 && !this.running.has(j.purl)).length;
    let started = 0;
    for (const capped of [true, false])
      for (const job of queue) {
        if (this.running.size >= this.concurrency) return started;
        if (this.running.has(job.purl) || this.passing.has(job.purl)) continue;
        // Resumed slices never take every slot: at most those admitted work may hold while a new technology waits,
        // whether one waits now or not (a slot is never taken back from a running slice).
        if (job.interrupted && this.runningCarried.size >= this.concurrency - this.newSlots) continue;
        const isNew = this.tier(job) === 1;
        if (capped && !isNew && waitingNew > 0 && this.running.size - this.runningNew.size >= this.concurrency - this.newSlots) continue;
        const outcome = this.launch(job, isNew);
        if (outcome === "held") return started;
        started++;
        if (isNew) waitingNew--;
      }
    return started;
  }
  /** A waiting job's stage, saying what its first pass decided and published when it did. */
  private passed(job: Job, stage: string): string {
    if (!job.advisories_first || !job.admitted) return stage;
    const records = job.records ? `${advisoryRecords(job.records)} published; ` : "";
    return `Admitted for coverage (${job.admitted}); ${records}release history: ${stage[0]!.toLowerCase()}${stage.slice(1)}`;
  }
  /**
   * Whether a package has a firm decision: admitted (by its first pass or a slice), refused or blocked with the reason
   * in its stage, or joined to another technology. A first pass that failed for another reason than a rate limit counts
   * as decided too: its turn in the queue reports the error, and waiting for it would hold a cycle's publish forever.
   */
  decided(purl: string): boolean {
    const job = this.jobs.get(purl);
    if (!job || job.merged_into) return true;
    if (this.passing.has(purl)) return false;
    if (job.state === "queued") return !!job.admitted || !!job.advisories_first;
    return job.state !== "discovering";
  }
  /** Starts one job unless the budget refuses it ("held": nothing more may start). */
  private launch(job: Job, isNew: boolean): "started" | "held" {
    if (this.budget.tokensLeft() <= 0) {
      const stage = this.passed(job, `Coverage budget for this ${this.limits.period} spent; continues after ${day(nextPeriod(this.limits.period))}`);
      if (job.state === "queued" && job.stage !== stage) this.save(job, "queued", stage);
      this.heldBack("tokens");
      return "held";
    }
    const refused = this.budget.takeRun();
    if (refused) {
      const stage = this.passed(job, `Daily coverage budget reached; continues after ${day(Date.now() + refused.retryAfter * 1000)}`);
      if (job.state === "queued" && job.stage !== stage) this.save(job, "queued", stage);
      this.heldBack(refused.kind === "runs" ? "runs_per_day" : "unreadable");
      return "held";
    }
    // A monitored technology's refresh that fails keeps its published coverage: it stays `monitoring`, retried with the
    // same backoff, the failure in its stage. `failed` is for a technology whose coverage could not be built; a
    // transient refusal (a registry's 429) during a refresh no longer flips monitored technologies to failed and back.
    // A resumed refresh is still a refresh.
    const refresh = job.state === "monitoring" || !!job.interrupted?.refresh;
    this.running.add(job.purl);
    this.lineStarts[isNew ? "new" : "admitted"]++;
    if (isNew) this.runningNew.add(job.purl);
    if (job.interrupted) this.runningCarried.add(job.purl);
    this.slices.set(job.purl, { at: Date.now(), refresh, first: isNew });
    this.launched++;
    const kind = this.tally[isNew ? "new" : refresh ? "refresh" : "other"];
    kind.started++;
    delete job.paused_until;
    // Every model call of the slice is the technology's first coverage or its monitoring (util.ts, usage phases); the
    // context goes with the slice's own call chain, so slices running at once never take each other's calls.
    // A refresh that yields (three notes a slice, or the budget) leaves the job queued, so its next slice is no
    // refresh; it is still monitoring, and its end is no second first coverage. A job saved by code before `monitored`
    // existed is marked by its first refresh.
    if (refresh && !job.merged_into) job.monitored ??= now();
    const monitored = refresh || !!job.monitored;
    void withUsagePhase(monitored ? "monitoring" : "onboarding", job.technology, () => this.work(job))
      .then(() => {
        kind[job.state === "queued" ? "yielded" : job.state === "failed" ? "failed" : "finished"]++;
        // First coverage done: counted, so onboarding's cost divides by the technologies it covered.
        if (!monitored && job.state === "monitoring" && !job.merged_into) logUsage({ phase: "onboarding", tech: job.technology, milestone: "onboarded" });
        if (Date.now() >= this.pausedUntil) this.pauseMs = 0;
      })
      .catch((error) => {
        const why = String(error instanceof Error ? error.message : error).slice(0, 300);
        // A rate limit is the runner's request rate, not the package: no failure counted, and the job is retried once
        // the pause that holds every start ends (in this cycle, or the next).
        const limited = rateLimit(error);
        kind[limited ? "rate_limited" : "failed"]++;
        if (limited) {
          const until = this.ratePause(limited.retryAfterMs);
          job.paused_until = new Date(until).toISOString();
          const retry = `retried after ${clock(until)} UTC`;
          if (refresh) this.save(job, "monitoring", `${job.records} verified records; refresh rate-limited (${why}), ${retry}`);
          else this.save(job, "queued", `Rate-limited (${why}); ${retry}`);
          return;
        }
        job.failures = (job.failures ?? 0) + 1;
        job.retry_at = new Date(
          Date.now() +
            Math.min(6 * 3600000, 60000 * 2 ** Math.min(job.failures - 1, 8)),
        ).toISOString();
        sliceFailed(job, isNew, refresh, failureClass(error));
        if (refresh) this.save(job, "monitoring", `${job.records} verified records; refresh failed (${why}), retried after ${clock(Date.parse(job.retry_at))} UTC`);
        else this.save(job, "failed", why);
      })
      .finally(() => {
        this.running.delete(job.purl);
        this.runningNew.delete(job.purl);
        this.runningCarried.delete(job.purl);
        this.slices.delete(job.purl);
        // The slice settled (finished, yielded or failed): it is no longer an interrupted one.
        if (job.interrupted) {
          delete job.interrupted;
          this.persist(job);
        }
        this.pump();
      });
    return "started";
  }
  /** Back of its tier: a job that yields goes behind jobs of equal demand. */
  private requeue(job: Job, stage: string) {
    this.save(job, "queued", stage);
    this.jobs.delete(job.purl);
    this.jobs.set(job.purl, job);
  }
  /** Another admitted package of the same repository whose recent release tags are this one's: one technology. */
  private streamHost(job: Job, repo: string): Job | undefined {
    for (const other of this.jobs.values())
      if (
        other !== job &&
        !other.merged_into &&
        other.admitted &&
        other.descriptor?.repo?.toLowerCase() === repo.toLowerCase() &&
        sameStream(job.stream, other.stream)
      )
        return other;
    return undefined;
  }
  private merge(job: Job, host: Job, why: string) {
    host.siblings = [...new Set([...(host.siblings ?? []), job.purl])];
    if (host.descriptor) host.descriptor.components = [...new Set([...host.descriptor.components, job.purl])];
    host.demand = (host.demand ?? 0) + (job.demand ?? 0);
    this.save(host);
    job.merged_into = host.purl;
    job.technology = host.technology;
    job.name = host.name;
    delete job.descriptor;
    delete job.retry_at;
    delete job.stream;
    this.save(job, "monitoring", `Covered as part of ${host.name}: ${why}`);
  }
  /**
   * Discovery and admission, before any release or docs read: the public identity and official sources, then the
   * admission rules (a deprecated package's notice published, type stubs joined to their package, a refused package
   * parked). Undefined when the job settled here (blocked, parked or merged). `quiet`: no intermediate state saved (the
   * token-free first pass leaves a job queued).
   */
  private async identify(job: Job, refresh: boolean, quiet = false): Promise<PublicTechnology | undefined> {
    if (!quiet)
      this.save(
        job,
        "discovering",
        "Verifying public registry identity and official sources",
      );
    let t: PublicTechnology;
    try {
      t =
        !refresh && job.descriptor?.discovery_version === DISCOVERY_VERSION
          ? job.descriptor
          : await discoverTechnology(job.purl);
    } catch (e) {
      // Not in its public registry (unpublished, or never published): parked and checked again in a week, not
      // retried as a failure every few hours.
      if (e instanceof FetchFailure && (e.httpStatus === 404 || e.httpStatus === 410)) {
        job.retry_at = new Date(Date.now() + 7 * 86_400_000).toISOString();
        this.save(job, "blocked", "Not found in its public registry (unpublished or never published); no coverage claimed");
        return;
      }
      throw e;
    }
    if (job.siblings?.length) t.components = [...new Set([...t.components, ...job.siblings])];
    job.descriptor = t;
    job.name = t.name;
    job.technology = t.id;
    if (!t.repo && !t.homepage) {
      delete job.retry_at;
      this.save(
        job,
        "blocked",
        "No verifiable official sources in registry metadata; no coverage claimed",
      );
      return;
    }
    if (job.admitted) {
      // Admission is decided once, but a repository can be archived later: its lifecycle is read again weekly.
      if (!job.lifecycle_checked || (job.lifecycle_rules ?? 0) < LIFECYCLE_RULES || Date.now() - Date.parse(job.lifecycle_checked) >= LIFECYCLE_MS) {
        setArchived(job, (await this.admission(job.purl, t.repo)).archived);
        job.lifecycle_checked = now();
        job.lifecycle_rules = LIFECYCLE_RULES;
      }
    } else {
      // Signals that cannot be read admit the package (admission.ts); a refusal parks it and checks again in a week.
      const verdict = await this.admission(job.purl, t.repo);
      setArchived(job, verdict.archived);
      job.lifecycle_checked = now();
      job.lifecycle_rules = LIFECYCLE_RULES;
      // A deprecated package is parked, but the deprecation is published first: a change the user's agent needs.
      const deprecated = deprecationOf(verdict);
      if (deprecated !== undefined && !job.deprecation_notice) {
        await publishDeprecation(pipelineTechnology(t), t, deprecated);
        job.deprecation_notice = now();
      }
      // Type stubs join the technology of the package they type when it is covered; otherwise they are parked.
      const typed = verdict.admit ? undefined : (verdict as { typesFor?: string }).typesFor;
      const host = typed ? this.jobs.get(typedPurl(job.purl, typed)) : undefined;
      if (host?.admitted && !host.merged_into && host !== job) {
        this.merge(job, host, "type stubs for it");
        return;
      }
      if (!verdict.admit) {
        job.retry_at = new Date(Date.now() + 7 * 86_400_000).toISOString();
        this.save(job, "blocked", `Not admitted for monitoring: ${verdict.why}`);
        return;
      }
      job.admitted = verdict.why;
    }
    return t;
  }
  /**
   * The token-free first pass of a new technology, ahead of its turn in the queue: discovery and admission, the release
   * list, then the advisories stage with every release's notes unread, so each advisory fixed in the window is published
   * at once as a record of its own (no model call: nothing is judged before the notes are read; advisories.ts step 6).
   * When the history is read later, the advisories stage judges each against the notes and merges it into the record
   * that describes it. The job stays queued in its place (`advisories_first`), and later slices run as before.
   */
  private async advisoryPass(job: Job): Promise<void> {
    const t = await this.identify(job, false, true);
    if (!t) return;
    const tech = pipelineTechnology(t);
    const releases = t.repo ? await fetchReleases(tech) : undefined;
    if (releases) {
      job.stream = releases.notes.map((n) => n.tag).slice(0, STREAM_TAGS);
      if (!job.completed?.length && !job.records) {
        const host = this.streamHost(job, t.repo!);
        if (host) {
          this.merge(job, host, "same repository and release stream");
          return;
        }
      }
    }
    const notes = releases?.notes ?? [];
    const index = await advisoryReleases(tech, notes);
    let made = 0;
    let checked = false;
    if (index.length)
      await withTechLock(tech.id, "onboarding", async () => {
        const store = loadStore(tech.id);
        // No release's notes are read yet (a first pass precedes every slice), whatever the store holds: nothing is
        // judged, so no model call is possible.
        const unread = new Set(index.map((n) => n.version));
        const r = await advisoryStage(tech, store, index, noModel, { unread, apis: false });
        if (!r) return;
        checked = true;
        saveStore(store);
        made = Object.values(store.records).filter((x) => x.status === "active").length;
        if (made) publishTechnology(store, releases?.checked ?? now(), catalogDir());
      });
    job.records = Math.max(job.records, made);
    // The admission decision leads the stage: a client reads a firm "will be covered" at the first publish after the
    // pull, as a refused package reads why it is not.
    const decided = `Admitted for coverage (${job.admitted ?? "admitted"}); `;
    this.save(
      job,
      "queued",
      decided +
        (made
          ? `${advisoryRecords(made)} published; release history waits for a coverage worker`
          : checked
            ? "security advisories checked (none fixed in the last year); release history waits for a coverage worker"
            : "release history waits for a coverage worker"),
    );
  }
  /** Starts token-free first passes for waiting new technologies, in queue order, at most `advisoriesFirst` at once. */
  private pumpAdvisories(): number {
    if (!this.advisoriesFirst || this.held || (this.draining && (this.endedEarly || Date.now() >= this.draining)) || Date.now() < this.pausedUntil) return 0;
    let started = 0;
    for (const job of this.queue()) {
      if (this.passing.size >= this.advisoriesFirst) break;
      if (!this.firstPassDue(job)) continue;
      this.passing.add(job.purl);
      started++;
      // Marked from the start, so the admission it may record never moves the job to admitted work (`tier`).
      job.advisories_first = now();
      void withUsagePhase("onboarding", job.technology, () => this.advisoryPass(job))
        .catch((error) => {
          const limited = rateLimit(error);
          if (limited) {
            // The runner's request rate, not the package: tried again after the pause, as if never passed.
            this.ratePause(limited.retryAfterMs);
            delete job.advisories_first;
            delete job.admitted;
            return;
          }
          // Not a failure of the job: its turn in the queue runs the same steps and reports any error there.
          console.error(`advisories first: ${logName(job)}: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`);
          // The admission it reached is still a firm decision: said, as a finished pass says it.
          if (job.admitted && job.state === "queued") this.save(job, "queued", `Admitted for coverage (${job.admitted}); release history waits for a coverage worker`);
          else this.persist(job);
        })
        .finally(() => {
          this.passing.delete(job.purl);
          this.pumpAdvisories();
        });
    }
    return started;
  }
  /** A waiting new technology no slice and no first pass has touched. */
  private firstPassDue(job: Job): boolean {
    return (
      job.state === "queued" &&
      !job.admitted &&
      !job.advisories_first &&
      !job.completed?.length &&
      !this.running.has(job.purl) &&
      !this.passing.has(job.purl) &&
      this.due(job)
    );
  }
  private async work(job: Job) {
    const refresh = job.state === "monitoring";
    const timings: Record<string, number> = {};
    let at = Date.now();
    const stage = (name: string) => { timings[name] = Date.now() - at; at = Date.now(); };
    const t = await this.identify(job, refresh);
    stage("identity_ms");
    if (!t) return;
    job.registry_version = t.latest;
    // The first pass's place in the line is over: from here the job is worked as any admitted one.
    delete job.advisories_first;
    const tech = pipelineTechnology(t);
    this.save(job, "analyzing", "Reading official release history");
    const releases = t.repo
      ? await fetchReleases(tech, job.change_detected ? { refresh: true } : {})
      : { notes: [], checked: now(), stats: { requests: 0, newReleases: 0 } };
    stage("releases_ms");
    if (t.repo) job.release_checked = releases.checked;
    this.persist(job);
    // The technology unit: before any extraction, a package whose recent release tags are another admitted package's
    // (same repository) joins that technology instead of extracting the same notes again.
    job.stream = releases.notes.map((n) => n.tag).slice(0, STREAM_TAGS);
    if (t.repo && !job.completed?.length && !job.records) {
      const host = this.streamHost(job, t.repo);
      if (host) {
        this.merge(job, host, "same repository and release stream");
        return;
      }
    }
    await withTechLock(tech.id, "onboarding", () => {
      const corrected = reconcileSources(tech) + reconcileLinkedEvidence(tech, releases.notes);
      if (corrected)
        publishTechnology(loadStore(tech.id), releases.checked, catalogDir());
    });
    const notes = [...releases.notes].reverse();
    job.releases_total = notes.length;
    job.completed = (job.completed ?? []).filter((k) =>
      k.endsWith(":audience-v1"),
    );
    job.releases_done = job.completed.length;
    let batch = 0;
    const docsDue =
      !job.docs_checked ||
      Date.parse(job.docs_checked) < Date.now() - DOCS_PASS.freshMs;
    const doDocs =
      docsDue &&
      (job.next_task === "docs" || job.releases_done === notes.length);
    const quarter = quarterKey();
    if (job.quarter?.key !== quarter) job.quarter = { key: quarter, tokens: 0 };
    const cap = this.limits.techQuarterTokens;
    if (!doDocs)
      for (const note of notes) {
        const key = `${note.tag}:${note.snapshot}:audience-v1`;
        if (job.completed.includes(key)) continue;
        const cost = noteTokens(note.notes);
        // Past its quarterly cap a technology's remaining notes wait behind every other technology (tier 2), so one
        // verbose changelog cannot take the period's budget; the first note of a quarter always passes.
        if (job.overflow !== quarter && cap > 0 && job.quarter.tokens > 0 && job.quarter.tokens + cost > cap) {
          job.overflow = quarter;
          break;
        }
        const refused = this.budget.spend(cost);
        if (refused) {
          this.heldBack("tokens");
          this.requeue(job, `${job.records} records so far; coverage budget for this ${this.limits.period} spent; continues after ${day(Date.now() + refused.retryAfter * 1000)}`);
          return;
        }
        job.quarter.tokens += cost;
        this.save(
          job,
          job.records ? "partial" : "analyzing",
          `Analyzing official release ${note.version} (${job.completed.length}/${notes.length})`,
        );
        job.records = await synthesize(tech, note);
        job.completed.push(key);
        job.releases_done = job.completed.length;
        this.save(
          job,
          "partial",
          `${job.records} source-backed records so far; continuing history`,
        );
        if (++batch >= 3 && (job.completed.length < notes.length || docsDue)) {
          job.next_task = "docs";
          this.save(
            job,
            "queued",
            `${job.records} records so far; more history queued`,
          );
          this.jobs.delete(job.purl);
          this.jobs.set(job.purl, job);
          return;
        }
      }
    stage("extraction_ms");
    // The advisories stage (OSV, resolved against the release index, attached to the records of their fix), like any
    // other stage: a new technology gets advisories with no manual step. Fails open (advisories.ts). Notes not read yet
    // are named, so an advisory fixed only there is not judged before they are; a technology with no release notes
    // resolves against its registry's versions.
    const index = this.advisories ? await advisoryReleases(tech, releases.notes) : [];
    await withTechLock(tech.id, "onboarding", async () => {
      const store = loadStore(tech.id);
      // Records read only from another technology's upgrade guide (ingested before `ownGuide`) leave the catalog.
      const foreign = retractForeignGuideRecords(store, foreignGuides(tech));
      if (foreign.length) {
        console.error(`coverage: ${logName(job)}: ${foreign.length} records read only from another technology's upgrade guide retracted`);
        saveStore(store);
      }
      // Records cut from one release-note item (one per API it names, same quote, summary and labels) become one.
      const split = mergeSplitRecords(store);
      // The same change in two parts of one release body, ingested before retrieval compared them: judged once each.
      const judged = await mergeChunkDuplicates(store, tech.name, (st, q) => advisoryClassifier().classify(st, q));
      const chunks = judged.filter((j) => j.outcome === "same").length;
      if (split.length || chunks) console.error(`coverage: ${logName(job)}: ${split.length} records cut from the same release-note item and ${chunks} from another part of the same release notes merged`);
      if (split.length || judged.length) saveStore(store);
      // Merged records are stubs now: the job counts active ones.
      if (split.length || chunks) job.records = Object.values(store.records).filter((r) => r.status === "active").length;
      // Deprecations the technology's type stubs state in their declarations (registry and tarball reads, no model).
      const typed = await typeStubDeprecations(tech, store);
      if (typed.length) {
        job.records = Object.values(store.records).filter((r) => r.status === "active").length;
        console.error(`coverage: ${logName(job)}: ${typed.length} deprecations from its type stubs' declarations`);
        saveStore(store);
      }
      if (index.length) {
        this.save(job, "partial", "Checking security advisories");
        const read = new Set(job.completed ?? []);
        const unread = new Set(releases.notes.filter((n) => !read.has(`${n.tag}:${n.snapshot}:audience-v1`)).map((n) => n.version));
        const r = await advisoryStage(tech, store, index, (st, q) =>
          advisoryClassifier().classify(st, q),
        { unread });
        if (r) saveStore(store);
      }
      publishTechnology(store, releases.checked, catalogDir());
    });
    stage("advisories_ms");
    // The docs module: the daily pass over the technology's official docs, then extraction of the changes that name
    // their version. A first pass is a baseline: nothing is extracted from it. The crawl makes no model call; each
    // planned docs note is charged its measured volume before extraction, like a release note, and counts toward the
    // technology's quarterly tokens.
    this.save(job, "partial", "Checking the official documentation");
    let saved = 0;
    const pass = await dailyPass(tech, {
      http: docsHttp,
      progress: (done, total) => {
        job.docs_done = done;
        job.docs_total = total;
        if (done - saved >= 25 || done === total) {
          saved = done;
          this.save(job, "partial", `Monitoring official docs: ${done}/${total} pages`);
        }
      },
    });
    if (pass) {
      const listed = pass.sites.reduce((n, x) => n + x.pages, 0);
      job.docs_total = pass.checked;
      job.docs_done = pass.checked;
      job.docs_failed = Object.entries(pass.outcomes).filter(([k]) => k.startsWith("failed")).reduce((n, [, v]) => n + v, 0);
      // Every site passed here had pages when resolved, so a site whose listing named none is a failed listing, not
      // a complete one: "failed" when no page is known at all, else "partial".
      const unlisted = pass.sites.filter((x) => x.listingFailed).length;
      job.enumeration = !pass.sites.length ? "unavailable" : !listed ? "failed" : unlisted || pass.checked < listed ? "partial" : "complete";
    }
    // Not due: another worker (the pipeline, for a catalog technology) checked them less than a day ago.
    job.docs_checked = lastPass(tech.id) ?? now();
    let docsRefused: Refusal | undefined;
    const extracted = await extract(tech, DOCS_PASS.notes, undefined, (text) => {
      const cost = noteTokens(text);
      docsRefused = this.budget.spend(cost);
      if (docsRefused) return false;
      job.quarter!.tokens += cost;
      return true;
    });
    if (extracted.records !== undefined) job.records = extracted.records;
    stage("docs_ms");
    // Upgrade guides (the current and previous major's, as the docs pass found them): with release notes they carry
    // the history; a removal stated only in a migration guide (MUI v9) is in no release body. Charged like a note.
    if (!docsRefused) {
      let guides: GuideNote[] = [];
      try {
        guides = await fetchGuides(tech, releases.notes, { http: docsHttp, checked: true });
      } catch (e) {
        console.error(`coverage: ${logName(job)}: upgrade guides unreadable (${e instanceof Error ? e.message : e}); release notes and docs only`);
      }
      for (const g of guides) {
        const key = `${g.keyTag}:audience-v1`;
        if (job.guides_done?.includes(key)) continue;
        const cost = noteTokens(g.notes);
        docsRefused = this.budget.spend(cost);
        if (docsRefused) break;
        job.quarter.tokens += cost;
        this.save(job, "partial", `Analyzing the upgrade guide for ${g.version.split(".")[0]}.x`);
        job.records = await synthesize(tech, g);
        job.guides_done = [...(job.guides_done ?? []), key];
      }
    }
    if (docsRefused) {
      this.heldBack("tokens");
      this.requeue(job, `${job.records} records so far; coverage budget for this ${this.limits.period} spent; continues after ${day(Date.now() + docsRefused.retryAfter * 1000)}`);
      return;
    }
    if (job.releases_done < job.releases_total) {
      job.next_task = "history";
      this.requeue(
        job,
        job.overflow === quarter
          ? `${job.records} records so far; ${job.releases_done}/${job.releases_total} releases; this technology's release-note budget for ${quarter} is used (${job.quarter.tokens} of ${cap} tokens), the rest waits behind other technologies by demand`
          : `${job.records} records so far; ${job.releases_done}/${job.releases_total} releases, ${job.docs_done}/${job.docs_total} docs; continuing centrally`,
      );
      return;
    }
    stage("guides_ms");
    console.error(JSON.stringify({ event: "coverage_stages", technology: tech.id, refresh: refresh || !!job.monitored,
      ...timings, release_requests: releases.stats.requests, new_releases: releases.stats.newReleases,
      detection_to_refresh_s: job.change_detected ? Math.round((Date.now() - Date.parse(job.change_detected)) / 1000) : null }));
    job.next_task = "history";
    job.retry_at = new Date(Date.now() + 6 * 3600000).toISOString();
    job.failures = 0;
    await withTechLock(tech.id, "onboarding", () =>
      publishTechnology(loadStore(tech.id), now(), catalogDir()),
    );
    job.refresh_completed = now();
    delete job.change_detected;
    this.save(job, "monitoring", monitoringStage(job));
  }
}
/** A monitored job's stage. One whose official sources yielded no release or no record says so first: it is a source
 * gap (the client reports it as one), not coverage that found nothing to report. */
export function monitoringStage(j: Pick<Job, "records" | "releases_total" | "enumeration" | "docs_done" | "docs_total" | "docs_failed">): string {
  const gap = !j.releases_total
    ? "source gap: no release notes found in its official sources (GitHub releases or changelog); "
    : !j.records
      ? `source gap: no records extracted from ${j.releases_total} release ${j.releases_total === 1 ? "note" : "notes"}; `
      : "";
  return `${gap}${j.records} verified records; ${docsCoverage(j)}`;
}
/** The documentation part of a job's coverage line. "Monitored" only when pages were listed and every one checked: a
 * docs site whose listing failed (`failed`; `empty` in older jobs) is not monitored, and its records come from release
 * notes alone. */
export function docsCoverage(j: Pick<Job, "enumeration" | "docs_done" | "docs_total" | "docs_failed">): string {
  if (j.enumeration === "failed" || j.enumeration === "empty") return "documentation not monitored: a docs site was found but listed no pages";
  const label = j.enumeration === "complete" && !j.docs_failed && j.docs_total > 0 ? "monitored" : j.enumeration === "unavailable" ? "not found" : "coverage partial";
  return `documentation ${label} (${j.docs_done - j.docs_failed}/${j.docs_total} pages)`;
}
/** A job's name in the run logs, which are public: a package clients asked for is named only once admitted (a public
 * technology); before, a hash prefix of its purl (that of its job and coverage files) stands for it. */
export function logName(j: Pick<Job, "purl" | "admitted">): string {
  return j.admitted ? j.purl : `requested package ${sha256(j.purl).slice(0, 12)}`;
}
/** How often an admitted package's repositories are checked for an archive (a parked one is at each admission check). */
const LIFECYCLE_MS = 7 * 86_400_000;
/** The lifecycle rules' version: 1, archived repositories listed (`archived`); 2, an end of development the README
 * announces said in a parked package's reason (admission.ts `withLifecycle`). Raise it when the rules change. */
export const LIFECYCLE_RULES = 2;
function setArchived(job: Job, archived: string[] | undefined) {
  if (archived?.length) job.archived = archived;
  else delete job.archived;
}
function publicJob(j: Job) {
  const {
    completed: _completed,
    guides_done: _guides,
    docs_completed: _docs,
    descriptor: _descriptor,
    next_task: _task,
    admitted: _admitted,
    stream: _stream,
    quarter: _quarter,
    overflow: _overflow,
    siblings: _siblings,
    merged_into: _merged,
    deprecation_notice: _notice,
    lifecycle_checked: _lifecycle,
    lifecycle_rules: _rules,
    advisories_first: _first,
    downloads: _downloads,
    interrupted: _interrupted,
    paused_until: _paused,
    monitored: _monitored,
    release_checked: _release_checked,
    refresh_completed: _refresh_completed,
    registry_polled: _registry_polled,
    registry_version: _registry_version,
    registry_checked: _registry_checked,
    change_detected: _change_detected,
    demand: _demand,
    ...fields
  } = j;
  return fields;
}
export function createCoverageServer(service = new CoverageService()) {
  return createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        send(200, { schema: 1, service: "unstale-coverage" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/coverage") {
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          send(415, { error: "application/json required" });
          return;
        }
        if (req.headers.origin) {
          send(403, { error: "Browser registration is not supported" });
          return;
        }
        let body = "";
        for await (const part of req) {
          body += String(part);
          if (body.length > 512) {
            send(413, { error: "One public identity only" });
            return;
          }
        }
        const { purl } = requestSchema.parse(JSON.parse(body));
        const outcome = service.register(
          purl,
          clientAddress(req, service.limits.trustProxy),
        );
        if ("limit" in outcome) {
          res.setHeader("Retry-After", String(outcome.retryAfter));
          send(429, {
            error: "Too many new technologies from this address; retry later",
            limit: outcome.limit,
            retry_after: outcome.retryAfter,
          });
          return;
        }
        send(202, service.publicStatus(outcome));
        return;
      }
      if (req.method === "GET" && url.pathname === "/coverage") {
        const job = service.status(url.searchParams.get("purl") ?? "");
        send(
          job ? 200 : 404,
          job ? service.publicStatus(job) : { error: "No shared job for this identity" },
        );
        return;
      }
      if (
        req.method === "GET" &&
        /^\/v1\/(root\.json|tech\/[a-z0-9._-]+\.json|shards\/[a-z0-9._-]+\/[a-zA-Z0-9._-]+\.jsonl\.gz)$/.test(
          url.pathname,
        )
      ) {
        const path = join(catalogDir(), url.pathname.slice(1));
        if (!existsSync(path)) {
          send(404, { error: "Catalog not yet available" });
          return;
        }
        let body = readFileSync(path);
        if (url.pathname.startsWith("/v1/tech/")) {
          const id = url.pathname
            .split("/")
            .at(-1)!
            .replace(/\.json$/, "");
          // Shared with the static export (export.ts), so both serve the same index bytes.
          body = servedIndex(body, id, service.jobs.values());
        }
        const etag = `"${sha256(body)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": path.endsWith(".gz")
            ? "application/gzip"
            : "application/json",
          ETag: etag,
        });
        res.end(body);
        return;
      }
      send(404, { error: "Not found" });
    } catch (error) {
      send(400, {
        error:
          error instanceof Error
            ? error.message.slice(0, 200)
            : "Invalid request",
      });
    }
  });
}

type SliceTally = { started: number; finished: number; yielded: number; failed: number; rate_limited: number };
/** A drain's own measurements, on its final line: what parallelism buys (ingest.yml's CONCURRENCY) and costs. */
export interface DrainMetrics {
  slices: Record<"new" | "refresh" | "other", SliceTally>;
  pauses: number;
  /** Coverage-budget tokens this drain spent; null without a cap. */
  tokens: number | null;
  /** The docs crawl's shared pool: requests that queued for a slot and their total wait. */
  docs_pool: { waits: number; waited_ms: number };
  cpu_s: number;
  max_rss_mb: number;
}
function blankTally(): DrainMetrics["slices"] {
  const t = (): SliceTally => ({ started: 0, finished: 0, yielded: 0, failed: 0, rate_limited: 0 });
  return { new: t(), refresh: t(), other: t() };
}
/** A failed or stopped slice on the drain's log, beside its count in `slices`, so the run's log says what failed
 * without the saved state (run 40562343126 counted 46 failed new slices, none explained). The log is public: the job
 * is named by `logName` and the error by its class only; the full reason stays in the job's status. */
function sliceFailed(job: Job, isNew: boolean, refresh: boolean, error: string) {
  console.error(JSON.stringify({ event: "slice_failed", job: logName(job), kind: isNew ? "new" : refresh ? "refresh" : "other", failures: job.failures, error }));
}
/** An error's class from a bounded set (`HTTP 500`, `timeout`, `blocked_url`, an error type's name): never its message,
 * which can carry hosts, redirect targets or addresses. A status in a message is read as `rateLimit` reads 429. */
export function failureClass(error: unknown): string {
  if (error instanceof FetchFailure) return error.httpStatus !== undefined ? `HTTP ${error.httpStatus}` : error.kind;
  // Status 0 is the model call's own: no response at all, either its deadline ("no answer within N ms") or the network.
  if (error instanceof HttpError) return error.status > 0 ? `HTTP ${error.status}` : /^no answer within \d+ ms$/.test(error.message) ? "timeout" : "network";
  if (error instanceof ClassifierError || error instanceof ExtractFailure) return error.kind;
  if (error instanceof LockTimeout) return "lock timeout";
  const message = String(error instanceof Error ? error.message : error);
  const status = /(?:HTTP |: )([1-5]\d\d)\b/.exec(message);
  if (status) return `HTTP ${status[1]}`;
  if (/\btime(?:d out|out)\b/i.test(message) || (error instanceof Error && error.name === "TimeoutError")) return "timeout";
  return error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : "unknown";
}
