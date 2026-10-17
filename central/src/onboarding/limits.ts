// Abuse limits and the coverage budget. A new technology costs crawling and model calls only when it drains, so entry is
// cheap: an anonymous client may register a few hundred per hour (enough for a large repository in one pass), and votes
// on known ones have a bucket of their own so they never spend that allowance. Every accepted request is queued, never
// refused for budget. The budget limits how fast
// the queue drains: at most a fixed number of new technologies and job runs per UTC day, and at most a number of
// release-note tokens per period (the expected-cost unit: note volume is read from the release index before any model
// call). Asking about a known technology is never refused. The budget is the one check that fails closed: a budget file
// that exists but
// cannot be read refuses. Client addresses live in memory only and are never logged or written.
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { centralDir } from "../pipeline/paths.ts";
import { writeAtomic } from "../pipeline/util.ts";
import type { Refusal } from "./requesters.ts";
export { AddressLimiter, Voters, type Refusal } from "./requesters.ts";

export interface Limits {
  /** New technologies one client address may register per hour. */
  perAddressPerHour: number;
  /** Votes (requests for a known technology) one client address may cast per hour; over it they are not counted. */
  votesPerAddressPerHour: number;
  /** New technologies accepted per UTC day, all clients together. */
  newPerDay: number;
  /** Job runs (first analysis, retries and refreshes) started per UTC day. */
  runsPerDay: number;
  /** Proxies in front of the service whose `X-Forwarded-For` entry is trusted; 0 reads the socket address. */
  trustProxy: number;
  /** Release-note tokens (characters / 4) extracted per period, all technologies together; 0 stops extraction. */
  tokensPerPeriod: number;
  period: Period;
  /** Release-note tokens one technology may use per calendar quarter before the rest waits behind other technologies. */
  techQuarterTokens: number;
}

export type Period = "day" | "week" | "month";

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
};
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    perAddressPerHour: int(env.UNSTALE_RATE_PER_HOUR, 250),
    votesPerAddressPerHour: int(env.UNSTALE_VOTES_PER_HOUR, 1000),
    newPerDay: int(env.UNSTALE_NEW_PER_DAY, 100),
    runsPerDay: int(env.UNSTALE_RUNS_PER_DAY, 1000),
    trustProxy: env.UNSTALE_TRUST_PROXY === "true" ? 1 : int(env.UNSTALE_TRUST_PROXY, 0),
    tokensPerPeriod: int(env.UNSTALE_BUDGET_TOKENS, 1_000_000),
    period: (["day", "week", "month"] as const).find((p) => p === env.UNSTALE_BUDGET_PERIOD) ?? "day",
    techQuarterTokens: int(env.UNSTALE_TECH_QUARTER_TOKENS, 50_000),
  };
}

/** Expected-cost units of a release note: about four characters per token. */
export const noteTokens = (text: string): number => Math.ceil(text.length / 4);

/** The UTC period a time falls in: `2026-10-16`, ISO week `2026-W42`, or `2026-10`. */
export function periodKey(period: Period, now = Date.now()): string {
  const d = new Date(now);
  if (period === "day") return d.toISOString().slice(0, 10);
  if (period === "month") return d.toISOString().slice(0, 7);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The first moment of the next period (UTC). */
export function nextPeriod(period: Period, now = Date.now()): number {
  const d = new Date(now);
  if (period === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (8 - (d.getUTCDay() || 7)));
}

/** The calendar quarter a time falls in, `2026-Q4`. */
export const quarterKey = (now = Date.now()): string => {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
};

/** The client's address: the socket peer, or with `trustProxy` hops the entry the nearest trusted proxy appended. */
export function clientAddress(req: IncomingMessage, trustProxy: number): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy) return peer;
  const header = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // Entries left of the trusted ones are whatever the client sent, so the client's own is counted from the right.
  return hops[hops.length - trustProxy] ?? peer;
}



interface BudgetFile {
  day: string;
  new: number;
  runs: number;
  /** The token period these tokens belong to (absent in files written before the token budget). */
  period?: string;
  tokens?: number;
}
const secondsToNextDay = (now: number) => Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);

/** A budget limit that holds work back, and when it resets (ISO time). `unreadable`: the budget file cannot be read
 * (fail closed); it has no reset time, since it holds until someone fixes the file. */
export interface Hold {
  limit: "tokens" | "new_per_day" | "runs_per_day" | "unreadable";
  cap?: number;
  resets?: string;
}

/** Counters per UTC day and tokens per period, persisted under the central store so a restart does not reset them. */
export class DailyBudget {
  private announced = "";
  private readonly limits: Pick<Limits, "newPerDay" | "runsPerDay"> & Partial<Pick<Limits, "tokensPerPeriod" | "period">>;
  private readonly path: string;
  constructor(
    limits: Pick<Limits, "newPerDay" | "runsPerDay"> & Partial<Pick<Limits, "tokensPerPeriod" | "period">>,
    path = join(centralDir(), "onboarding", "budget.json"),
  ) {
    this.limits = limits;
    this.path = path;
  }
  private get period(): Period {
    return this.limits.period ?? "day";
  }
  /** The stored counters for now, or undefined when the file exists but cannot be read (fail closed). */
  private read(now: number): BudgetFile | undefined {
    const day = new Date(now).toISOString().slice(0, 10);
    const period = periodKey(this.period, now);
    try {
      const stored = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as BudgetFile) : undefined;
      const file: BudgetFile = stored?.day === day ? { ...stored } : { day, new: 0, runs: 0, ...(stored?.period ? { period: stored.period, tokens: stored.tokens } : {}) };
      if (file.period !== period) {
        file.period = period;
        file.tokens = 0;
      }
      if (!Number.isFinite(file.new) || !Number.isFinite(file.runs) || !Number.isFinite(file.tokens)) throw new Error("bad counters");
      return file;
    } catch {
      console.error(`coverage budget unreadable at ${this.path}; refusing until it is fixed or the day changes`);
      return undefined;
    }
  }
  private announce(key: string, message: string) {
    if (this.announced === key) return;
    this.announced = key;
    console.log(message);
  }
  /** One unit of each kind, all or none: a refusal of one kind spends nothing. */
  take(kinds: "new" | "runs" | Array<"new" | "runs">, now = Date.now()): Refusal | undefined {
    const file = this.read(now);
    if (!file) return { limit: "budget", retryAfter: secondsToNextDay(now) };
    for (const kind of Array.isArray(kinds) ? kinds : [kinds]) {
      const cap = kind === "new" ? this.limits.newPerDay : this.limits.runsPerDay;
      if (file[kind] >= cap) {
        this.announce(`${file.day} ${kind}`, `coverage budget reached for ${file.day}: ${cap} ${kind === "new" ? "new technologies" : "job runs"}`);
        return { limit: "budget", retryAfter: secondsToNextDay(now), kind };
      }
    }
    for (const kind of Array.isArray(kinds) ? kinds : [kinds]) file[kind]++;
    writeAtomic(this.path, JSON.stringify(file));
    return undefined;
  }
  /** The limits at their cap now, each with when it resets. Any one keeps a new technology from starting (a new one
   * takes a run, a new-technology count and tokens), so the gateway reads a non-empty answer as "early runs are
   * pointless until the latest reset". */
  spent(now = Date.now()): Hold[] {
    const file = this.read(now);
    const tomorrow = new Date(nextPeriod("day", now)).toISOString();
    if (!file) return [{ limit: "unreadable" }];
    const out: Hold[] = [];
    const cap = this.limits.tokensPerPeriod;
    if (cap !== undefined && file.tokens! >= cap) out.push({ limit: "tokens", cap, resets: new Date(nextPeriod(this.period, now)).toISOString() });
    if (file.new >= this.limits.newPerDay) out.push({ limit: "new_per_day", cap: this.limits.newPerDay, resets: tomorrow });
    if (file.runs >= this.limits.runsPerDay) out.push({ limit: "runs_per_day", cap: this.limits.runsPerDay, resets: tomorrow });
    return out;
  }
  /** Release-note tokens left in this period; 0 when the file cannot be read (fail closed). Unlimited without a cap. */
  tokensLeft(now = Date.now()): number {
    const cap = this.limits.tokensPerPeriod;
    if (cap === undefined) return Infinity;
    const file = this.read(now);
    return file ? Math.max(0, cap - file.tokens!) : 0;
  }
  /** Spends tokens for one note. The first spend of a period always passes, so one note larger than the whole budget
   * cannot stall the queue (overshoot is bounded by one note). A refused spend closes the period: what is left is less
   * than the next note, and the queue waits for the next period instead of restarting the same job. */
  spend(tokens: number, now = Date.now()): Refusal | undefined {
    const cap = this.limits.tokensPerPeriod;
    if (cap === undefined) return undefined;
    const file = this.read(now);
    const retryAfter = Math.ceil((nextPeriod(this.period, now) - now) / 1000);
    if (!file) return { limit: "budget", retryAfter, kind: "tokens" };
    if (cap === 0 || (file.tokens! > 0 && file.tokens! + tokens > cap)) {
      this.announce(`${file.period} tokens`, `coverage budget reached for ${file.period}: ${cap} release-note tokens`);
      if (file.tokens! < cap) {
        file.tokens = cap;
        writeAtomic(this.path, JSON.stringify(file));
      }
      return { limit: "budget", retryAfter, kind: "tokens" };
    }
    file.tokens = file.tokens! + tokens;
    writeAtomic(this.path, JSON.stringify(file));
    return undefined;
  }
}

