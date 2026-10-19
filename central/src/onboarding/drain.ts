// Coverage in batch mode, for an ephemeral runner. The gateway accepts registrations and holds them; this pulls them,
// works the same queue the service works (refreshes and admitted history first, then new technologies by demand, ties
// broken by adoption, all under the coverage budget; a waiting new technology always gets one slot in three, see
// `newSlots`), and writes every job's public status for the static catalog. The pulled packages are acknowledged only
// after the deploy that publishes their status (`drain ack`), so a failed run loses no request.
//
// One drain is one cycle of a run (ingest.yml): it ends at `--minutes` or when nothing more can start, and the run then
// publishes what it did (export, deploy, state save, acknowledgement) before the next cycle, so a package is published
// within a cycle of being worked, not at the end of the run.
//
// Pulls: the gateway's queue is read at the start and every `--pull-minutes` while the drain works, so a registration
// that arrives mid-run joins this run's queue in minutes; each pull adds only what grew since the last one (taken.ts).
// Each pull also tells the gateway when this run pulls next (`pulls.next`), and the gateway starts no early run while a
// run is pulling: it would only wait behind this one. `drain idle` (the run's last step) says it pulls no more; the
// gateway then starts the early run it held back, if a new package asked for one meanwhile.
//
// Progress: a run reports the new packages it pulled to the gateway: `waiting` from the pull on, with their place in
// this drain's queue (by demand, in their line) and when the run is estimated to reach them (eta.ts: from measured
// throughput and the cycles, so a package the run will not reach this cycle is told the later time), then `running`
// and `publishing` with their public counters, so a client that asked for one sees one place and follows it until the
// deploy publishes its status. Only what changed is sent (looked at every 5 s), and everything at least every 5
// minutes (progressTicker; a waiting package's place goes with that heartbeat, not with every start; one not
// delivered is sent again). Best effort: a report that fails never stops the run.
//
// Budget: the final line names the budget limits that held work back (`held`: tokens or runs_per_day, each with its
// cap and reset time, or an unreadable budget file), so `"started": 0` is never unexplained. The last progress report
// also tells the gateway until when the budget is spent (`budget.spent_until`, the latest reset of the limits at their
// cap, null when none is), and the gateway starts no early run until then: it could start nothing. Sent on every
// drain, so a budget raised or reset clears it at the next one; registrations are still queued meanwhile.
// `drained: false` on the final line means the deadline ended the drain with work left.
//
// Slices that outlast a cycle: a job still running at the drain's end is killed with it and resumed by the next cycle,
// its work time kept. Resumed slices hold at most the slots admitted work may hold while a new technology waits, so
// they never take every slot; one that has worked 40 minutes (or spanned 4 cycles) without finishing is stopped, its
// stage named, and retried after 6 h (`stopped` on the final line).
//
// Rate limits (HTTP 429, from any service a job reads) are the runner's own request rate, not the package's: no
// failure is counted. Every start pauses (1 minute, doubling while 429s follow one another up to 15, at least the
// server's Retry-After), the job is retried after the pause, and the drain waits for it when the pause ends before the
// deadline. `rate_limited` on the final line counts jobs still paused; they are work left (`drained: false`).
//
//   npm run drain -- [--minutes 240] [--grace-minutes 10] [--concurrency 4] [--pull-minutes 5] [--taken <file>]
//   npm run drain -- ack <file>
//   npm run drain -- idle
// Gateway: UNSTALE_GATEWAY_URL and UNSTALE_GATEWAY_TOKEN; without them only the saved queue is worked.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { catalogDir, centralDir } from "../pipeline/paths.ts";
import { sha256, writeAtomic } from "../pipeline/util.ts";
import { CoverageService } from "./service.ts";
import { PROGRESS_EVERY_MS, PUBLISH_MS, progressKey, progressOf, progressTicker, type RunState } from "./progress.ts";
import { Taken, type Request } from "./taken.ts";

const gateway = () => {
  const url = process.env.UNSTALE_GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.UNSTALE_GATEWAY_TOKEN;
  return url && token ? { url, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } : undefined;
};

/** The gateway's rows read and written today against its free-tier allowance, as it reported them when this run pulled
 * the queue (later rows are in the acknowledgement's answer); printed in the run's final line. */
let gatewayUsage: unknown;

/** The gateway's queue; unreachable or malformed answers pull nothing (the saved queue is still worked). Logged once. */
let pullFailed = false;
async function pull(): Promise<Request[]> {
  const g = gateway();
  if (!g) return [];
  try {
    const res = await fetch(`${g.url}/internal/queue`, { headers: g.headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { requests?: Request[]; usage?: unknown };
    if (!Array.isArray(body.requests)) throw new Error("no requests array");
    gatewayUsage = body.usage;
    return body.requests.filter((r) => typeof r?.purl === "string" && Number.isFinite(r?.demand));
  } catch (e) {
    if (!pullFailed) console.error(`gateway queue not read (${e instanceof Error ? e.message : e}); working the saved queue only`);
    pullFailed = true;
    return [];
  }
}

/** The budget as the gateway reads it: spent until the latest reset of the limits at their cap, or null. An unreadable
 * budget has no reset, so it is reported as spent for the longest period (31 days); every run reports again, so the
 * first run after the file is fixed clears it. */
function budgetOf(service: CoverageService): { spent_until: string | null } {
  const held = service.spent();
  if (held.some((h) => !h.resets)) return { spent_until: new Date(Date.now() + 31 * 86_400_000).toISOString() };
  const resets = held.map((h) => h.resets!).sort();
  return { spent_until: resets.at(-1) ?? null };
}

interface Extra {
  budget?: { spent_until: string | null };
  /** When this run reads the queue next; null: it reads it no more. */
  pulls?: { next: string | null };
}

/** Where this run is with these pulled packages, for the clients that follow them, in requests of at most 500 (the
 * gateway's bound), the budget and the next pull with the first; failures are logged once. Returns the first answer. */
let reportFailed = false;
async function report(updates: { purl: string; state: RunState; job?: Record<string, unknown> }[], extra: Extra = {}): Promise<unknown> {
  return (await deliver(updates, extra)).first;
}
/** `report`, and whether the gateway took all of it (nothing to send counts as taken). */
async function deliver(updates: { purl: string; state: RunState; job?: Record<string, unknown> }[], extra: Extra = {}): Promise<{ ok: boolean; first?: unknown }> {
  const g = gateway();
  if (!g || (!updates.length && !extra.budget && !extra.pulls)) return { ok: true };
  let first: unknown;
  try {
    for (let i = 0; i === 0 || i < updates.length; i += 500) {
      const body = { updates: updates.slice(i, i + 500), ...(i === 0 ? extra : {}) };
      const res = await fetch(`${g.url}/internal/progress`, { method: "POST", headers: g.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (i === 0) first = await res.json().catch(() => undefined);
    }
  } catch (e) {
    if (!reportFailed) console.error(`gateway progress not reported (${e instanceof Error ? e.message : e}); the run continues`);
    reportFailed = true;
    return { ok: false, first };
  }
  return { ok: true, first };
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
    options: {
      minutes: { type: "string" },
      "grace-minutes": { type: "string" },
      concurrency: { type: "string" },
      "pull-minutes": { type: "string" },
      taken: { type: "string" },
    },
  });
  if (!existsSync(join(catalogDir(), "v1/root.json")))
    writeAtomic(join(catalogDir(), "v1/root.json"), JSON.stringify({ schema: 1, min_client: "0.1.0" }));
  const t0 = Date.now();
  const pullMs = Math.max(0, Number(values["pull-minutes"] ?? 5) || 0) * 60_000;
  // Jobs at once: the work is mostly waiting on docs sites (scale probe), so more than the server's default of 2.
  // Token-free first passes (advisories ahead of the release history) beside the slots: UNSTALE_ADVISORIES_FIRST at
  // once, default 2; 0 turns them off.
  const passes = Number(process.env.UNSTALE_ADVISORIES_FIRST ?? 2);
  const service = new CoverageService(Number(values.concurrency ?? 4) || 4, { advisoriesFirst: Number.isFinite(passes) ? passes : 2 }).hold();
  const taken = new Taken();
  let accepted = 0;
  // The new packages this drain pulled: their clients may be following them.
  const followed = new Set<string>();
  // The progress tick, once the drain works: a pull's new packages are reported waiting at once, at their place.
  let tick: (() => Promise<unknown>) | undefined;
  const take = async () => {
    const known = new Set(service.jobs.keys());
    const added = service.enqueue(taken.add(await pull()));
    accepted += added.length;
    for (const p of added) if (!known.has(p)) followed.add(p);
    if (values.taken) writeAtomic(values.taken, JSON.stringify({ requests: taken.requests() }));
    if (pullMs) await report([], { pulls: { next: new Date(Date.now() + pullMs).toISOString() } });
    await service.readAdoption();
    await tick?.();
  };
  await take();
  let pulling: Promise<void> | undefined;
  const again = pullMs
    ? setInterval(() => {
        pulling ??= take()
          .catch((e) => console.error(`pull failed: ${e instanceof Error ? e.message : e}`))
          .finally(() => (pulling = undefined));
      }, pullMs)
    : undefined;
  // The drain ends by its deadline and grace period, and the cycle then publishes what it did.
  const [minutes, grace] = [Number(values.minutes ?? 240), Number(values["grace-minutes"] ?? 10)];
  const publishBy = new Date(t0 + (minutes + grace) * 60_000 + PUBLISH_MS).toISOString();
  // Taken and not started yet: reported `waiting`, with their place in this drain's queue and its estimate (once per
  // tick, the queue computed once).
  const progress = () => {
    const waiting = service.waiting();
    return [...followed].flatMap((p) => progressOf(service, p, publishBy, waiting) ?? []);
  };
  const ticker = progressTicker(progress, async (u) => (await deliver(u)).ok, undefined, progressKey);
  tick = ticker;
  const first = setTimeout(ticker, 1000);
  const every = setInterval(ticker, PROGRESS_EVERY_MS);
  const result = await service
    .drain(t0 + minutes * 60_000, grace * 60_000, 500)
    .finally(() => (clearTimeout(first), clearInterval(every), clearInterval(again)));
  await pulling;
  // What finished is published by this cycle's deploy; a job still running past the grace period stays `running` (its
  // partial status is published, and the next cycle resumes it); what did not start waits as before.
  await report(progress(), { budget: budgetOf(service) });
  const statuses = writeStatuses(service);
  const states: Record<string, number> = {};
  for (const j of service.jobs.values()) states[j.state] = (states[j.state] ?? 0) + 1;
  console.log(JSON.stringify({ wall_s: Math.round((Date.now() - t0) / 1000), pulled: taken.size, taken: accepted, ...result, statuses, states, gateway: gatewayUsage, metrics: service.metrics() }));
}

/** Tells the gateway what a deployed run took (with the demand it counted), so it stops holding them. */
async function ack(file: string): Promise<void> {
  const g = gateway();
  const { requests } = JSON.parse(readFileSync(file, "utf8")) as { requests: Request[] };
  if (!g || !requests.length) return;
  const res = await fetch(`${g.url}/internal/ack`, { method: "POST", headers: g.headers, body: JSON.stringify({ requests }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`gateway ack: HTTP ${res.status}`);
  console.log(JSON.stringify(await res.json()));
}

/** The run's last word to the gateway: it pulls no more, so early runs may start again. */
async function idle(): Promise<void> {
  const answer = await report([], { pulls: { next: null } });
  if (answer !== undefined) console.log(JSON.stringify(answer));
}

const [cmd, ...rest] = process.argv.slice(2);
(cmd === "ack" ? ack(rest[0] ?? "") : cmd === "idle" ? idle() : drain(process.argv.slice(2)))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
