// Site-wide template changes: when several pages of one site (by default its host) change with the identical diff in the
// same run (a renderer or chrome change), report them as one template event, not as page changes.
import { sha256 } from "./normalize.ts";
import type { CheckResult } from "./schema.ts";

export interface TemplateEvent {
  host: string;
  signature: string;
  ids: string[];
  added: string[];
  removed: string[];
}

/**
 * `siteOf` groups pages by site rather than host where one host serves several sites; the event's `host` field then
 * holds that site key.
 */
export function findTemplateChanges(results: readonly CheckResult[], minPages = 3, siteOf: (r: CheckResult) => string = (r) => new URL(r.url).host): TemplateEvent[] {
  const groups = new Map<string, TemplateEvent>();
  for (const r of results) {
    if (r.outcome.status !== "changed") continue;
    const { added, removed } = r.outcome.diff;
    const host = siteOf(r);
    const signature = sha256(JSON.stringify([[...added].sort(), [...removed].sort()])).slice(0, 16);
    const key = `${host} ${signature}`;
    const g = groups.get(key) ?? { host, signature, ids: [], added, removed };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.ids.length >= minPages);
}
