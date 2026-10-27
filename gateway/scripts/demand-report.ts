// Operator report: read aggregate counters only. Never include queue contents or request metadata.
import { appendFileSync } from "node:fs";
import { OUTCOMES, type DemandSnapshot } from "../src/demand.ts";

export function report(snapshot: DemandSnapshot, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const lines = ["## Coverage demand", "", `Generated ${now.toISOString()}. UTC days; collection began ${snapshot.since} (first day is partial).`, "", "Counts are package outcomes, not installs, people, sessions, or CLI runs. Unmarked traffic can include bots and unconfigured internal tools. Counters are best effort; a restart can lose unflushed outcomes.", "", "| Day | Traffic | Accepted | Votes counted | Duplicates | Vote limits (address / global) | Refused (address / budget) | Not found | Registry unavailable |", "|---|---|---:|---:|---:|---:|---:|---:|---:|"];
  for (const row of [...snapshot.days].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14)) {
    for (const channel of ["unmarked", "marked_internal"] as const) {
      const c = row[channel];
      // Explicit allowlist: no server-provided strings other than validated timestamps reach the summary.
      for (const key of OUTCOMES) if (c[key] !== undefined && (!Number.isSafeInteger(c[key]) || c[key]! < 0)) throw new Error("Invalid aggregate count");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw new Error("Invalid aggregate day");
      lines.push(`| ${row.day}${row.day === today ? " (partial)" : ""} | ${channel === "marked_internal" ? "Marked internal" : "Unmarked"} | ${c.accepted ?? 0} | ${c.vote_counted ?? 0} | ${c.duplicate ?? 0} | ${c.vote_address_limited ?? 0} / ${c.vote_global_limited ?? 0} | ${c.refused_address ?? 0} / ${c.refused_budget ?? 0} | ${c.package_not_found ?? 0} | ${c.registry_unavailable ?? 0} |`);
    }
  }
  lines.push("", "Only observed days are shown; missing history is not evidence of zero demand. Outcomes cover valid package submissions at the coverage service; malformed HTTP requests are excluded. A duplicate is within the existing in-memory deduplication window, which resets on eviction. Marking traffic never changes admission, rate limits, or queue demand.", "");
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("demand-report.ts")) {
  const base = process.env.GATEWAY;
  const token = process.env.DRAIN_TOKEN;
  if (!base || !token) throw new Error("GATEWAY and DRAIN_TOKEN are required");
  const url = new URL("/internal/demand", base);
  if (url.protocol !== "https:") throw new Error("Gateway must use HTTPS");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Aggregate read failed: HTTP ${response.status}`);
  const snapshot = await response.json() as DemandSnapshot;
  if (!Array.isArray(snapshot.days)) throw new Error("Gateway has no demand counters yet; deploy the demand implementation first");
  if (!Number.isFinite(Date.parse(snapshot.since))) throw new Error("Invalid collection timestamp");
  snapshot.since = new Date(snapshot.since).toISOString();
  const markdown = report(snapshot);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}
