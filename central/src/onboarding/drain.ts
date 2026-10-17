// Coverage in batch mode, for an ephemeral runner (vault: Central Scheduling and Infrastructure, "Registration
// gateway"). The gateway accepts registrations and holds them; this pulls them, works the same queue the service
// works (refreshes and admitted history first, then new technologies by demand, all under the coverage budget), and
// writes every job's public status for the static catalog. The pulled packages are acknowledged only after the deploy
// that publishes their status (`drain ack`), so a failed run loses no request.
//
// `--fast-track` (a run the gateway started for a new package): requests are queued as always, but a job runs only if
// a pulled package is next in the line of new technologies (most requested first, then first asked); then only those
// at the head of the line run. Otherwise nothing runs and the final line says `"ran": false`, and the workflow saves
// nothing, so the gateway keeps the request for the next scheduled run. Refreshes are the schedule's.
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
  // Fast-track: the pulled new packages at the head of the line of new technologies, in order; none when another
  // package is ahead of them.
  let only: Set<string> | undefined;
  if (values["fast-track"]) {
    only = service.newHead(new Set(taken.filter((p) => !known.has(p))));
    if (!only.size) {
      console.log(JSON.stringify({ wall_s: Math.round((Date.now() - t0) / 1000), pulled: requests.length, taken: taken.length, ran: false, next: service.newLine()[0]?.purl }));
      return;
    }
  }
  if (values.taken) {
    mkdirSync(dirname(values.taken), { recursive: true });
    writeFileSync(values.taken, JSON.stringify({ requests }));
  }
  const result = await service.drain(
    t0 + Number(values.minutes ?? 240) * 60_000,
    Number(values["grace-minutes"] ?? 10) * 60_000,
    500,
    only,
  );
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
