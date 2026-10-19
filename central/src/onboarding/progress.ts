// The pace of a coverage run's progress reports to the gateway (drain.ts): each report is a request to the gateway's
// Worker, whose free plan allows 100,000 a day for everything it serves.
import type { CoverageService, Place } from "./service.ts";

/** `waiting`: this run took the package and it waits in the run's queue, at the place and estimate reported. */
export type RunState = "waiting" | "running" | "publishing";

/** How often a run looks at its progress, and the longest it leaves the gateway without a report while it follows
 * packages (well inside the gateway's RUN_SILENT_MS, 30 minutes, after which it calls a run silent). */
export const PROGRESS_EVERY_MS = 5000;
export const PROGRESS_HEARTBEAT_MS = 5 * 60_000;

/** A progress tick that reports only the packages whose report changed since it was last delivered, and every
 * package after PROGRESS_HEARTBEAT_MS: each report is a Worker request, and a run waiting on docs sites changes nothing
 * for minutes at a time. `key` is what counts as a change (by default the whole update): a waiting package's place moves
 * with every start, so its key leaves the place out and the heartbeat carries it. `send` resolves whether the report
 * was delivered: what was not is sent again at the next tick. */
export function progressTicker<U extends { purl: string }>(
  updates: () => U[],
  send: (updates: U[]) => Promise<boolean>,
  now = () => Date.now(),
  key: (u: U) => string = (u) => JSON.stringify(u),
): () => Promise<unknown> {
  const delivered = new Map<string, string>();
  let beat: number | undefined;
  return () => {
    const current = updates();
    const heartbeat = beat === undefined || now() - beat >= PROGRESS_HEARTBEAT_MS;
    const keyed = current.map((u) => [u, key(u)] as const);
    const changed = heartbeat ? keyed : keyed.filter(([u, k]) => delivered.get(u.purl) !== k);
    if (!changed.length && !heartbeat) return Promise.resolve(undefined);
    // Kept while in flight, so a tick meanwhile does not send it twice; forgotten if it is not delivered.
    const at = now();
    const mine = new Map(changed.map(([u, k]) => [u.purl, k]));
    for (const [purl, k] of mine) delivered.set(purl, k);
    const beatBefore = beat;
    if (heartbeat) beat = at;
    return send(changed.map(([u]) => u)).then((ok) => {
      if (ok) return;
      for (const [purl, k] of mine) if (delivered.get(purl) === k) delivered.delete(purl);
      if (heartbeat && beat === at) beat = beatBefore;
    });
  };
}

/** What counts as a change of an update: a waiting package's state only (its place is carried by the heartbeat). */
export const progressKey = (u: { purl: string; state: RunState; job?: Record<string, unknown> }) =>
  u.state === "waiting" ? `${u.purl} waiting` : JSON.stringify(u);

/** A pulled package's job as the gateway shows it: the job that works it (a merged package's is its technology's),
 * once this run started it. A job queued again between its slices is still reported: left out, the gateway would go on
 * showing the last report it kept, or after a restart of its object an older one. `updated` (the job's last save)
 * orders the reports; `publishBy` is when this cycle publishes at the latest, and with it the records counted. */
export function progressOf(
  service: Pick<CoverageService, "jobs" | "working">,
  purl: string,
  publishBy: string,
  waiting: Map<string, Place> = new Map(),
): { purl: string; state: RunState; job: Record<string, unknown> } | undefined {
  const own = service.jobs.get(purl);
  const job = (own?.merged_into && service.jobs.get(own.merged_into)) || own;
  if (!job) return undefined;
  // Records from the token-free first pass alone (advisories published while the job waits) do not start it.
  const started = service.working(job.purl) || job.state !== "queued" || (job.records > 0 && !job.advisories_first) || !!job.completed?.length || !!job.interrupted;
  // Taken, not started yet: its place in this run's queue and when the run is estimated to reach it, the one place a
  // client is shown (the gateway's own line is only the order it holds requests in).
  const place = waiting.get(job.purl);
  if (!started && place)
    return {
      purl,
      state: "waiting",
      job: {
        state: job.state,
        stage: place.stage,
        records: 0,
        releases_done: 0,
        releases_total: 0,
        docs_done: 0,
        docs_total: 0,
        // The time of this estimate (central's clock), so a client orders it before the run's later reports.
        updated: new Date().toISOString(),
        queue_position: place.position,
        queue_length: place.length,
        ...(place.starts_at && { starts_at: place.starts_at }),
      },
    };
  if (!started) return undefined;
  const { state, stage, records, releases_done, releases_total, docs_done, docs_total, updated } = job;
  return {
    purl,
    // Queued again between slices: still this run's (its stage says why it waits).
    state: service.working(job.purl) || job.state === "queued" ? "running" : "publishing",
    job: { state, stage, records, releases_done, releases_total, docs_done, docs_total, updated, publish_by: publishBy },
  };
}

/** The longest a cycle's publish (export, verify, pack, deploy) takes after its drain ends: measured at under a minute
 * (ingest-cycles.sh), so a client is never told a time before which the records cannot be there. */
export const PUBLISH_MS = 3 * 60_000;

/** Whether a drain should end now so its cycle publishes: it pulled packages new to central, and each has a firm
 * decision (drain.ts, early publish). */
export function earlyDue(service: Pick<CoverageService, "decided">, fresh: ReadonlySet<string>): boolean {
  if (!fresh.size) return false;
  for (const p of fresh) if (!service.decided(p)) return false;
  return true;
}
