// The usage log by phase (`npm run catalog -- usage`): what technologies' first coverage cost (onboarding) apart from
// what keeping them current costs (monitoring), so the ongoing cost per technology-year is read off a run, not
// guessed from a mix of both. Dollars are the provider's own reported charge where a line has one (llm.ts, `dollars`);
// otherwise they are estimated from the repository's price list (eval/select/prices.json: USD per million tokens, by
// provider and model, or the provider's only entry; Jev reports no charge) and counted in `estimated_calls`. A call
// with tokens and no price is counted in `unpriced_calls`, never priced at zero silently.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { centralDir, REPO_ROOT } from "./paths.ts";
import { TECHNOLOGIES } from "./technologies.ts";
import { readJson } from "./util.ts";

export interface PhaseTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  dollars: number;
  /** Calls priced from the price list (no charge reported). */
  estimated_calls: number;
  /** Calls with tokens and no price. */
  unpriced_calls: number;
}

/** One model's price, USD per million tokens (eval/select/prices.json); null: unknown. */
export interface Price {
  provider: string;
  model: string;
  input: number | null;
  cached_input?: number | null;
  output: number | null;
}

export function loadPrices(path = join(REPO_ROOT, "eval", "select", "prices.json")): Price[] {
  return readJson<{ models: Price[] }>(path)?.models ?? [];
}

/** A line's estimated dollars from the price list, or undefined when its price is unknown. Cached input without a
 * cached price is billed at the input price (an upper bound), as the price list says. */
export function estimate(prices: Price[], l: Record<string, unknown>): number | undefined {
  const own = prices.filter((p) => p.provider === l.api);
  const p = own.find((p) => p.model === l.model) ?? (own.length === 1 ? own[0] : undefined);
  if (!p || p.input === null || p.output === null) return undefined;
  const input = Number(l.input_tokens ?? 0);
  const cached = Math.min(input, Number(l.cached_input_tokens ?? 0));
  return ((input - cached) * p.input + cached * (p.cached_input ?? p.input) + Number(l.output_tokens ?? 0) * p.output) / 1e6;
}
export interface PhaseSummary {
  providers: Record<string, PhaseTotals>;
  total: PhaseTotals;
  /** Distinct technologies with a line in this phase. */
  technologies: number;
}
export interface UsageByPhase {
  /** The first and last time of the lines that carry a phase, and the days between them: lines written before phases
   * were recorded (`unattributed`) are outside it, so a per-year figure scales by the time phases were measured over,
   * not by the whole log (the log holds the current UTC month). */
  window: { from: string | null; to: string | null; days: number };
  /** Lines written before phases were recorded are `unattributed`. */
  phases: Record<string, PhaseSummary>;
  /** Technologies whose first coverage finished in the window (`onboarded` milestones). */
  onboarded: number;
  /** Technologies monitored now: the catalog technologies and every monitored onboarding job. */
  monitored: number;
  /** Onboarding's total over the technologies it finished; null when none did. */
  per_onboarded_technology: { dollars: number; input_tokens: number; output_tokens: number } | null;
  /** Monitoring's total per monitored technology, scaled from the window to a year; null without a window. */
  monitoring_per_technology_year: { dollars: number; input_tokens: number; output_tokens: number } | null;
}

const zero = (): PhaseTotals => ({ calls: 0, input_tokens: 0, output_tokens: 0, dollars: 0, estimated_calls: 0, unpriced_calls: 0 });
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** The technologies monitored now: the catalog's own and the onboarding jobs in `monitoring` (not merged into another). */
export function monitoredTechnologies(): number {
  const ids = new Set(Object.keys(TECHNOLOGIES));
  const folder = join(centralDir(), "onboarding", "jobs");
  if (existsSync(folder))
    for (const f of readdirSync(folder).filter((f) => f.endsWith(".json"))) {
      const job = readJson<{ state?: string; technology?: string; merged_into?: string }>(join(folder, f));
      if (job?.state === "monitoring" && !job.merged_into && job.technology) ids.add(job.technology);
    }
  return ids.size;
}

export function usageByPhase(lines: Record<string, unknown>[], monitored: number, prices: Price[] = []): UsageByPhase {
  const phases: Record<string, PhaseSummary> = {};
  const techs: Record<string, Set<string>> = {};
  const onboarded = new Set<string>();
  const times = lines.filter((l) => typeof l.phase === "string").map((l) => l.at).filter((t): t is string => typeof t === "string").sort();
  for (const l of lines) {
    const phase = typeof l.phase === "string" ? l.phase : "unattributed";
    if (l.milestone === "onboarded" && typeof l.tech === "string") onboarded.add(l.tech);
    if (typeof l.api !== "string") continue;
    const p = (phases[phase] ??= { providers: {}, total: zero(), technologies: 0 });
    if (typeof l.tech === "string") (techs[phase] ??= new Set()).add(l.tech);
    const tokens = Number(l.input_tokens ?? 0) + Number(l.output_tokens ?? 0);
    const estimated = typeof l.dollars === "number" || !tokens ? undefined : estimate(prices, l);
    for (const b of [(p.providers[l.api] ??= zero()), p.total]) {
      b.calls++;
      b.input_tokens += Number(l.input_tokens ?? 0);
      b.output_tokens += Number(l.output_tokens ?? 0);
      if (typeof l.dollars === "number") b.dollars += l.dollars;
      else if (estimated !== undefined) {
        b.dollars += estimated;
        b.estimated_calls++;
      } else if (tokens) b.unpriced_calls++;
    }
  }
  for (const [phase, p] of Object.entries(phases)) {
    p.technologies = techs[phase]?.size ?? 0;
    for (const b of [...Object.values(p.providers), p.total]) b.dollars = round(b.dollars, 6);
  }
  const from = times[0] ?? null;
  const to = times.at(-1) ?? null;
  const days = from && to ? round((Date.parse(to) - Date.parse(from)) / 86_400_000, 3) : 0;
  const per = (t: PhaseTotals, n: number, scale: number) => ({
    dollars: round((t.dollars / n) * scale, 6),
    input_tokens: Math.round((t.input_tokens / n) * scale),
    output_tokens: Math.round((t.output_tokens / n) * scale),
  });
  const onboarding = phases.onboarding?.total ?? zero();
  const monitoring = phases.monitoring?.total ?? zero();
  return {
    window: { from, to, days },
    phases,
    onboarded: onboarded.size,
    monitored,
    per_onboarded_technology: onboarded.size ? per(onboarding, onboarded.size, 1) : null,
    monitoring_per_technology_year: days > 0 && monitored ? per(monitoring, monitored, 365 / days) : null,
  };
}

/** Current Actions run only, so a monthly cumulative total cannot masquerade as this run's spend. */
export function jevAttribution(lines: Record<string, unknown>[], prices: Price[], run = process.env.GITHUB_RUN_ID): object {
  const calls = lines.filter((l) => l.api === "jev" && (!run || l.run === run)
    && (!run || l.run_attempt === (process.env.GITHUB_RUN_ATTEMPT ?? "1")));
  const groups = new Map<string, { phase: string; technology: string; stage: string; source: string; calls: number; input_tokens: number; dollars: number; unpriced_calls: number }>();
  for (const l of calls) {
    const dims = { phase: String(l.phase ?? "unknown"), technology: String(l.technology ?? l.tech ?? "unknown"), stage: String(l.stage ?? "unknown"), source: String(l.source ?? "unknown") };
    const key = JSON.stringify(dims);
    const g = groups.get(key) ?? { ...dims, calls: 0, input_tokens: 0, dollars: 0, unpriced_calls: 0 };
    g.calls++;
    g.input_tokens += Number(l.input_tokens ?? 0);
    const dollars = typeof l.dollars === "number" ? l.dollars : estimate(prices, l);
    if (dollars === undefined) g.unpriced_calls++;
    else g.dollars += dollars;
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.input_tokens - a.input_tokens);
  return {
    scope: run ? "actions_run" : "retained_log", run: run ?? null,
    dollars: round(ranked.reduce((n, g) => n + g.dollars, 0), 6),
    unpriced_calls: ranked.reduce((n, g) => n + g.unpriced_calls, 0),
    stages: Object.fromEntries([...new Set(ranked.map((g) => g.stage))].map((stage) => {
      const rows = ranked.filter((g) => g.stage === stage);
      return [stage, { calls: rows.reduce((n, g) => n + g.calls, 0), input_tokens: rows.reduce((n, g) => n + g.input_tokens, 0) }];
    })),
    calls: calls.length, input_tokens: calls.reduce((n, l) => n + Number(l.input_tokens ?? 0), 0),
    top: ranked.slice(0, 10).map((g) => ({ ...g, dollars: round(g.dollars, 6) })),
    // At most one sample per request, including when the same batch was retried.
    samples: [...new Map(calls.filter((l) => l.sample).map((l) => [l.request, { technology: l.technology, stage: l.stage, source: l.source, ...l.sample as object }])).values()].slice(-8),
  };
}
