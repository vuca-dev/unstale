// The public face of unstale's catalog and coverage service on Cloudflare (vault: Central Scheduling and
// Infrastructure, "Registration gateway"). Static files are the exported catalog (`v1/`, written by central's
// `catalog export`) and are served without running this code. This code answers what a static host cannot, with the
// same wire format as central's coverage service (onboarding/service.ts), so the client needs no change:
//   GET /health                 the coverage service marker the client checks
//   POST /coverage {purl}       a vote on a known package, or a new package queued for the next coverage run
//   GET /coverage?purl=         a known package's published status, or a held one's place in the queue
//   GET /internal/queue         the held requests, for a coverage run (bearer DRAIN_TOKEN)
//   POST /internal/ack          what a deployed run took (bearer DRAIN_TOKEN)
// Only the public identity of a package is accepted; no repository context, and no client address is stored.
import { DurableObject } from "cloudflare:workers";
import { packageIdentity, technologyId } from "../../central/src/onboarding/identity.ts";
import { PendingQueue, settingsFrom, type Outcome, type Request as Taken } from "./queue.ts";

export interface Env {
  ASSETS: Fetcher;
  COVERAGE: DurableObjectNamespace<Coverage>;
  DRAIN_TOKEN?: string;
  /** A fine-grained token with Actions: write on this repository only; without it nothing is fast-tracked. */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  RATE_PER_HOUR?: string;
  MAX_PENDING?: string;
  FAST_TRACK_PER_DAY?: string;
  FAST_TRACK_INTERVAL_MINUTES?: string;
}

/** The single queue: one object, so limits and order are global. */
export class Coverage extends DurableObject<Env> {
  private readonly queue: PendingQueue;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.queue = new PendingQueue(ctx.storage.sql, settingsFrom(env as unknown as Record<string, string | undefined>));
  }
  request(purl: string, address: string, known: boolean): Outcome {
    const outcome = this.queue.request(purl, address, known);
    if (outcome.type === "queued" && outcome.fastTrack) this.ctx.waitUntil(dispatch(this.env));
    return outcome;
  }
  position(purl: string) {
    return this.queue.position(purl);
  }
  list(): Taken[] {
    return this.queue.list();
  }
  ack(taken: Taken[]): number {
    return this.queue.ack(taken);
  }
}

/** Starts the coverage workflow early; a failure only means the package waits for the schedule. */
async function dispatch(env: Env): Promise<void> {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPOSITORY) return;
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${env.GITHUB_WORKFLOW ?? "ingest.yml"}/dispatches`,
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
}

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

/** A held package as a queued job, in the coverage service's format. */
function queued(purl: string, at: { position: number; length: number }, early: boolean) {
  return {
    schema: 1,
    purl,
    technology: technologyId(purl),
    name: packageIdentity(purl),
    state: "queued",
    stage: `${early ? "Starting a coverage run" : "Waiting for the next coverage run"} (position ${at.position} of ${at.length})`,
    updated: new Date().toISOString(),
    records: 0,
    releases_done: 0,
    releases_total: 0,
    docs_done: 0,
    docs_total: 0,
    docs_failed: 0,
    queue_position: at.position,
    queue_length: at.length,
  };
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
      const outcome = await queue().request(purl, address, !!known);
      if (outcome.type === "refused")
        return json(
          429,
          { error: "Too many new technologies from this address; retry later", limit: outcome.limit, retry_after: outcome.retryAfter },
          { "Retry-After": String(outcome.retryAfter) },
        );
      if (outcome.type === "voted") return json(202, known);
      return json(202, queued(purl, outcome, outcome.fastTrack));
    }
    if (request.method === "GET" && url.pathname === "/coverage") {
      const purl = url.searchParams.get("purl") ?? "";
      packageIdentity(purl);
      const known = await published(env, url, purl);
      if (known) return json(200, known);
      const at = await queue().position(purl);
      return at ? json(200, queued(purl, at, false)) : json(404, { error: "No shared job for this identity" });
    }
    if (url.pathname === "/internal/queue" || url.pathname === "/internal/ack") {
      if (!authorized(request, env.DRAIN_TOKEN)) return json(401, { error: "Unauthorized" });
      if (request.method === "GET" && url.pathname === "/internal/queue") return json(200, { requests: await queue().list() });
      if (request.method === "POST" && url.pathname === "/internal/ack") {
        const { requests } = (await request.json()) as { requests?: Taken[] };
        return json(200, { removed: await queue().ack(Array.isArray(requests) ? requests : []) });
      }
    }
    return env.ASSETS.fetch(request);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    return json(status, { error: error instanceof Error ? error.message.slice(0, 200) : "Invalid request" });
  }
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
