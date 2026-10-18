// The pace of a coverage run's progress reports to the gateway (drain.ts): each report is a request to the gateway's
// Worker, whose free plan allows 100,000 a day for everything it serves.
import type { CoverageService } from "./service.ts";

export type RunState = "running" | "publishing";

/** How often a run looks at its progress, and the longest it leaves the gateway without a report while it follows
 * packages (well inside the gateway's RUN_SILENT_MS, 30 minutes, after which it calls a run silent). */
export const PROGRESS_EVERY_MS = 5000;
export const PROGRESS_HEARTBEAT_MS = 5 * 60_000;

/** A progress tick that reports only what changed since the last report, or after PROGRESS_HEARTBEAT_MS: each report
 * is a Worker request, and a run waiting on docs sites changes nothing for minutes at a time. */
/** `send` resolves whether the report was delivered: one that was not is sent again at the next tick. */
export function progressTicker<U>(updates: () => U[], send: (updates: U[]) => Promise<boolean>, now = () => Date.now()): () => Promise<unknown> {
  let last: { body: string; at: number } | undefined;
  return () => {
    const current = updates();
    const body = JSON.stringify(current);
    if (last && last.body === body && now() - last.at < PROGRESS_HEARTBEAT_MS) return Promise.resolve(undefined);
    // Kept while in flight, so a tick meanwhile does not send it twice; forgotten if it is not delivered.
    const sent = (last = { body, at: now() });
    return send(current).then((ok) => {
      if (!ok && last === sent) last = undefined;
    });
  };
}

/** A pulled package's job as the gateway shows it: the job that works it (a merged package's is its technology's),
 * once this run started it. A job queued again between its slices is still reported: left out, the gateway would go on
 * showing the last report it kept, or after a restart of its object an older one. `updated` (the job's last save)
 * orders the reports; `publishBy` is when this cycle publishes at the latest, and with it the records counted. */
export function progressOf(service: Pick<CoverageService, "jobs" | "working">, purl: string, publishBy: string): { purl: string; state: RunState; job: Record<string, unknown> } | undefined {
  const own = service.jobs.get(purl);
  const job = (own?.merged_into && service.jobs.get(own.merged_into)) || own;
  const started = job && (service.working(job.purl) || job.state !== "queued" || job.records > 0 || !!job.completed?.length || !!job.interrupted);
  if (!job || !started) return undefined;
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
