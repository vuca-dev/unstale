// The public face of unstale's catalog and coverage service on Cloudflare. Static files are the exported catalog
// (`v1/`, written by central's `catalog export`) and are served without running this code. This code answers what a
// static host cannot, with the same wire format as central's coverage service (onboarding/service.ts), so the client
// needs no change:
//   GET /health                 the coverage service marker the client checks
//   POST /coverage {purl}       a vote on a known package, or a new package queued for the next coverage run
//   GET /coverage?purl=         a known package's published status, or a held one's place in the queue
//   GET /internal/queue         the held requests, for a coverage run (bearer DRAIN_TOKEN)
//   POST /internal/ack          what a deployed run took (bearer DRAIN_TOKEN)
//   POST /internal/progress     where a run is with the held packages it pulled (bearer DRAIN_TOKEN), so a client
//                               that started one early can follow it until the package is published; with
//                               `budget.spent_until`, until when central's budget is spent (no early run until then)
// Only the public identity of a package is accepted; no repository context, and no client address is stored.
import { DurableObject } from "cloudflare:workers";
import { packageIdentity, technologyId } from "../../central/src/onboarding/identity.ts";
import { PendingQueue, RUN_STATES, settingsFrom, type Outcome, type Progress, type Request as Taken, type Run, type RunState } from "./queue.ts";

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
    this.queue = new PendingQueue(ctx.storage.sql, settings);
  }
  request(purl: string, address: string, known: boolean): Outcome {
    const outcome = this.queue.request(purl, address, known);
    if (outcome.type === "queued" && outcome.fastTrack)
      this.ctx.waitUntil(
        dispatch(this.env)
          .catch(() => false)
          .then((started) => started || this.queue.undispatched(purl)),
      );
    return outcome;
  }
  held(purl: string): boolean {
    return this.queue.held(purl);
  }
  /** A held new package's place in the queue and the run working it, if any. */
  view(purl: string): View | undefined {
    const at = this.queue.position(purl);
    return at && { ...at, run: this.queue.run(purl), typical: this.queue.typicalSeconds(), spentUntil: this.queue.spentUntil() };
  }
  /** A run's progress; `budget` (when the report carries it) replaces what the gateway knows of central's budget. */
  report(updates: { purl: string; state: RunState; job?: Progress }[], budget?: { spentUntil?: number }): number {
    if (budget) this.queue.setBudget(budget.spentUntil);
    return this.queue.report(updates);
  }
  list(): Taken[] {
    return this.queue.list();
  }
  ack(taken: Taken[]): number {
    return this.queue.ack(taken);
  }
}

interface View {
  position: number;
  length: number;
  run?: Run;
  typical?: number;
  /** Central's budget is spent until then (ms): no run takes a new package before it. */
  spentUntil?: number;
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
  const next = nextScheduled(spent ?? now);
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
        return spent
          ? `Waiting for the coverage budget, spent until ${new Date(spent).toISOString().slice(0, 10)} ${clock(new Date(spent))} (${place}); the next run that can take it is at ${clock(next)}`
          : `Waiting for the next coverage run (${place})`;
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
  const ms = typeof until === "string" ? Date.parse(until) : NaN;
  if (!Number.isFinite(ms)) throw new Error("Expected budget {\"spent_until\": ISO time or null}");
  return { spentUntil: ms };
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

/** The package URL of a request body: one public identity, nothing else. */
async function purlOf(request: Request): Promise<string> {
  const body = await request.text();
  if (body.length > 512) throw Object.assign(new Error("One public identity only"), { status: 413 });
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "purl") throw new Error("Expected {\"purl\": ...} only");
  const purl = (parsed as { purl: unknown }).purl;
  if (typeof purl !== "string" || purl.length > 230) throw new Error("purl must be a string of at most 230 characters");
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
      const purl = await purlOf(request);
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const known = await published(env, url, purl);
      if (!known && !(await queue().held(purl)) && !(await registered(purl))) return json(404, { error: "No public package with this identity" });
      const outcome = await queue().request(purl, address, !!known);
      if (outcome.type === "refused")
        return json(
          429,
          { error: "Too many new technologies from this address; retry later", limit: outcome.limit, retry_after: outcome.retryAfter },
          { "Retry-After": String(outcome.retryAfter) },
        );
      if (outcome.type === "voted") return json(202, known);
      return json(202, queued(purl, (await queue().view(purl)) ?? outcome));
    }
    if (request.method === "GET" && url.pathname === "/coverage") {
      const purl = url.searchParams.get("purl") ?? "";
      packageIdentity(purl);
      const known = await published(env, url, purl);
      if (known) return json(200, known);
      const at = await queue().view(purl);
      return at ? json(200, queued(purl, at)) : json(404, { error: "No shared job for this identity" });
    }
    if (url.pathname === "/internal/queue" || url.pathname === "/internal/ack" || url.pathname === "/internal/progress") {
      if (!authorized(request, env.DRAIN_TOKEN)) return json(401, { error: "Unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/queue") return json(200, { requests: await queue().list() });
      if (request.method === "POST" && url.pathname === "/internal/ack") {
        const { requests } = (await request.json()) as { requests?: Taken[] };
        return json(200, { removed: await queue().ack(Array.isArray(requests) ? requests : []) });
      }
      if (request.method === "POST" && url.pathname === "/internal/progress") {
        const body = await request.json();
        return json(200, { reported: await queue().report(progressOf(body), budgetOf(body)) });
      }
    }
    return page(request, env, url);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    return json(status, { error: error instanceof Error ? error.message.slice(0, 200) : "Invalid request" });
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
