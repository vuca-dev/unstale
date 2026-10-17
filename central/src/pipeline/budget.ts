// The scheduled pipeline's share of the coverage budget. Each release, guide or docs note that will reach the
// extraction model is charged its release-note tokens against the same period budget the onboarding service spends
// (`onboarding/budget.json`), and against the technology's quarterly tokens, before any model call. A note whose
// extraction is already in the cache under the current model and prompts (`releaseCached`) is free. A note refused by
// the period budget, or past the technology's quarterly cap, is deferred: it is not extracted this run and is charged
// when it runs. Past the cap a technology's notes go last: the CLI runs those technologies a second time, cap lifted,
// only while the period budget lasts.
import { join } from "node:path";
import { DailyBudget, limitsFromEnv, noteTokens, quarterKey, type Limits } from "../onboarding/limits.ts";
import { centralDir } from "./paths.ts";
import { readJson, writeAtomic } from "./util.ts";

export type Charge = "ok" | "cached" | "budget" | "cap";

export class PipelineBudget {
  readonly limits: Limits;
  private readonly budget: DailyBudget;
  private readonly quarters: string;
  constructor(limits: Limits = limitsFromEnv(), quarters = join(centralDir(), "budget", "quarters.json"), budgetFile?: string) {
    this.limits = limits;
    this.budget = budgetFile ? new DailyBudget(limits, budgetFile) : new DailyBudget(limits);
    this.quarters = quarters;
  }

  /** Whether a note may be extracted now; spends its tokens unless its extraction is cached. */
  charge(tech: string, notes: string, cached: boolean, liftCap = false, now = Date.now()): Charge {
    if (cached) return "cached";
    const cost = noteTokens(notes);
    const all = readJson<Record<string, { key: string; tokens: number }>>(this.quarters) ?? {};
    const key = quarterKey(now);
    const q = all[tech]?.key === key ? all[tech]! : { key, tokens: 0 };
    const cap = this.limits.techQuarterTokens;
    // The first note of a quarter always passes, so one note larger than the cap cannot block a technology.
    if (!liftCap && cap > 0 && q.tokens > 0 && q.tokens + cost > cap) return "cap";
    if (this.budget.spend(cost, now)) return "budget";
    all[tech] = { key, tokens: q.tokens + cost };
    writeAtomic(this.quarters, JSON.stringify(all, null, 1) + "\n");
    return "ok";
  }

  /** Release-note tokens left in this period. */
  tokensLeft(now = Date.now()): number {
    return this.budget.tokensLeft(now);
  }
}
