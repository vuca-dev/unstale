// robots.txt (RFC 9309): the group for our product token, else `*`; the longest matching Allow or Disallow wins, Allow
// on a tie; `*` and `$` patterns. Fetched once per origin per run. A missing robots.txt (4xx) allows everything; an
// unreachable one (5xx, network) disallows everything for that run, as the RFC asks.
import { DEFAULT_HEADERS, FetchFailure, type HttpClient } from "../collector/http.ts";
import { decode } from "../collector/decode.ts";

export const PRODUCT_TOKEN = "unstale-collector";

export interface Robots {
  allowed(url: string): boolean;
  sitemaps: string[];
  /** Seconds, when the group sets one. Recorded; the HTTP client's per-host limit is the enforcement today. */
  crawlDelay?: number;
}

interface Rule { allow: boolean; pattern: string }

export function parseRobots(text: string, token = PRODUCT_TOKEN): Robots {
  const groups: Array<{ agents: string[]; rules: Rule[]; delay?: number }> = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "allow" || key === "disallow") {
      if (value) cur.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay" && Number.isFinite(Number(value))) cur.delay = Number(value);
  }
  const t = token.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && t.startsWith(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.find((g) => g.delay !== undefined)?.delay;
  return {
    sitemaps,
    ...(delay !== undefined ? { crawlDelay: delay } : {}),
    allowed(url: string) {
      const u = new URL(url);
      const path = u.pathname + u.search;
      let best: Rule | undefined;
      for (const r of rules) {
        if (!matches(r.pattern, path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
      }
      return best?.allow ?? true;
    },
  };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + body + (anchored ? "$" : "")).test(path);
}

const ALLOW_ALL: Robots = { allowed: () => true, sitemaps: [] };
const DENY_ALL: Robots = { allowed: () => false, sitemaps: [] };

/** robots.txt per origin, fetched once per instance (one instance per run). */
export class RobotsCache {
  readonly #http: HttpClient;
  readonly #byOrigin = new Map<string, Promise<Robots>>();
  constructor(http: HttpClient) {
    this.#http = http;
  }

  for(url: string): Promise<Robots> {
    const origin = new URL(url).origin;
    let r = this.#byOrigin.get(origin);
    if (!r) this.#byOrigin.set(origin, (r = this.#fetch(origin)));
    return r;
  }

  async allowed(url: string): Promise<boolean> {
    return (await this.for(url)).allowed(url);
  }

  async #fetch(origin: string): Promise<Robots> {
    try {
      const res = await this.#http.get(`${origin}/robots.txt`, { ...DEFAULT_HEADERS, accept: "text/plain" });
      return parseRobots(decode(res.body, res.headers.get("content-type")));
    } catch (e) {
      if (!(e instanceof FetchFailure)) throw e;
      if (e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500) return ALLOW_ALL;
      return DENY_ALL;
    }
  }
}
