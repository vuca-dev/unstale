// Aggregate server-side registration outcomes only. No addresses, package lists, IDs or events.
export const OUTCOMES = ["accepted", "vote_counted", "duplicate", "vote_address_limited", "vote_global_limited", "refused_address", "refused_budget", "package_not_found", "registry_unavailable"] as const;
export type DemandOutcome = typeof OUTCOMES[number];
export type Traffic = "unmarked" | "marked_internal";
type Counts = Partial<Record<DemandOutcome, number>>;
export interface DemandDay { day: string; unmarked: Counts; marked_internal: Counts }
export interface DemandSnapshot { since: string; days: DemandDay[] }
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

export class Demand {
  private snapshot: DemandSnapshot = { since: new Date().toISOString(), days: [] };
  restore(snapshot: DemandSnapshot | undefined): void {
    if (snapshot) this.snapshot = structuredClone(snapshot);
  }
  count(outcome: DemandOutcome, traffic: Traffic, now: number, n = 1): void {
    const day = this.day(now);
    day[traffic][outcome] = (day[traffic][outcome] ?? 0) + n;
  }
  private day(now: number): DemandDay {
    const day = dayOf(now);
    // Retain today and the preceding 89 UTC days, including across idle periods.
    const cutoff = dayOf(now - 89 * 86_400_000);
    this.snapshot.days = this.snapshot.days.filter((d) => d.day >= cutoff && d.day <= day);
    let row = this.snapshot.days.find((d) => d.day === day);
    if (!row) { row = { day, unmarked: {}, marked_internal: {} }; this.snapshot.days.push(row); }
    return row;
  }
  read(now: number): DemandSnapshot {
    this.day(now);
    return structuredClone(this.snapshot);
  }
}
