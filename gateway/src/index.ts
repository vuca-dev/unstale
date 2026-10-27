// The public face of unstale's catalog and coverage service on Cloudflare. Static files are the exported catalog
// (`v1/`, written by central's `catalog export`) and are served without running this code, except those packed into
// bucket files to keep the deployed file count under the plan's limit (pack.ts), which it reads out of their bucket
// and answers byte for byte as the static file (assets.ts). It also answers what a static host cannot, with the same
// wire format as central's coverage service (onboarding/service.ts), so the client needs no change:
//   GET /health                 the coverage service marker the client checks
//   POST /coverage {purl}       a vote on a known package, or a new package queued for the next coverage run
//   GET /coverage?purl=         a known package's published status, or a held one's place in the queue
//   POST /coverage/status       {purls}: what GET /coverage answers, for up to BATCH packages in one request
//   POST /coverage/register     {purls}: what POST /coverage answers, for up to BATCH packages in one request, in order
//                               (`{results: [{purl, status, job}` or `{purl, status, error, ...}]}`; a client falls back
//                               to one request per package where a service answers neither. The Worker's free
//                               allowance is counted in requests, so one request for many packages is the saving)
//   GET /internal/queue         the held requests, for a coverage run (bearer DRAIN_TOKEN)
//   POST /internal/ack          what a deployed run took (bearer DRAIN_TOKEN)
//   GET /internal/usage         the object's rows read and written today against the free tier (bearer DRAIN_TOKEN);
//                               also in the answers to /internal/queue and /internal/ack, which a run prints
//   POST /internal/progress     where a run is with the held packages it pulled (bearer DRAIN_TOKEN), so a client
//                               that started one early can follow it until the package is published (each job with
//                               central's save time, `updated`, which orders the reports, and `publish_by`, when the
//                               run's cycle publishes: a held package's records are `records_pending` until then,
//                               never `records`, which counts only what the catalog has); with
//                               `budget.spent_until`, until when central's budget is spent (no early run until then);
//                               a package the run took and has not started is `waiting`, with its place in the run's
//                               queue and `starts_at`, when the run is estimated to reach it, the one place a client
//                               is shown;
//                               with `pulls.next`, when the run reads the queue again (no early run while it does;
//                               null: it is done, and an early run held back meanwhile starts)
// Only the public identity of a package is accepted; no repository context, and no client address is stored.
import type { Traffic } from "./demand.ts";
import { DurableObject } from "cloudflare:workers";
import { asset, packedAsset } from "./assets.ts";
import { packageIdentity, technologyId } from "../../central/src/onboarding/identity.ts";
import { BATCH, PendingQueue, RUN_STATES, settingsFrom, type Outcome, type Progress, type Request as Taken, type RunState, type View } from "./queue.ts";

export interface Env {
  ASSETS: Fetcher;
  COVERAGE: DurableObjectNamespace<Coverage>;
  DRAIN_TOKEN?: string;
  /** A fine-grained token with Actions: write on this repository only; without it nothing is fast-tracked. */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  /** The GitHub API base (a local stand-in for a preview); api.github.com otherwise. */
  GITHUB_API_URL?: string;
  RATE_PER_HOUR?: string;
  VOTES_PER_HOUR?: string;
  MAX_PENDING?: string;
  NEW_PER_HOUR?: string;
  COUNTED_VOTES_PER_HOUR?: string;
  FAST_TRACK_PER_DAY?: string;
  FAST_TRACK_INTERVAL_MINUTES?: string;
}

/** The single queue: one object, so limits and order are global. */
export class Coverage extends DurableObject<Env> {
  private readonly queue: PendingQueue;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const settings = settingsFrom(env as unknown as Record<string, string | undefined>);
    // Without a way to start a run, no package is told one is starting.
    if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPOSITORY) settings.fastTrackPerDay = 0;
    this.queue = new PendingQueue(ctx.storage.sql, settings, {
      transaction: (f) => ctx.storage.transactionSync(f),
      timer: (f, ms) => void setTimeout(f, ms),
    });
  }
  /** A request and, when the package is queued, what its client is shown: one call to the object, not two (the free
   * tier counts requests to the object too). */
  request(purl: string, address: string, known: boolean, traffic: Traffic = "unmarked"): { outcome: Outcome; view?: View } {
    const outcome = this.queue.request(purl, address, known, Date.now(), traffic);
    if (outcome.type === "queued" && outcome.fastTrack)
      this.ctx.waitUntil(
        dispatch(this.env)
          .catch(() => false)
          .then((started) => started || this.queue.undispatched(purl)),
      );
    return { outcome, view: outcome.type === "queued" ? this.queue.view(purl) : undefined };
  }
  registrationFailure(unavailable: boolean, traffic: Traffic): void {
    this.queue.recordDemand(unavailable ? "registry_unavailable" : "package_not_found", traffic);
  }
  held(purl: string): boolean {
    return this.queue.held(purl);
  }
  /** `request` for several packages in order, in one call to the object. */
  requestMany(items: { purl: string; known: boolean }[], address: string, traffic: Traffic = "unmarked", failures: { notFound: number; unavailable: number } = { notFound: 0, unavailable: 0 }): { outcome: Outcome; view?: View }[] {
    if (failures.notFound) this.queue.recordDemand("package_not_found", traffic, Date.now(), failures.notFound);
    if (failures.unavailable) this.queue.recordDemand("registry_unavailable", traffic, Date.now(), failures.unavailable);
    return items.map(({ purl, known }) => this.request(purl, address, known, traffic));
  }
  /** Which of these packages are held, in one call to the object. */
  heldMany(purls: string[]): string[] {
    return purls.filter((purl) => this.queue.held(purl));
  }
  /** A held new package's place in the queue and the run working it, if any. */
  view(purl: string): View | undefined {
    return this.queue.view(purl);
  }
  /** `view` for several packages, in one call to the object: the held ones only. */
  views(purls: string[]): Record<string, View> {
    const out: Record<string, View> = {};
    for (const purl of purls) {
      const at = this.queue.view(purl);
      if (at) out[purl] = at;
    }
    return out;
  }
  /** A run's progress; `budget` (when the report carries it) replaces what the gateway knows of central's budget, and
   * `pulls` what it knows of the run's pulls. A run done pulling starts the early run held back meanwhile, if any. */
  report(updates: { purl: string; state: RunState; job?: Progress }[], budget?: { spentUntil?: number }, pulls?: { next?: number }): { reported: number; dispatched?: boolean } {
    if (budget) this.queue.setBudget(budget.spentUntil);
    const started = pulls ? this.queue.setPulls(pulls.next) : [];
    if (started.length)
      this.ctx.waitUntil(
        dispatch(this.env)
          .catch(() => false)
          .then((ok) => ok || started.forEach((purl) => this.queue.undispatched(purl))),
      );
    return { reported: this.queue.report(updates), ...(pulls ? { dispatched: started.length > 0 } : {}) };
  }
  list(): Taken[] {
    return this.queue.list();
  }
  ack(taken: Taken[]): number {
    return this.queue.ack(taken);
  }
  demand(): ReturnType<PendingQueue["demandReport"]> {
    return this.queue.demandReport();
  }
  usage(): ReturnType<PendingQueue["usageToday"]> {
    return this.queue.usageToday();
  }
}

/** Starts the coverage workflow early; a failure only means the package waits for the schedule. */
async function dispatch(env: Env): Promise<boolean> {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPOSITORY) return false;
  const res = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW ?? "ingest.yml"}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "unstale-gateway",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF ?? "main", inputs: { reason: "fast-track" } }),
    },
  );
  if (!res.ok) console.log(`fast-track dispatch: HTTP ${res.status}`);
  return res.ok;
}

/** The next scheduled coverage run: ingest.yml's schedule, minute 23 of every third UTC hour. */
export function nextScheduled(now: number): Date {
  const at = new Date(now);
  at.setUTCMinutes(23, 0, 0);
  while (at.getTime() <= now || at.getUTCHours() % 3) at.setUTCHours(at.getUTCHours() + 1);
  return at;
}

const clock = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A known package's status as the last coverage run published it, or undefined. */
async function published(env: Env, url: URL, purl: string): Promise<Record<string, unknown> | undefined> {
  const res = await asset(env, new Request(new URL(`/v1/coverage/${await sha256(purl)}.json`, url)));
  return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
}

/**
 * Whether the public registry knows a package: true when it serves it, false on a 404, undefined when it cannot tell
 * (unreachable, any other status). A package the registry could not confirm is not queued (fails closed): the client
 * is told to retry, so a registry outage never lets a made-up name into the queue or its demand.
 */
async function registered(purl: string): Promise<boolean | undefined> {
  const name = packageIdentity(purl);
  const url = purl.startsWith("pkg:pypi/") ? `https://pypi.org/pypi/${name}/json` : `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "unstale-gateway" } });
    await res.body?.cancel();
    return res.status === 404 ? false : res.ok ? true : undefined;
  } catch {
    return undefined;
  }
}

/** A registration the registry could not confirm: retried in a minute or two (spread, as `unavailable` spreads). */
const unconfirmed = () => {
  const retryAfter = 60 + Math.floor(Math.random() * 60);
  return { error: "The public registry could not confirm this identity; retry later", retry_after: retryAfter };
};

/**
 * A held package as a job, in the coverage service's format. While a run has it, `run` says where (and the job's
 * counters are the run's), so a client can follow it until its published status replaces this answer.
 *
 * One place: a run that took the package reports its place in the run's own queue (in its line, by demand) and when
 * the run is estimated to reach it (`starts_at`, from measured throughput, as `publish_by` says when a cycle
 * publishes); that is what a client is shown. Before a run takes it, no place: the gateway's own order is only how it
 * holds requests, and the run places each by demand when it pulls (every few minutes while one is in progress, and
 * every request held at once).
 */
function queued(purl: string, at: View, now = Date.now()) {
  const { run } = at;
  // While the budget is spent no run takes it, so the next run that can is the first scheduled after the reset.
  const spent = at.spentUntil !== undefined && at.spentUntil > now ? at.spentUntil : undefined;
  // A run working the queue takes every held request at its next pull (a late pull reads as now).
  const pulls = at.pullsNext !== undefined && !spent ? new Date(Math.max(at.pullsNext, now)) : undefined;
  const next = pulls ?? nextScheduled(spent ?? now);
  // Taken by the run in progress: its place and estimate are the run's.
  const waiting: Partial<Progress> | undefined = run?.state === "waiting" ? (run.job ?? {}) : undefined;
  const startsAt = waiting?.starts_at;
  const stage = (() => {
    switch (run?.state) {
      case "dispatched":
        return "A coverage run is starting; it takes this package and places it by demand";
      case "waiting":
        return run.job?.stage || "Taken by the coverage run in progress; waiting for a coverage worker";
      case "running":
        return run.job?.stage ?? "A coverage run is working it";
      case "publishing":
        return "Analysed; the coverage run is publishing the catalog";
      default:
        // `declined` (no run sends it any more) reads as not taken yet.
        if (spent)
          return `Waiting for the coverage budget, spent until ${new Date(spent).toISOString().slice(0, 10)} ${clock(new Date(spent))}; the next run that can take it is at ${clock(next)}`;
        return pulls !== undefined
          ? `Registered; the coverage run in progress takes it at its next pull, at about ${clock(pulls)}, and places it by demand`
          : `Waiting for the next coverage run, at ${clock(next)}`;
    }
  })();
  // A job the run finished is not published until the deploy: still in progress to a client.
  const working = run?.state === "running" || run?.state === "publishing";
  const state = working ? (run.job?.state === "discovering" ? "discovering" : "analyzing") : "queued";
  const job = working ? run.job : undefined;
  return {
    schema: 1,
    purl,
    technology: technologyId(purl),
    name: packageIdentity(purl),
    state,
    stage,
    // Central's own time of the job's last save when the run sent it, the clock its published status uses too, so a
    // client can order the answers it gets for one job.
    // A waiting package's: the time of the run's estimate, on the same clock.
    updated: (job ?? waiting)?.updated ?? new Date(run?.updated ?? now).toISOString(),
    // Nothing a run reports is in the catalog before its cycle publishes: none of its records can be synced yet.
    records: 0,
    ...(job?.records && { records_pending: job.records }),
    ...(job?.publish_by && { publish_by: job.publish_by }),
    releases_done: job?.releases_done ?? 0,
    releases_total: job?.releases_total ?? 0,
    docs_done: job?.docs_done ?? 0,
    docs_total: job?.docs_total ?? 0,
    docs_failed: 0,
    ...(waiting?.queue_position && { queue_position: waiting.queue_position, queue_length: waiting.queue_length ?? waiting.queue_position }),
    // Waiting in a run: when the run is estimated to reach it (none before the run has measured its throughput).
    // Otherwise when a run next takes requests: the pull of the run in progress, or a scheduled start.
    ...(waiting ? startsAt && { next_run: startsAt, starts_at: startsAt } : { next_run: next.toISOString() }),
    // `next_run` is when the run in progress next reads the queue, not a scheduled start.
    ...(!waiting && pulls !== undefined && { next_run_pull: true }),
    ...(run && {
      run: {
        state: run.state,
        elapsed_s: Math.max(0, Math.round((now - run.since) / 1000)),
        ...(at.typical !== undefined && { typical_s: at.typical }),
      },
    }),
  };
}

/** Exactly what Date#toISOString writes: a looser parse would read "0" as the year 2000. */
const isoTime = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);
const count = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** A run's progress report: held packages and public counters only, bounded. */
function progressOf(body: unknown): { purl: string; state: RunState; job?: Progress }[] {
  const updates = (body as { updates?: unknown })?.updates;
  if (!Array.isArray(updates) || updates.length > 500) throw new Error("Expected {\"updates\": [...]} of at most 500");
  return updates.flatMap((u) => {
    const { purl, state, job } = (u ?? {}) as { purl?: unknown; state?: unknown; job?: Record<string, unknown> };
    if (typeof purl !== "string" || purl.length > 230 || !RUN_STATES.includes(state as RunState)) return [];
    return [
      {
        purl,
        state: state as RunState,
        ...(job && typeof job === "object"
          ? {
              job: {
                state: typeof job.state === "string" ? job.state.slice(0, 20) : "analyzing",
                stage: typeof job.stage === "string" ? job.stage.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 300) : "",
                records: count(job.records),
                releases_done: count(job.releases_done),
                releases_total: count(job.releases_total),
                docs_done: count(job.docs_done),
                docs_total: count(job.docs_total),
                ...(isoTime(job.updated) && { updated: job.updated as string }),
                ...(isoTime(job.publish_by) && { publish_by: job.publish_by as string }),
                ...(count(job.queue_position) && { queue_position: count(job.queue_position), queue_length: count(job.queue_length) }),
                ...(isoTime(job.starts_at) && { starts_at: job.starts_at as string }),
              },
            }
          : {}),
      },
    ];
  });
}

/** The budget a run's progress report carries: undefined when absent (unchanged), `{}` when not spent. */
function budgetOf(body: unknown): { spentUntil?: number } | undefined {
  const budget = (body as { budget?: unknown })?.budget;
  if (budget === undefined) return undefined;
  const until = (budget as { spent_until?: unknown })?.spent_until;
  if (until === null) return {};
  const ms = isoTime(until) ? Date.parse(until) : NaN;
  if (!Number.isFinite(ms)) throw new Error("Expected budget {\"spent_until\": ISO time or null}");
  return { spentUntil: ms };
}

/** The pulls a run's progress report carries: undefined when absent (unchanged), `{}` when the run pulls no more. */
function pullsOf(body: unknown): { next?: number } | undefined {
  const pulls = (body as { pulls?: unknown })?.pulls;
  if (pulls === undefined) return undefined;
  const next = (pulls as { next?: unknown })?.next;
  if (next === null) return {};
  const ms = isoTime(next) ? Date.parse(next) : NaN;
  if (!Number.isFinite(ms)) throw new Error("Expected pulls {\"next\": ISO time or null}");
  return { next: ms };
}

/** Constant time, so the token cannot be guessed byte by byte. */
function authorized(request: Request, token: string | undefined): boolean {
  const given = request.headers.get("Authorization") ?? "";
  const want = `Bearer ${token ?? ""}`;
  if (!token || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** A request the client must change: answered 400 (or its own status), never retried as it is. */
class BadRequest extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Reads a request's input; anything it throws is the input's fault. */
async function input<T>(read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof BadRequest ? error : new BadRequest(error instanceof Error ? error.message : "Invalid request");
  }
}

/** Cloudflare's reset of the daily allowance at 00:00 UTC lags: on 18 October 2026 it took effect about 00:13. */
const RESET_LAG_S = 30 * 60;
/** How soon to retry while the allowance still reads as spent just after 00:00 UTC. */
const RESET_RETRY_S = 300;
/** Retries told the same time are spread over this much after it (a share each, by `Math.random`), so the clients a
 * spent allowance deferred do not all come back in the same minute, the one the allowance has just restarted. */
const RETRY_SPREAD_S = 30 * 60;

/** Seconds until the Durable Objects free tier's daily allowance resets: 00:00 UTC, or shortly while that reset is
 * still landing (a client told "after midnight" at 00:05 would otherwise wait a whole day); spread over RETRY_SPREAD_S
 * after the reset (over RESET_RETRY_S while it lands). */
function untilReset(now = Date.now(), share = Math.random()): number {
  const sinceMidnight = (now % 86_400_000) / 1000;
  if (sinceMidnight < RESET_LAG_S) return RESET_RETRY_S + Math.floor(share * RESET_RETRY_S);
  return Math.max(60, Math.ceil(86_400 - sinceMidnight)) + Math.floor(share * RETRY_SPREAD_S);
}

/** Anything else (storage, a daily allowance, the runtime) is the service's: a temporary 503 with Retry-After, so a
 * client defers and retries instead of reading it as a rejection of the package. A spent daily allowance is retried
 * after its reset (untilReset: minutes, not a day, while Cloudflare's 00:00 UTC reset is still landing). */
function unavailable(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`unavailable: ${message.slice(0, 300)}`);
  const retryAfter = /exceeded allowed|free tier/i.test(message) ? untilReset() : 60 + Math.floor(Math.random() * 60);
  return json(503, { error: "The coverage service is temporarily unavailable; retry later", retry_after: retryAfter }, { "Retry-After": String(retryAfter) });
}

/** The package URL of a request body: one public identity, nothing else. */
async function purlOf(request: Request): Promise<string> {
  const body = await request.text();
  if (body.length > 512) throw new BadRequest("One public identity only", 413);
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "purl") throw new BadRequest("Expected {\"purl\": ...} only");
  const purl = (parsed as { purl: unknown }).purl;
  if (typeof purl !== "string" || purl.length > 230) throw new BadRequest("purl must be a string of at most 230 characters");
  packageIdentity(purl);
  return purl;
}

/** The package URLs of a batch request body, `{"purls": [...]}`: public identities only, at most BATCH, no repeats. */
async function purlsOf(request: Request): Promise<string[]> {
  const body = await request.text();
  if (body.length > BATCH * 240 + 64) throw new BadRequest(`At most ${BATCH} public identities`, 413);
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "purls") throw new BadRequest("Expected {\"purls\": [...]} only");
  const purls = (parsed as { purls: unknown }).purls;
  if (!Array.isArray(purls) || !purls.length || purls.length > BATCH) throw new BadRequest(`purls must list 1 to ${BATCH} packages`);
  for (const purl of purls) {
    if (typeof purl !== "string" || purl.length > 230) throw new BadRequest("Each purl must be a string of at most 230 characters");
    packageIdentity(purl);
  }
  if (new Set(purls).size !== purls.length) throw new BadRequest("Each package once");
  return purls as string[];
}

/** A registration's outcome as POST /coverage answers it: status and body. */
function registration(purl: string, outcome: Outcome, view: View | undefined, known: Record<string, unknown> | undefined): { status: number; body: Record<string, unknown> } {
  if (outcome.type === "refused")
    return { status: 429, body: { error: "Too many new technologies from this address; retry later", limit: outcome.limit, retry_after: outcome.retryAfter } };
  if (outcome.type === "voted") return { status: 202, body: known ?? {} };
  return { status: 202, body: queued(purl, view ?? outcome) };
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Self-declared operational marker: affects reporting only, never limits or service. Never retain its value.
  const traffic: Traffic = request.headers.get("X-Unstale-Internal-Traffic") === "1" ? "marked_internal" : "unmarked";
  const queue = () => env.COVERAGE.get(env.COVERAGE.idFromName("global"));
  try {
    if (request.method === "GET" && url.pathname === "/health") return json(200, { schema: 1, service: "unstale-coverage" });
    if (request.method === "POST" && url.pathname === "/coverage") {
      if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json(415, { error: "application/json required" });
      if (request.headers.get("Origin")) return json(403, { error: "Browser registration is not supported" });
      const purl = await input(() => purlOf(request));
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const known = await published(env, url, purl);
      const exists = !!known || (await queue().held(purl)) || (await registered(purl));
      if (exists !== true) {
        // At most one additional RPC, best effort: metrics must not replace the registry's answer.
        try { await queue().registrationFailure(exists === undefined, traffic); }
        catch { console.log("Registration outcome metrics unavailable"); }
        if (exists === false) return json(404, { error: "No public package with this identity" });
        const body = unconfirmed();
        return json(503, body, { "Retry-After": String(body.retry_after) });
      }
      const { outcome, view } = await queue().request(purl, address, !!known, traffic);
      const { status, body } = registration(purl, outcome, view, known);
      return json(status, body, outcome.type === "refused" ? { "Retry-After": String(outcome.retryAfter) } : {});
    }
    // A batch of registrations: each package as POST /coverage would answer it, in the order sent.
    if (request.method === "POST" && url.pathname === "/coverage/register") {
      if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json(415, { error: "application/json required" });
      if (request.headers.get("Origin")) return json(403, { error: "Browser registration is not supported" });
      const purls = await input(() => purlsOf(request));
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const known = await Promise.all(purls.map((purl) => published(env, url, purl)));
      const unknown = purls.filter((_, i) => !known[i]);
      const held = new Set(unknown.length ? await queue().heldMany(unknown) : []);
      const exists = await Promise.all(purls.map((purl, i) => !!known[i] || held.has(purl) || registered(purl)));
      const asked = purls.flatMap((purl, i) => (exists[i] ? [{ purl, known: !!known[i] }] : []));
      let answers: { outcome: Outcome; view?: View }[] = [];
      try {
        answers = await queue().requestMany(asked, address, traffic, {
          notFound: exists.filter((value) => value === false).length,
          unavailable: exists.filter((value) => value === undefined).length,
        });
      } catch (error) {
        // When valid packages require admission this is the existing service RPC, not a metrics-only call:
        // preserve its whole-batch 503 behavior instead of inventing per-package admission results.
        if (asked.length) throw error;
        // An all-rejected batch needs only metrics; preserve the already-known registry responses.
        console.log("Registration outcome metrics unavailable");
      }
      const by = new Map(asked.map(({ purl }, i) => [purl, answers[i]!]));
      return json(200, {
        results: purls.map((purl, i) => {
          const answer = by.get(purl);
          if (!answer) return exists[i] === false ? { purl, status: 404, error: "No public package with this identity" } : { purl, status: 503, ...unconfirmed() };
          const { status, body } = registration(purl, answer.outcome, answer.view, known[i]);
          return status === 202 ? { purl, status, job: body } : { purl, status, ...body };
        }),
      });
    }
    // A batch of status reads: each package as GET /coverage would answer it.
    if (request.method === "POST" && url.pathname === "/coverage/status") {
      const purls = await input(() => purlsOf(request));
      const known = await Promise.all(purls.map((purl) => published(env, url, purl)));
      const unknown = purls.filter((_, i) => !known[i]);
      const views: Record<string, View> = unknown.length ? await queue().views(unknown) : {};
      return json(200, {
        results: purls.map((purl, i) => {
          const at = views[purl];
          if (known[i]) return { purl, status: 200, job: known[i] };
          return at ? { purl, status: 200, job: queued(purl, at) } : { purl, status: 404, error: "No shared job for this identity" };
        }),
      });
    }
    if (request.method === "GET" && url.pathname === "/coverage") {
      const purl = url.searchParams.get("purl") ?? "";
      await input(() => packageIdentity(purl));
      const known = await published(env, url, purl);
      if (known) return json(200, known);
      const at = await queue().view(purl);
      return at ? json(200, queued(purl, at)) : json(404, { error: "No shared job for this identity" });
    }
    if (url.pathname.startsWith("/internal/")) {
      if (!authorized(request, env.DRAIN_TOKEN)) return json(401, { error: "Unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/demand") return json(200, await queue().demand());
      if (request.method === "GET" && url.pathname === "/internal/usage") return json(200, await queue().usage());
      if (request.method === "GET" && url.pathname === "/internal/queue") return json(200, { requests: await queue().list(), usage: await queue().usage() });
      if (request.method === "POST" && url.pathname === "/internal/ack") {
        const { requests } = await input(async () => {
          const body = (await request.json()) as { requests?: Taken[] } | null;
          if (!body || typeof body !== "object") throw new BadRequest("Expected {\"requests\": [...]}");
          return body;
        });
        return json(200, { removed: await queue().ack(Array.isArray(requests) ? requests : []), usage: await queue().usage() });
      }
      if (request.method === "POST" && url.pathname === "/internal/progress") {
        const body = await input(() => request.json());
        const [updates, budget, pulls] = await input(() => [progressOf(body), budgetOf(body), pullsOf(body)] as const);
        return json(200, await queue().report(updates, budget, pulls));
      }
    }
    // A packed catalog file, answered as the static file was: before the website's redirects, which the asset layer
    // never made for it (the catalog is not routed to the Worker first).
    if (url.pathname.startsWith("/v1/")) {
      const file = await packedAsset(env, request);
      if (file) return file;
    }
    return page(request, env, url);
  } catch (error) {
    if (error instanceof BadRequest) return json(error.status, { error: error.message.slice(0, 200) });
    return unavailable(error);
  }
}

/** True when the client ranks Markdown above HTML (agents asking for `text/markdown`; browsers lead with HTML). */
export function prefersMarkdown(accept: string | null): boolean {
  const q = (type: string) => {
    for (const part of (accept ?? "").split(",")) {
      const [media, ...params] = part.trim().split(";");
      if (media?.trim().toLowerCase() !== type) continue;
      const v = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return v ? Number(v.slice(2)) || 0 : 1;
    }
    return 0;
  };
  return q("text/markdown") > 0 && q("text/markdown") >= q("text/html");
}

// Website pages (gateway/site/build.ts; routed here by run_worker_first: "/", "/npm/*", "/pypi/*"): the apex over
// HTTPS, and a page's index.md twin for clients that ask for Markdown. Everything else is the static file, packed or
// not (assets.ts): a request for a packed catalog file finds no static file and so reaches the Worker here.
export async function page(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.hostname.startsWith("www.") || url.protocol === "http:") {
    return Response.redirect(`https://${url.hostname.replace(/^www\./, "")}${url.pathname}${url.search}`, 301);
  }
  // Google's ownership file must answer 200 at its exact .html path; the asset layer would redirect it to the
  // extensionless path, so it is read from there.
  if (/^\/google[0-9a-f]+\.html$/.test(url.pathname)) {
    const file = await env.ASSETS.fetch(new URL(url.pathname.slice(0, -".html".length), url));
    return new Response(file.body, { status: file.status, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (request.method === "GET" && url.pathname.endsWith("/") && prefersMarkdown(request.headers.get("Accept"))) {
    const md = await asset(env, new Request(new URL(`${url.pathname}index.md`, url)));
    if (md.ok) {
      return new Response(md.body, {
        headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", Link: `<${url.href}>; rel="canonical"` },
      });
    }
  }
  const res = await asset(env, request);
  if (!url.pathname.endsWith("/")) return res;
  const out = new Response(res.body, res);
  out.headers.append("Vary", "Accept");
  return out;
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
