// The public face of unstale's catalog and coverage service on Cloudflare. Static files are the exported catalog
// (`v1/`, written by central's `catalog export`) and are served without running this code. This code answers what a
// static host cannot, with the same wire format as central's coverage service (onboarding/service.ts), so the client
// needs no change:
//   GET /health                 the coverage service marker the client checks
//   POST /coverage {purl}       a vote on a known package, or a new package queued for the next coverage run
//   GET /coverage?purl=         a known package's published status, or a held one's place in the queue
//   GET /internal/queue         the held requests, for a coverage run (bearer DRAIN_TOKEN)
//   POST /internal/ack          what a deployed run took (bearer DRAIN_TOKEN)
//   GET /internal/usage         the object's rows read and written today against the free tier (bearer DRAIN_TOKEN);
//                               also in the answers to /internal/queue and /internal/ack, which a run prints
//   POST /internal/progress     where a run is with the held packages it pulled (bearer DRAIN_TOKEN), so a client
//                               that started one early can follow it until the package is published; with
//                               `budget.spent_until`, until when central's budget is spent (no early run until then);
//                               with `pulls.next`, when the run reads the queue again (no early run while it does;
//                               null: it is done, and an early run held back meanwhile starts)
// Only the public identity of a package is accepted; no repository context, and no client address is stored.
import { DurableObject } from "cloudflare:workers";
import { packageIdentity, technologyId } from "../../central/src/onboarding/identity.ts";
import { PendingQueue, RUN_STATES, settingsFrom, type Outcome, type Progress, type Request as Taken, type RunState, type View } from "./queue.ts";

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
  request(purl: string, address: string, known: boolean): { outcome: Outcome; view?: View } {
    const outcome = this.queue.request(purl, address, known);
    if (outcome.type === "queued" && outcome.fastTrack)
      this.ctx.waitUntil(
        dispatch(this.env)
          .catch(() => false)
          .then((started) => started || this.queue.undispatched(purl)),
      );
    return { outcome, view: outcome.type === "queued" ? this.queue.view(purl) : undefined };
  }
  held(purl: string): boolean {
    return this.queue.held(purl);
  }
  /** A held new package's place in the queue and the run working it, if any. */
  view(purl: string): View | undefined {
    return this.queue.view(purl);
  }
  /** A run's progress; `budget` (when the report carries it) replaces what the gateway knows of central's budget, and
   * `pulls` what it knows of the run's pulls. A run done pulling starts the early run held back meanwhile, if any. */
  report(updates: { purl: string; state: RunState; job?: Progress }[], budget?: { spentUntil?: number }, pulls?: { next?: number }): { reported: number; dispatched?: boolean } {
    if (budget) this.queue.setBudget(budget.spentUntil);
    const start = pulls ? this.queue.setPulls(pulls.next) : false;
    if (start) this.ctx.waitUntil(dispatch(this.env).catch(() => false));
    return { reported: this.queue.report(updates), ...(pulls ? { dispatched: start } : {}) };
  }
  list(): Taken[] {
    return this.queue.list();
  }
  ack(taken: Taken[]): number {
    return this.queue.ack(taken);
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
  const res = await env.ASSETS.fetch(new URL(`/v1/coverage/${await sha256(purl)}.json`, url));
  return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
}

/**
 * Whether the public registry knows a package: only a 404 says no. A registry outage answers yes, since the coverage
 * run verifies the identity again before any work; this check only keeps made-up names out of the queue.
 */
async function registered(purl: string): Promise<boolean> {
  const name = packageIdentity(purl);
  const url = purl.startsWith("pkg:pypi/") ? `https://pypi.org/pypi/${name}/json` : `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "unstale-gateway" } });
    await res.body?.cancel();
    return res.status !== 404;
  } catch {
    return true;
  }
}

/**
 * A held package as a job, in the coverage service's format. While a run has it, `run` says where (and the job's
 * counters are the run's), so a client can follow it until its published status replaces this answer.
 */
function queued(purl: string, at: View, now = Date.now()) {
  const { run } = at;
  const place = `position ${at.position} of ${at.length}`;
  // While the budget is spent no run takes it, so the next run that can is the first scheduled after the reset.
  const spent = at.spentUntil !== undefined && at.spentUntil > now ? at.spentUntil : undefined;
  // A run working the queue takes a new request at its next pull (a late pull reads as now).
  const pulls = at.pullsNext !== undefined && !spent ? new Date(Math.max(at.pullsNext, now)) : undefined;
  const next = pulls ?? nextScheduled(spent ?? now);
  const stage = (() => {
    switch (run?.state) {
      case "dispatched":
        return `Queued (${place}); a coverage run is starting and takes it if it is next`;
      case "running":
        return run.job?.stage ?? "A coverage run is working it";
      case "publishing":
        return "Analysed; the coverage run is publishing the catalog";
      case "declined":
        return `Another package is ahead (${place}); waiting for the scheduled run at ${clock(next)}`;
      default:
        if (spent)
          return `Waiting for the coverage budget, spent until ${new Date(spent).toISOString().slice(0, 10)} ${clock(new Date(spent))} (${place}); the next run that can take it is at ${clock(next)}`;
        return pulls !== undefined ? `Queued (${place}); the coverage run in progress takes new requests at about ${clock(pulls)}` : `Waiting for the next coverage run (${place})`;
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
    updated: new Date(run?.updated ?? now).toISOString(),
    records: job?.records ?? 0,
    releases_done: job?.releases_done ?? 0,
    releases_total: job?.releases_total ?? 0,
    docs_done: job?.docs_done ?? 0,
    docs_total: job?.docs_total ?? 0,
    docs_failed: 0,
    queue_position: at.position,
    queue_length: at.length,
    next_run: next.toISOString(),
    ...(run && {
      run: {
        state: run.state,
        elapsed_s: Math.max(0, Math.round((now - run.since) / 1000)),
        ...(at.typical !== undefined && { typical_s: at.typical }),
      },
    }),
  };
}

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
  // Exactly what Date#toISOString writes: a looser parse would read "0" as the year 2000 and clear a pause.
  const ms = typeof until === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until) ? Date.parse(until) : NaN;
  if (!Number.isFinite(ms)) throw new Error("Expected budget {\"spent_until\": ISO time or null}");
  return { spentUntil: ms };
}

/** The pulls a run's progress report carries: undefined when absent (unchanged), `{}` when the run pulls no more. */
function pullsOf(body: unknown): { next?: number } | undefined {
  const pulls = (body as { pulls?: unknown })?.pulls;
  if (pulls === undefined) return undefined;
  const next = (pulls as { next?: unknown })?.next;
  if (next === null) return {};
  const ms = typeof next === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(next) ? Date.parse(next) : NaN;
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

/** Seconds until the Durable Objects free tier's daily allowance resets: 00:00 UTC, or shortly while that reset is
 * still landing (a client told "after midnight" at 00:05 would otherwise wait a whole day). */
function untilReset(now = Date.now()): number {
  const sinceMidnight = (now % 86_400_000) / 1000;
  if (sinceMidnight < RESET_LAG_S) return RESET_RETRY_S;
  return Math.max(60, Math.ceil(86_400 - sinceMidnight));
}

/** Anything else (storage, a daily allowance, the runtime) is the service's: a temporary 503 with Retry-After, so a
 * client defers and retries instead of reading it as a rejection of the package. A spent daily allowance is retried
 * after its reset (untilReset: minutes, not a day, while Cloudflare's 00:00 UTC reset is still landing). */
function unavailable(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`unavailable: ${message.slice(0, 300)}`);
  const retryAfter = /exceeded allowed|free tier/i.test(message) ? untilReset() : 60;
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

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const queue = () => env.COVERAGE.get(env.COVERAGE.idFromName("global"));
  try {
    if (request.method === "GET" && url.pathname === "/health") return json(200, { schema: 1, service: "unstale-coverage" });
    if (request.method === "POST" && url.pathname === "/coverage") {
      if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json(415, { error: "application/json required" });
      if (request.headers.get("Origin")) return json(403, { error: "Browser registration is not supported" });
      const purl = await input(() => purlOf(request));
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const known = await published(env, url, purl);
      if (!known && !(await queue().held(purl)) && !(await registered(purl))) return json(404, { error: "No public package with this identity" });
      const { outcome, view } = await queue().request(purl, address, !!known);
      if (outcome.type === "refused")
        return json(
          429,
          { error: "Too many new technologies from this address; retry later", limit: outcome.limit, retry_after: outcome.retryAfter },
          { "Retry-After": String(outcome.retryAfter) },
        );
      if (outcome.type === "voted") return json(202, known);
      return json(202, queued(purl, view ?? outcome));
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
// HTTPS, and a page's index.md twin for clients that ask for Markdown. Everything else is the static file.
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
    const md = await env.ASSETS.fetch(new URL(`${url.pathname}index.md`, url));
    if (md.ok) {
      return new Response(md.body, {
        headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", Link: `<${url.href}>; rel="canonical"` },
      });
    }
  }
  const res = await env.ASSETS.fetch(request);
  if (!url.pathname.endsWith("/")) return res;
  const out = new Response(res.body, res);
  out.headers.append("Vary", "Accept");
  return out;
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
