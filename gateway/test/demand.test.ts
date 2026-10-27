import { expect, test } from "vitest";
import { PendingQueue, settingsFrom } from "../src/queue.ts";
import { Demand } from "../src/demand.ts";
import { report } from "../scripts/demand-report.ts";
import { memorySql } from "./sqlite.ts";

const T = Date.parse("2026-10-27T12:00:00Z");
test("outcomes distinguish acceptance, duplicate, counted vote and limits without altering demand", () => {
  const sql = memorySql();
  const s = { ...settingsFrom({}), perAddressPerHour: 1, votesPerAddressPerHour: 1, votesPerHour: 2, fastTrackPerDay: 0 };
  const q = new PendingQueue(sql, s);
  q.request("pkg:npm/a", "198.51.100.1", false, T, "marked_internal");
  q.request("pkg:npm/a", "198.51.100.1", false, T, "marked_internal");
  q.request("pkg:npm/b", "198.51.100.1", false, T);
  q.request("pkg:npm/a", "198.51.100.2", true, T);
  q.request("pkg:npm/c", "198.51.100.2", true, T);
  q.request("pkg:npm/a", "198.51.100.3", true, T);
  q.request("pkg:npm/d", "198.51.100.4", true, T);
  const snapshot = q.usageToday(T).demand;
  expect(snapshot.days.at(-1)).toMatchObject({
    marked_internal: { accepted: 1, duplicate: 1 },
    unmarked: { refused_address: 1, vote_counted: 2, vote_address_limited: 1, vote_global_limited: 1 },
  });
  expect(q.list()).toEqual([{ purl: "pkg:npm/a", demand: 3 }]);
  const stored = String(sql.db.prepare("SELECT v FROM meta WHERE k = 'usage'").get()!.v);
  expect(stored).not.toMatch(/198\.51|pkg:npm/);
  expect(new PendingQueue(sql, s).demandReport(T + 86_400_000).days).toContainEqual(snapshot.days.at(-1));
});

test("aggregate history survives wakes and retains only 90 calendar days even after idle periods", () => {
  const d = new Demand();
  d.count("accepted", "unmarked", T);
  const restored = new Demand();
  restored.restore(d.read(T));
  restored.count("refused_budget", "unmarked", T + 89 * 86_400_000);
  expect(restored.read(T + 89 * 86_400_000).days).toHaveLength(2);
  expect(restored.read(T + 90 * 86_400_000).days.map((r) => r.day)).not.toContain("2026-10-27");
  expect(restored.read(T + 200 * 86_400_000).days).toHaveLength(1);
});

test("daily report labels incomplete history and separates marked traffic without calling it human", () => {
  const d = new Demand();
  d.count("accepted", "unmarked", T);
  d.count("registry_unavailable", "marked_internal", T);
  const output = report(d.read(T), new Date(T));
  expect(output).toContain("2026-10-27 (partial)");
  expect(output).toContain("Marked internal");
  expect(output).toContain("Unmarked traffic can include bots");
  expect(output).toContain("missing history is not evidence of zero demand");
});
