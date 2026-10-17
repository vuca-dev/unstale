import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HttpClient, DEFAULT_HTTP, FetchFailure } from "../collector/http.ts";
import { dailyPass, DOCS_PASS, extract, lastPass } from "../docs/extract.ts";
import {
  discoverTechnology,
  DISCOVERY_VERSION,
  releasePattern,
  packageIdentity,
  technologyId,
  pipelineTechnology,
  type PublicTechnology,
} from "./discovery.ts";
import { catalogDir, centralDir } from "../pipeline/paths.ts";
import { fetchReleases } from "../pipeline/fetch.ts";
import { readJson, sha256, writeAtomic } from "../pipeline/util.ts";
import { reconcileSources } from "./source-quality.ts";
import { synthesize } from "./synthesis.ts";
import { publishTechnology } from "../pipeline/publish.ts";
import { JOB_FILE, servedIndex } from "../pipeline/export.ts";
import { loadStore, saveStore } from "../pipeline/store.ts";
import { advisoryStage } from "../pipeline/advisories.ts";
import { withTechLock, withTechLockSync } from "../pipeline/lock.ts";
import { makeClassifier } from "../pipeline/pipeline.ts";
import { admit, signals, THRESHOLDS, weeklyDownloads, type Verdict } from "../pipeline/admission.ts";
import { AddressLimiter, DailyBudget, Voters, clientAddress, limitsFromEnv, nextPeriod, noteTokens, quarterKey, type Limits, type Refusal } from "./limits.ts";
import { deprecationOf, publishDeprecation } from "./notices.ts";
import { npmPurl } from "../pipeline/ecosystems.ts";
let classifier: ReturnType<typeof makeClassifier> | undefined;
const advisoryClassifier = () => (classifier ??= makeClassifier());
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
  /** Legacy: page ids of the old inline docs loop; unused, never public. */
  docs_completed?: string[];
  docs_checked?: string;
  next_task?: "history" | "docs";
  /** Why the package passed admission; checked once, before the first crawl or extraction. */
  admitted?: string;
  /** Distinct requesters (a count only; who asked is never stored). The queue's order: most requested first. */
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
}

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
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The package URL of a package name in the same ecosystem as `purl` (PyPI names PEP 503-normalised). */
export const typedPurl = (purl: string, name: string): string =>
  purl.startsWith("pkg:pypi/") ? `pkg:pypi/${name.toLowerCase().replace(/[-_.]+/g, "-")}` : npmPurl(name);
const requestSchema = z.object({ purl: z.string().max(230) }).strict();
const jobPath = (purl: string) =>
  join(centralDir(), "onboarding", "jobs", `${sha256(purl)}.json`);
const now = () => new Date().toISOString();
// Job timeline: one line per saved state, public identity and counters only, so stage durations (queue wait, per
// release, per docs page) can be measured before any completion estimate is shown. Fails open: a timeline write never
// fails a job.
export const timelinePath = () => join(centralDir(), "onboarding", "timeline.jsonl");
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
  /** Batch mode before `drain`: requests are queued but nothing starts (`hold`). */
  private held = false;
  /** Jobs started since construction (a drain reports its share). */
  private launched = 0;
  /** A drain restricted to these packages (fast-track); undefined works the whole queue. */
  private only: ReadonlySet<string> | undefined;
  readonly concurrency: number;
  /** The advisories stage after a technology's history is published (off: `advisories: false` or UNSTALE_NO_ADVISORIES=1). */
  readonly advisories: boolean;
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
      limits?: Limits;
      admission?: (purl: string, repo: string | undefined) => Promise<Verdict>;
      adoption?: (purls: string[]) => Promise<Map<string, number>>;
    } = {},
  ) {
    this.concurrency = concurrency;
    this.advisories =
      opts.advisories ?? process.env.UNSTALE_NO_ADVISORIES !== "1";
    this.limits = opts.limits ?? limitsFromEnv();
    this.addresses = new AddressLimiter(this.limits.perAddressPerHour);
    this.votes = new AddressLimiter(this.limits.votesPerAddressPerHour);
    this.budget = new DailyBudget(this.limits);
    this.admission =
      opts.admission ??
      (async (purl, repo) =>
        admit(await signals(purl, repo), THRESHOLDS[/^pkg:(\w+)\//.exec(purl)?.[1] ?? ""]));
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
            job.state = "queued";
            job.stage = "Resuming interrupted coverage";
          }
          this.jobs.set(job.purl, job);
        }
      }
  }
  /** Persists counters (a vote) without a timeline line: the timeline records state changes. */
  private persist(job: Job) {
    writeAtomic(jobPath(job.purl), JSON.stringify(job, null, 1));
  }
  private save(job: Job, state = job.state, stage = job.stage) {
    job.state = state;
    job.stage = stage;
    job.updated = now();
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
      (job.state === "queued" ||
        (["failed", "monitoring", "blocked"].includes(job.state) && Date.parse(job.retry_at ?? "") <= Date.now()))
    );
  }
  /** 0: refreshes, retries and continued history of admitted technologies; 1: new; 2: past their quarterly cap. */
  private tier(job: Job): number {
    if (job.overflow === quarterKey()) return 2;
    return job.admitted || job.state === "monitoring" || job.completed?.length ? 0 : 1;
  }
  /** The line of new technologies waiting for their first analysis, in drain order (tier 1). */
  newLine(): Job[] {
    return this.queue().filter((j) => this.tier(j) === 1 && !this.running.has(j.purl));
  }
  /** Of `candidates`, those at the head of the line of new technologies, in order: none when another is ahead. */
  newHead(candidates: ReadonlySet<string>): Set<string> {
    const out = new Set<string>();
    for (const j of this.newLine()) {
      if (!candidates.has(j.purl)) break;
      out.add(j.purl);
    }
    return out;
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
      .sort((a, b) => this.tier(a) - this.tier(b) || (b.demand ?? 0) - (a.demand ?? 0) || adoption(b) - adoption(a));
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
    const waiting = this.queue().filter((j) => !this.running.has(j.purl));
    const at = waiting.indexOf(job);
    const fields = publicJob(job);
    if (at < 0) return fields;
    return { ...fields, stage: `${job.stage} (position ${at + 1} of ${waiting.length})`, queue_position: at + 1, queue_length: waiting.length };
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
   * resumed by the next run (an interrupted job is requeued on load). With `only`, no other job starts.
   */
  async drain(deadline: number, grace = 10 * 60_000, poll = 500, only?: ReadonlySet<string>): Promise<{ started: number; unfinished: number }> {
    this.draining = deadline;
    this.held = false;
    this.only = only;
    const before = this.launched;
    // A finished job starts the next itself; when nothing is running and nothing more starts, the queue is done.
    while (Date.now() < deadline && (this.running.size || this.pump()))
      await new Promise((r) => setTimeout(r, poll));
    const stop = Date.now() + grace;
    while (this.running.size && Date.now() < stop) await new Promise((r) => setTimeout(r, poll));
    return { started: this.launched - before, unfinished: this.running.size };
  }
  /** Every job as `GET /coverage` answers it (the queue order computed once), for a static copy of the answers. */
  statuses(): ReturnType<typeof publicJob>[] {
    const waiting = this.queue().filter((j) => !this.running.has(j.purl));
    const at = new Map(waiting.map((j, i) => [j, i]));
    return [...this.jobs.values()].map((job) => {
      const i = at.get(job);
      const fields = publicJob(job);
      if (i === undefined) return fields;
      return { ...fields, stage: `${job.stage} (position ${i + 1} of ${waiting.length})`, queue_position: i + 1, queue_length: waiting.length };
    });
  }
  /** Starts what the queue and the budget allow; returns how many jobs it started. */
  private pump(): number {
    if (this.held) return 0;
    let started = 0;
    for (const job of this.queue()) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(job.purl) || (this.only && !this.only.has(job.purl))) continue;
      if (this.budget.tokensLeft() <= 0) {
        const stage = `Coverage budget for this ${this.limits.period} spent; continues after ${day(nextPeriod(this.limits.period))}`;
        if (job.state === "queued" && job.stage !== stage) this.save(job, "queued", stage);
        break;
      }
      const isNew = this.tier(job) === 1;
      const refused = this.budget.take(isNew ? ["runs", "new"] : "runs");
      if (refused) {
        const stage =
          refused.kind === "new"
            ? `Daily limit of new technologies reached; continues after ${day(Date.now() + refused.retryAfter * 1000)}`
            : `Daily coverage budget reached; continues after ${day(Date.now() + refused.retryAfter * 1000)}`;
        if (job.state === "queued" && job.stage !== stage) this.save(job, "queued", stage);
        // Only new technologies are capped by count: admitted work and overflow may still run today.
        if (refused.kind === "new") continue;
        break;
      }
      this.running.add(job.purl);
      started++;
      this.launched++;
      void this.work(job)
        .catch((error) => {
          job.failures = (job.failures ?? 0) + 1;
          job.retry_at = new Date(
            Date.now() +
              Math.min(6 * 3600000, 60000 * 2 ** Math.min(job.failures - 1, 8)),
          ).toISOString();
          this.save(
            job,
            "failed",
            String(error instanceof Error ? error.message : error).slice(
              0,
              300,
            ),
          );
        })
        .finally(() => {
          this.running.delete(job.purl);
          if (!this.draining || Date.now() < this.draining) this.pump();
        });
    }
    return started;
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
  private async work(job: Job) {
    const refresh = job.state === "monitoring";
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
    if (!job.admitted) {
      // Signals that cannot be read admit the package (admission.ts); a refusal parks it and checks again in a week.
      const verdict = await this.admission(job.purl, t.repo);
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
    const tech = pipelineTechnology(t);
    this.save(job, "analyzing", "Reading official release history");
    const releases = t.repo
      ? await fetchReleases(tech)
      : { notes: [], checked: now(), stats: { requests: 0, newReleases: 0 } };
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
      if (reconcileSources(tech))
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
          this.requeue(job, `${job.records} records available; coverage budget for this ${this.limits.period} spent; continues after ${day(Date.now() + refused.retryAfter * 1000)}`);
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
          `${job.records} source-backed records published; continuing history`,
        );
        if (++batch >= 3 && (job.completed.length < notes.length || docsDue)) {
          job.next_task = "docs";
          this.save(
            job,
            "queued",
            `${job.records} records available; more history queued`,
          );
          this.jobs.delete(job.purl);
          this.jobs.set(job.purl, job);
          return;
        }
      }
    await withTechLock(tech.id, "onboarding", async () => {
      const store = loadStore(tech.id);
      // The advisories stage (OSV, resolved against the release index, attached to the records of their fix),
      // like any other stage: a new technology gets advisories with no manual step. Fails open (advisories.ts).
      if (this.advisories && t.repo && releases.notes.length) {
        this.save(job, "partial", "Checking security advisories");
        const r = await advisoryStage(tech, store, releases.notes, (st, q) =>
          advisoryClassifier().classify(st, q),
        );
        if (r) saveStore(store);
      }
      publishTechnology(store, releases.checked, catalogDir());
    });
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
      job.enumeration = !pass.sites.length ? "unavailable" : pass.checked < listed ? "partial" : "complete";
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
    if (docsRefused) {
      this.requeue(job, `${job.records} records available; coverage budget for this ${this.limits.period} spent; continues after ${day(Date.now() + docsRefused.retryAfter * 1000)}`);
      return;
    }
    if (job.releases_done < job.releases_total) {
      job.next_task = "history";
      this.requeue(
        job,
        job.overflow === quarter
          ? `${job.records} records available; ${job.releases_done}/${job.releases_total} releases; this technology's release-note budget for ${quarter} is used (${job.quarter.tokens} of ${cap} tokens), the rest waits behind other technologies by demand`
          : `${job.records} records available; ${job.releases_done}/${job.releases_total} releases, ${job.docs_done}/${job.docs_total} docs; continuing centrally`,
      );
      return;
    }
    job.next_task = "history";
    job.retry_at = new Date(Date.now() + 6 * 3600000).toISOString();
    job.failures = 0;
    await withTechLock(tech.id, "onboarding", () =>
      publishTechnology(loadStore(tech.id), now(), catalogDir()),
    );
    this.save(
      job,
      "monitoring",
      `${job.records} verified records; documentation ${job.enumeration === "complete" && !job.docs_failed ? "monitored" : job.enumeration === "unavailable" ? "not found" : "coverage partial"} (${job.docs_done - job.docs_failed}/${job.docs_total} pages)`,
    );
  }
}
function publicJob(j: Job) {
  const {
    completed: _completed,
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
    downloads: _downloads,
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
