// Coverage in batch mode, for an ephemeral runner. The gateway accepts registrations and holds them; this pulls them,
// works the same queue the service works (refreshes and admitted history first, then new technologies by demand, ties
// broken by adoption, all under the coverage budget), and writes every job's public status for the static catalog. The
// pulled packages are acknowledged only after the deploy that publishes their status (`drain ack`), so a failed run
// loses no request.
//
// `--fast-track` (a run the gateway started for a new package): requests are queued as always, but a job runs only if
// a pulled package is next in the line of new technologies (most requested first, then most adopted, then first
// asked); then only those at the head of the line run. Otherwise nothing runs and the final line says `"ran": false`,
// and the workflow saves nothing, so the gateway keeps the request for the next scheduled run. Refreshes are the
// schedule's.
//
// Progress: while it works the new packages it pulled, a run reports their public counters to the gateway (`running`,
// then `publishing` once analysed, `declined` when a fast-track run does not take them), so a client that asked for one
// can follow it until the deploy publishes its status. Best effort: a report that fails never stops the run.
//
// Budget: the final line names the budget limits that held work back (`held`: tokens, new_per_day, runs_per_day, each
// with its cap and reset time), so `"started": 0` is never unexplained. The last progress report also tells the
// gateway until when the budget is spent (`budget.spent_until`, the latest reset of the limits at their cap, null when
// none is), and the gateway starts no early run until then: a fast-track run could start nothing. Sent on every run,
// so a budget raised or reset clears it at the next one; registrations are still queued meanwhile.
//
//   npm run drain -- [--minutes 240] [--grace-minutes 10] [--concurrency 4] [--taken <file>] [--fast-track]
//   npm run drain -- ack <file>
// Gateway: UNSTALE_GATEWAY_URL and UNSTALE_GATEWAY_TOKEN; without them only the saved queue is worked.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { catalogDir, centralDir } from "../pipeline/paths.ts";
import { sha256, writeAtomic } from "../pipeline/util.ts";
import { CoverageService } from "./service.ts";

const gateway = () => {
  const url = process.env.UNSTALE_GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.UNSTALE_GATEWAY_TOKEN;
  return url && token ? { url, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } : undefined;
};

interface Pulled {
  requests: { purl: string; demand: number }[];
}

/** The gateway's queue; unreachable or malformed answers pull nothing (the saved queue is still worked). */
async function pull(): Promise<Pulled["requests"]> {
  const g = gateway();
  if (!g) return [];
  try {
    const res = await fetch(`${g.url}/internal/queue`, { headers: g.headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Pulled;
    if (!Array.isArray(body.requests)) throw new Error("no requests array");
    return body.requests.filter((r) => typeof r?.purl === "string" && Number.isFinite(r?.demand));
  } catch (e) {
    console.error(`gateway queue not read (${e instanceof Error ? e.message : e}); working the saved queue only`);
    return [];
  }
}

type RunState = "running" | "publishing" | "declined";

/** The budget as the gateway reads it: spent until the latest reset of the limits at their cap, or null. */
function budgetOf(service: CoverageService): { spent_until: string | null } {
  const resets = service.spent().map((h) => h.resets).sort();
  return { spent_until: resets.at(-1) ?? null };
}

/** Where this run is with these pulled packages, for the clients that follow them, in requests of at most 500 (the
 * gateway's bound), the budget with the first; failures are logged once. */
let reportFailed = false;
async function report(updates: { purl: string; state: RunState; job?: Record<string, unknown> }[], budget?: { spent_until: string | null }): Promise<void> {
  const g = gateway();
  if (!g || (!updates.length && !budget)) return;
  try {
    for (let i = 0; i === 0 || i < updates.length; i += 500) {
      const body = { updates: updates.slice(i, i + 500), ...(i === 0 && budget ? { budget } : {}) };
      const res = await fetch(`${g.url}/internal/progress`, { method: "POST", headers: g.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    if (!reportFailed) console.error(`gateway progress not reported (${e instanceof Error ? e.message : e}); the run continues`);
    reportFailed = true;
  }
}

/** A pulled package's job as the gateway shows it: the job that works it (a merged package's is its technology's). */
function progressOf(service: CoverageService, purl: string): { purl: string; state: RunState; job: Record<string, unknown> } | undefined {
  const own = service.jobs.get(purl);
  const job = (own?.merged_into && service.jobs.get(own.merged_into)) || own;
  if (!job || (job.state === "queued" && !service.working(job.purl))) return undefined;
  const { state, stage, records, releases_done, releases_total, docs_done, docs_total } = job;
  return { purl, state: service.working(job.purl) ? "running" : "publishing", job: { state, stage, records, releases_done, releases_total, docs_done, docs_total } };
}

/** Replaces the status directory as a whole, so a job that no longer exists has no status left behind. */
function writeStatuses(service: CoverageService): number {
  const dir = join(centralDir(), "onboarding", "status");
  const tmp = `${dir}.partial-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const statuses = service.statuses();
  for (const s of statuses) writeFileSync(join(tmp, `${sha256(s.purl)}.json`), JSON.stringify(s));
  const old = `${dir}.old-${process.pid}`;
  if (existsSync(dir)) renameSync(dir, old);
  renameSync(tmp, dir);
  rmSync(old, { recursive: true, force: true });
  return statuses.length;
}

async function drain(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { minutes: { type: "string" }, "grace-minutes": { type: "string" }, concurrency: { type: "string" }, taken: { type: "string" }, "fast-track": { type: "boolean" } },
  });
  if (!existsSync(join(catalogDir(), "v1/root.json")))
    writeAtomic(join(catalogDir(), "v1/root.json"), JSON.stringify({ schema: 1, min_client: "0.1.0" }));
  const t0 = Date.now();
  // Jobs at once: the work is mostly waiting on docs sites (scale probe), so more than the server's default of 2.
  const service = new CoverageService(Number(values.concurrency ?? 4) || 4).hold();
  const requests = await pull();
  const known = new Set(service.jobs.keys());
  const taken = service.enqueue(requests);
  await service.readAdoption();
  const fresh = taken.filter((p) => !known.has(p));
  // Fast-track: the pulled new packages at the head of the line of new technologies, in order; none when another
  // package is ahead of them.
  let only: Set<string> | undefined;
  if (values["fast-track"]) {
    only = service.newHead(new Set(fresh));
    if (!only.size) {
      await report(fresh.map((purl) => ({ purl, state: "declined" })), budgetOf(service));
      console.log(JSON.stringify({ wall_s: Math.round((Date.now() - t0) / 1000), pulled: requests.length, taken: taken.length, ran: false, next: service.newLine()[0]?.purl }));
      return;
    }
  }
  if (values.taken) {
    mkdirSync(dirname(values.taken), { recursive: true });
    writeFileSync(values.taken, JSON.stringify({ requests }));
  }
  const followed = [...(only ?? fresh)];
  const tick = () => report(followed.flatMap((p) => progressOf(service, p) ?? []));
  const first = setTimeout(tick, 1000);
  const every = setInterval(tick, 5000);
  const result = await service.drain(
    t0 + Number(values.minutes ?? 240) * 60_000,
    Number(values["grace-minutes"] ?? 10) * 60_000,
    500,
    only,
  ).finally(() => (clearTimeout(first), clearInterval(every)));
  // What finished is published by this run's deploy; a job still running past the grace period stays `running` (its
  // partial status is published, and the next run resumes it); what did not start waits as before.
  await report(followed.flatMap((p) => progressOf(service, p) ?? []), budgetOf(service));
  const statuses = writeStatuses(service);
  const states: Record<string, number> = {};
  for (const j of service.jobs.values()) states[j.state] = (states[j.state] ?? 0) + 1;
  console.log(JSON.stringify({ wall_s: Math.round((Date.now() - t0) / 1000), pulled: requests.length, taken: taken.length, ...result, statuses, states, ran: true, ...(only ? { only: [...only] } : {}) }));
}

/** Tells the gateway what a deployed run took (with the demand it counted), so it stops holding them. */
async function ack(file: string): Promise<void> {
  const g = gateway();
  const { requests } = JSON.parse(readFileSync(file, "utf8")) as Pulled;
  if (!g || !requests.length) return;
  const res = await fetch(`${g.url}/internal/ack`, { method: "POST", headers: g.headers, body: JSON.stringify({ requests }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`gateway ack: HTTP ${res.status}`);
  console.log(JSON.stringify(await res.json()));
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "ack" ? ack(rest[0] ?? "") : drain(process.argv.slice(2)))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
