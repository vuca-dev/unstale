// Local preview of a client following a fast-track run. The real gateway (src/index.ts) runs over an in-memory queue;
// GitHub's dispatch is replaced by a played coverage run that reports progress to the gateway's own
// /internal/progress, publishes a status and acknowledges, as ingest.yml's drain and deploy do. Everything else (the
// catalog, the published statuses of known packages) is read from the live gateway.
//
//   node gateway/scripts/preview.ts [--port 8787] [--new pkg:npm/picocolors,...] [--declined] [--speed 1]
//   unstale init --service http://127.0.0.1:8787     (in a repository that depends on a --new package)
//
// --new      packages treated as not yet covered, even if the live catalog has them (any it lacks are new anyway)
// --declined the played run finds another package ahead and takes none (drain --fast-track's `ran: false`)
// --stall    the played run never starts (the client gives up after 5 minutes)
// --speed    2 plays the run twice as fast
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { parseArgs } from "node:util";

registerHooks({
  resolve: (spec, ctx, next) => next(spec === "cloudflare:workers" ? new URL("../test/workers-stub.ts", import.meta.url).href : spec, ctx),
});
const { Coverage, handle } = await import("../src/index.ts");
const { memorySql } = await import("../test/sqlite.ts");
const { packageIdentity, technologyId } = await import("../../central/src/onboarding/identity.ts");
type Env = import("../src/index.ts").Env;

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    new: { type: "string", default: "" },
    upstream: { type: "string", default: "https://api.unstale.sh" },
    declined: { type: "boolean", default: false },
    stall: { type: "boolean", default: false },
    speed: { type: "string", default: "1" },
  },
});
const upstream = values.upstream.replace(/\/+$/, "");
const speed = Number(values.speed) > 0 ? Number(values.speed) : 1;
const forced = new Set(values.new.split(",").map((s) => s.trim()).filter(Boolean));
const GITHUB = "http://github.preview.invalid";
const TOKEN = "preview";

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const statusPath = async (purl: string) => `/v1/coverage/${await sha256(purl)}.json`;
/** Statuses this preview published; forced packages answer 404 until then. */
const published = new Map<string, unknown>();
const hidden = new Set(await Promise.all([...forced].map(statusPath)));

const realFetch = globalThis.fetch;
const env = {
  DRAIN_TOKEN: TOKEN,
  GITHUB_DISPATCH_TOKEN: TOKEN,
  GITHUB_REPOSITORY: "preview/unstale",
  GITHUB_API_URL: GITHUB,
  FAST_TRACK_PER_DAY: "1000",
  FAST_TRACK_INTERVAL_MINUTES: "0",
  ASSETS: {
    fetch: async (input: Request | URL | string) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (published.has(path)) return new Response(JSON.stringify(published.get(path)), { headers: { "Content-Type": "application/json" } });
      if (hidden.has(path)) return new Response("not found", { status: 404 });
      const res = await realFetch(upstream + path);
      return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream" } });
    },
  },
} as unknown as Env;
const object = new Coverage({ storage: { sql: memorySql() }, waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) } as unknown as DurableObjectState, env);
env.COVERAGE = { idFromName: () => "global", get: () => object } as unknown as Env["COVERAGE"];

const internal = (path: string, body?: unknown) =>
  handle(
    new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  ).then((r) => r.json() as Promise<Record<string, unknown>>);
const wait = (s: number) => new Promise((r) => setTimeout(r, (s * 1000) / speed));
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`);

/** One played coverage run over everything held, like ingest.yml: runner pickup, drain, export and deploy, ack. */
async function play(): Promise<void> {
  if (values.stall) return log("run requested; --stall: it never starts");
  await wait(5); // a runner picks the job up, state restored
  const { requests } = (await internal("/internal/queue")) as { requests: { purl: string; demand: number }[] };
  log(`run started; pulled ${requests.map((r) => r.purl).join(", ") || "nothing"}`);
  if (values.declined) {
    await internal("/internal/progress", { updates: requests.map(({ purl }) => ({ purl, state: "declined" })) });
    return log("run declined: another package is ahead");
  }
  const report = (state: string, job: Record<string, unknown>) =>
    internal("/internal/progress", { updates: requests.map(({ purl }) => ({ purl, state, job: { state: "analyzing", ...job } })) });
  await report("running", { state: "discovering", stage: "Discovering official sources" });
  await wait(4);
  const releases = 12;
  const docs = 30;
  for (let i = 0; i <= releases; i++) {
    await report("running", { stage: "Reading release notes", releases_done: i, releases_total: releases, docs_total: docs, records: i * 2 });
    await wait(1.5);
  }
  for (let d = 0; d <= docs; d += 6) {
    await report("running", { stage: "Checking documentation", releases_done: releases, releases_total: releases, docs_done: d, docs_total: docs, records: releases * 2 });
    await wait(1);
  }
  await report("publishing", { releases_done: releases, releases_total: releases, docs_done: docs, docs_total: docs, records: releases * 2 });
  log("analysed; exporting and deploying");
  await wait(8);
  for (const { purl } of requests) {
    published.set(await statusPath(purl), { schema: 1, purl, technology: technologyId(purl), name: packageIdentity(purl), state: "partial", stage: `${releases * 2} records available; continuing centrally`, records: releases * 2, updated: new Date().toISOString() });
  }
  log("deployed; statuses published");
  await wait(3);
  log(`acknowledged: ${JSON.stringify(await internal("/internal/ack", { requests }))}`);
}

// Runs one at a time, as the workflow's concurrency group does.
let runs = Promise.resolve();
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(GITHUB)) return realFetch(input, init);
  log("fast-track dispatch received");
  runs = runs.then(play).catch((e) => log(`played run failed: ${e}`));
  return new Response(null, { status: 204 });
}) as typeof fetch;

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers(req.headers as Record<string, string>);
  headers.set("CF-Connecting-IP", req.socket.remoteAddress ?? "127.0.0.1");
  const response = await handle(
    new Request(`http://127.0.0.1:${values.port}${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }),
    env,
  );
  if (req.url?.startsWith("/coverage")) log(`${req.method} ${decodeURIComponent(req.url)} → ${response.status}`);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(values.port), "127.0.0.1", () =>
  log(`preview gateway on http://127.0.0.1:${values.port} (catalog from ${upstream}; new: ${[...forced].join(", ") || "only what it lacks"})`),
);
