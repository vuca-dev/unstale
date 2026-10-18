// The pace of a coverage run's progress reports to the gateway (drain.ts): each report is a request to the gateway's
// Worker, whose free plan allows 100,000 a day for everything it serves.

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
