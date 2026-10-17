// Applies the registry check (registry.ts) to records: at ingest to incoming records, and once to a store built before
// the check existed. Each checked record's history says what was checked and what moved.
import type { Incoming } from "./extract.ts";
import { applyChecks, checkNames, type Fetcher, type RegistryCheck } from "./registry.ts";
import { applyChange, union, type StoredRecord, type TechStore } from "./store.ts";

const npmNames = (ps: Array<{ ecosystem: string; name: string }>) => ps.filter((p) => p.ecosystem === "npm").map((p) => p.name);

export const checkDetail = (names: string[], checks: Map<string, RegistryCheck>, missing: string[]): string =>
  `npm registry: ${[...new Set(names)].sort().map((n) => `${n} ${checks.get(n)?.status ?? "unchecked"}`).join(", ")}` +
  (missing.length ? `; moved to conditions: ${[...new Set(missing)].join(", ")}` : "");

/** Incoming records before ingest: missing names move to `conditions`; `registry` keeps the history line. */
export async function checkIncoming(incoming: Array<Incoming & { registry?: string }>, fetcher?: Fetcher): Promise<number> {
  const checks = await checkNames(incoming.flatMap((i) => npmNames(i.prerequisites)), fetcher);
  let moved = 0;
  for (const inc of incoming) {
    const names = npmNames(inc.prerequisites);
    if (!names.length) continue;
    const { keep, prose, missing } = applyChecks(inc.prerequisites, checks);
    inc.prerequisites = keep;
    inc.conditions = union(inc.conditions, prose);
    inc.registry = checkDetail(names, checks, missing);
    moved += missing.length;
  }
  return moved;
}

export interface StoreCheck {
  records: number;
  names: string[];
  missing: Array<{ id: string; name: string; prose: string }>;
  revisionBumps: number;
}

/**
 * A store's active records: each record with npm prerequisites gets one `prerequisite-check` history line (skipped
 * when its last one says the same). A missing name leaves `prerequisites` (a revision field, so `revision` rises) and
 * joins `conditions` as prose.
 */
export async function checkStore(s: TechStore, fetcher?: Fetcher): Promise<StoreCheck> {
  const active = Object.values(s.records).filter((r) => r.status === "active");
  const all = active.flatMap((r) => npmNames(r.prerequisites));
  const checks = await checkNames(all, fetcher);
  const out: StoreCheck = { records: 0, names: [...new Set(all)].sort(), missing: [], revisionBumps: 0 };
  for (const r of active as StoredRecord[]) {
    const names = npmNames(r.prerequisites);
    if (!names.length) continue;
    out.records++;
    const { keep, prose, missing } = applyChecks(r.prerequisites, checks);
    const detail = checkDetail(names, checks, missing);
    missing.forEach((name, i) => out.missing.push({ id: r.id, name, prose: prose[i]! }));
    if (r.history.findLast((h) => h.action === "prerequisite-check")?.detail === detail) continue;
    const moved = applyChange(r, missing.length ? { prerequisites: keep, conditions: union(r.conditions, prose) } : {}, "prerequisite-check", { detail });
    if (moved.revision) out.revisionBumps++;
  }
  return out;
}
