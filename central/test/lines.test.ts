// Release lines derived from the release index (lines.ts) and advisory attachment by best-matching item, recompute and
// twin merge (advisories.ts).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { attachAdvisories, basisOf, fixesInWindow, idsAtQuote, type Advisory } from "../src/pipeline/advisories.ts";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import { buildIndex, deriveDepth, lineFn, recomputeReleases } from "../src/pipeline/lines.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { combineReleases, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-lines-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const NEXT = TECHNOLOGIES.next!;
const url = (v: string) => `https://github.com/vercel/next.js/releases/tag/v${v}`;
const rel = (version: string) => ({ component: "pkg:npm/next", version, date: "2026-01-01", line: version.split(".")[0]! });

function record(id: string, versions: string[], quote: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    technology: "next",
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "security",
    breaking: false,
    surface: "runtime_internal",
    subject: id.slice(5),
    subject_kind: "concept",
    summary: quote,
    benefit: ["security"],
    releases: versions.slice(0, 1).map(rel),
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    evidence: versions.map((v) => ({ kind: "release_notes" as const, url: url(v), quote, snapshot: "sha256:aa" })),
    related: [],
    sources: versions.map((v) => `next@${v}#0.0`),
    history: [{ action: "created", revision: 1, label_version: 1 }],
    ...over,
  };
}

const adv = (id: string, patched: string[], summary = `Advisory ${id}`): Advisory => ({
  id,
  aliases: [],
  severity: "high",
  url: `https://github.com/advisories/${id}`,
  summary,
  published: "2026-01-01",
  affected: patched.map((p) => ({ component: "pkg:npm/next", range: `< ${p}`, patched: p, fixed: p, type: "SEMVER", introduced: "0", listed: [] })),
});

describe("release lines", () => {
  test("depth: the smallest prefix depth at which version order is publish order in every group", () => {
    // 15.0.8 published after 15.1.0: majors interleave, minors do not.
    const next = [
      { version: "15.0.7", date: "2025-11-01" },
      { version: "15.1.0", date: "2025-11-10" },
      { version: "15.0.8", date: "2025-12-01" },
      { version: "15.1.1", date: "2025-12-01" },
      { version: "16.0.0", date: "2026-01-01" },
    ];
    expect(deriveDepth(next)).toBe(2);
    // No interleaving at all (prisma, nestjs): the major.
    expect(deriveDepth([{ version: "6.19.0", date: "2025-11-01" }, { version: "7.0.0", date: "2025-11-19" }, { version: "7.1.0", date: "2025-12-01" }])).toBe(1);
    // Same-day releases tie; prereleases are ignored.
    expect(deriveDepth([{ version: "15.5.7", date: "2025-12-11" }, { version: "16.0.7", date: "2025-12-11" }, { version: "16.1.0-canary.3", date: "2025-01-01" }])).toBe(1);
    // A patch line that interleaves at depth 2 too: depth 3 (the cap).
    expect(deriveDepth([{ version: "1.2.3", date: "2025-11-01" }, { version: "1.2.4", date: "2025-10-01" }])).toBe(3);
  });

  test("index: ascending by version, each with its line; a line's zero version marks its start", () => {
    const idx = buildIndex([
      { version: "16.0.0", date: "2026-01-01" },
      { version: "15.0.8", date: "2025-12-01" },
      { version: "15.1.0", date: "2025-11-10" },
      { version: "15.0.7", date: "2025-11-01" },
      { version: "16.0.1-canary.1", date: "2026-01-02" },
    ]);
    expect(idx.depth).toBe(2);
    expect(idx.releases).toEqual([
      { version: "15.0.7", date: "2025-11-01", line: "15.0" },
      { version: "15.0.8", date: "2025-12-01", line: "15.0" },
      { version: "15.1.0", date: "2025-11-10", line: "15.1", line_start: true },
      { version: "16.0.0", date: "2026-01-01", line: "16.0", line_start: true },
    ]);
  });

  test("records keep the earliest release per derived line; the published line keeps the old rule", () => {
    const s: Pick<TechStore, "releaseIndex"> = { releaseIndex: buildIndex([{ version: "15.0.5", date: "2025-12-11" }, { version: "15.1.0", date: "2025-01-01" }, { version: "15.1.9", date: "2025-12-11" }]) };
    const out = combineReleases([rel("15.0.5")], [rel("15.1.9"), rel("15.0.6")], lineFn(s));
    expect(out.map((r) => [r.version, r.line])).toEqual([["15.0.5", "15"], ["15.1.9", "15"]]);
    // Without an index (a store before this change): the old key, one per major.
    expect(combineReleases([rel("15.0.5")], [rel("15.1.9")]).map((r) => r.version)).toEqual(["15.0.5"]);
  });

  test("recompute: collapsed backports come back from sources and advisory fixes; a detached advisory's release goes", () => {
    const versions = ["15.0.5", "15.1.9", "15.2.6", "16.0.7", "16.0.9"];
    // 15.1.0 shipped before the 15.0 backport: depth 2.
    const s: Pick<TechStore, "releaseIndex"> = { releaseIndex: buildIndex([{ version: "15.1.0", date: "2025-01-01" }, ...versions.map((version) => ({ version, date: "2025-12-11" }))]) };
    // Stored before: one release per major, sources from three releases, an advisory fixed in 15.2.6 too.
    const r = record("next:rsc", ["15.0.5", "15.1.9", "16.0.7"], "RSC fix", {
      releases: [rel("15.0.5"), rel("16.0.7")],
      advisories: [{ id: "GHSA-AAAA-AAAA-AAAA", aliases: [], summary: "", url: "u", affected: [{ component: "pkg:npm/next", range: "", patched: "15.2.6" }] }],
    });
    expect(recomputeReleases(r, s, NEXT.components).map((x) => x.version)).toEqual(["15.0.5", "15.1.9", "15.2.6", "16.0.7"]);
    // 16.0.9 came only from an advisory that was detached: dropped.
    const r2 = record("next:x", ["15.0.5"], "x", { releases: [rel("15.0.5"), rel("16.0.9")] });
    expect(recomputeReleases(r2, s, NEXT.components, new Set(["16.0.9"])).map((x) => x.version)).toEqual(["15.0.5"]);
  });

  test("an advisory fixed on several minors of one major is one fix per derived line", () => {
    const releases = ["15.0.5", "15.1.9", "15.2.6", "16.0.7"].map((version) => ({ version, date: "2025-12-11" }));
    const a = adv("GHSA-9QR9-0000-0000", ["15.0.5", "15.1.9", "15.2.6", "16.0.7"]);
    expect(fixesInWindow(a, releases).map((f) => f.version)).toEqual(["15.0.5", "16.0.7"]);
    const s = { releaseIndex: buildIndex([{ version: "15.1.0", date: "2025-01-01" }, ...releases]) };
    expect(fixesInWindow(a, releases, lineFn(s)).map((f) => f.version)).toEqual(["15.0.5", "15.1.9", "15.2.6", "16.0.7"]);
  });

  test("published: the tech index carries the release index; a store without one publishes as before", () => {
    const out = mkdtempSync(join(tmpdir(), "unstale-lines-cat-"));
    const base: TechStore = { technology: "next", ingested: {}, records: { "next:a": record("next:a", ["15.0.5"], "a") } };
    publishTechnology(base, "2026-01-01T00:00:00Z", out);
    expect(JSON.parse(readFileSync(join(out, "v1/tech/next.json"), "utf8")).releases).toBeUndefined();
    publishTechnology({ ...base, releaseIndex: buildIndex([{ version: "15.0.5", date: "2025-12-11" }, { version: "16.0.0", date: "2026-01-01" }]) }, "2026-01-01T00:00:00Z", out);
    const idx = JSON.parse(readFileSync(join(out, "v1/tech/next.json"), "utf8"));
    expect(idx.releases).toEqual([{ version: "15.0.5", date: "2025-12-11", line: "15" }, { version: "16.0.0", date: "2026-01-01", line: "16", line_start: true }]);
  });
});

const NOTES = `### Security Fixes
- [GHSA-8h8q-6873-q5fj: Denial of Service with Server Components](https://github.com/vercel/next.js/security/advisories/GHSA-8h8q-6873-q5fj)
- [GHSA-267c-6grr-h53f: Middleware / Proxy bypass in App Router applications via segment-prefetch routes](https://github.com/vercel/next.js/security/advisories/GHSA-267c-6grr-h53f)
- [GHSA-26hh-7cqf-hhc6: Middleware / Proxy bypass in App Router applications via segment-prefetch routes - Incomplete Fix Follow-Up](https://github.com/vercel/next.js/security/advisories/GHSA-26hh-7cqf-hhc6)
`;

describe("advisory attachment", () => {
  test("ids at the best-matching item: a re-listed advisory's title does not pick up its follow-up's id", () => {
    const q267 = "Middleware / Proxy bypass in App Router applications via segment-prefetch routes";
    expect([...idsAtQuote(NOTES, q267)]).toEqual(["GHSA-267C-6GRR-H53F"]);
    expect([...idsAtQuote(NOTES, `GHSA-267c-6grr-h53f: ${q267}`)]).toEqual(["GHSA-267C-6GRR-H53F"]);
    expect([...idsAtQuote(NOTES, `${q267} - Incomplete Fix Follow-Up`)]).toEqual(["GHSA-26HH-7CQF-HHC6"]);
    // Two items equally good for the quote, naming different advisories: no ids (the advisory is judged instead).
    const twice = "- [GHSA-aaaa-aaaa-aaaa: Cache poisoning](u)\n- [GHSA-bbbb-bbbb-bbbb: Cache poisoning](u)\n";
    expect(idsAtQuote(twice, "Cache poisoning").size).toBe(0);
  });

  const releases = ["15.5.16", "15.5.18", "16.2.5", "16.2.6"].map((v) => ({ version: v, date: "2026-05-11", url: url(v) }));
  const neverJudge = async (): Promise<Classification> => {
    throw new Error("no model call expected");
  };

  test("id-based links are recomputed: a basis that no longer holds is removed, with history, and no model call", async () => {
    // The earlier releases list 267c alone; the later ones re-list it next to its follow-up.
    for (const v of ["15.5.16", "16.2.5"]) writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", `${v}.md`), NOTES.split("\n").slice(0, 3).join("\n"));
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "15.5.18.md"), NOTES);
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "16.2.6.md"), NOTES);
    const q267 = "Middleware / Proxy bypass in App Router applications via segment-prefetch routes";
    const a267 = adv("GHSA-267C-6GRR-H53F", ["15.5.16", "16.2.5"]);
    const a26h = adv("GHSA-26HH-7CQF-HHC6", ["15.5.18", "16.2.6"]);
    const proxy = record("next:middleware-proxy", ["15.5.16", "16.2.5", "15.5.18", "16.2.6"], q267, { releases: ["15.5.16", "16.2.5"].map(rel) });
    const follow = record("next:middleware-proxy~4", ["15.5.18", "16.2.6"], `${q267} - Incomplete Fix Follow-Up`);
    const s: TechStore = { technology: "next", ingested: {}, records: { [proxy.id]: proxy, [follow.id]: follow } };
    // As the old rule left it: 26hh attached to both by id.
    await attachAdvisories(NEXT, s, [a267], releases, neverJudge);
    const wrong = { ...a26h };
    proxy.advisories = [...(proxy.advisories ?? []), { id: wrong.id, aliases: [], summary: "", url: wrong.url, affected: [] }];
    proxy.history.push({ action: "advisory", detail: `${wrong.id} (named in the release notes)`, revision: proxy.revision, label_version: proxy.label_version });
    const r = await attachAdvisories(NEXT, s, [a267, a26h], releases, neverJudge);
    expect(r.removed).toEqual([{ advisory: "GHSA-26HH-7CQF-HHC6", record: "next:middleware-proxy" }]);
    expect(proxy.advisories!.map((a) => a.id)).toEqual(["GHSA-267C-6GRR-H53F"]);
    expect(proxy.history.some((h) => h.action === "advisory-removed" && h.detail?.startsWith("GHSA-26HH-7CQF-HHC6"))).toBe(true);
    expect(follow.advisories!.map((a) => a.id)).toEqual(["GHSA-26HH-7CQF-HHC6"]);
    expect(basisOf(follow, "GHSA-26HH-7CQF-HHC6")).toBe("id");
    expect(r.multiHolder).toEqual([]);
    // A rerun changes nothing.
    const before = JSON.stringify(s);
    await attachAdvisories(NEXT, s, [a267, a26h], releases, neverJudge);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("a judged link stays; an advisory that lost its id basis and has no holder is judged once", async () => {
    const a = adv("GHSA-8H8Q-6873-Q5FJ", ["15.5.18", "16.2.6"]);
    const judged = record("next:dos", ["16.2.6"], "Some unrelated fix", { change_type: "fix", benefit: ["correctness"] });
    judged.advisories = [{ id: a.id, aliases: [], summary: "", url: a.url, affected: [] }];
    judged.history.push({ action: "advisory", detail: `${a.id} (judged)`, revision: 1, label_version: 2 });
    const s: TechStore = { technology: "next", ingested: {}, records: { [judged.id]: judged } };
    const r = await attachAdvisories(NEXT, s, [a], releases, neverJudge);
    expect(r.removed).toEqual([]);
    expect(judged.advisories!.map((x) => x.id)).toEqual([a.id]);
    // Id basis lost (the stored link said "named", the notes no longer name it at the quote): judged, once per line.
    const named = record("next:named", ["16.2.6"], "A quote nowhere in the notes");
    named.advisories = [{ id: a.id, aliases: [], summary: "", url: a.url, affected: [] }];
    named.history.push({ action: "advisory", detail: `${a.id} (named in the release notes)`, revision: 1, label_version: 2 });
    const s2: TechStore = { technology: "next", ingested: {}, records: { [named.id]: named } };
    let calls = 0;
    const no = async (state: Record<string, unknown>): Promise<Classification> => {
      calls++;
      const cands = state.candidates as Record<string, unknown>;
      return { classifier: "jev", model: "t", answers: Object.fromEntries(Object.keys(cands).map((k) => [`same_${k}`, { choice: "no", confidence: 0.9, probabilities: { yes: 0.1, no: 0.9 } }])) };
    };
    const r2 = await attachAdvisories(NEXT, s2, [a], releases, no);
    expect(r2.removed).toEqual([{ advisory: a.id, record: "next:named" }]);
    expect(r2.created).toBe(1);
    expect(calls).toBe(1);
    expect(named.advisories).toEqual([]);
  });

  test("one advisory, one record: twins merge deterministically; other multi-holders are reported", async () => {
    const quote = "Server-Side Request Forgery in rewrites via attacker-controlled destination hostname";
    const a = adv("GHSA-P9J2-GV94-2WF4", ["15.5.18", "16.2.6"]);
    const b = adv("GHSA-6CHQ-WFR3-2HJ9", ["16.2.6"]);
    const mk = (id: string, v: string, q: string, x: Advisory) => {
      const r = record(id, [v], q, { releases: ["15.5.18", "16.2.6"].filter((y) => x.affected.some((f) => f.patched === y)).map(rel) });
      r.advisories = [{ id: x.id, aliases: [], summary: "", url: x.url, affected: [] }];
      r.history.push({ action: "advisory", detail: `${x.id} (judged)`, revision: 1, label_version: 2 });
      return r;
    };
    const s: TechStore = {
      technology: "next",
      ingested: {},
      records: Object.fromEntries(
        [mk("next:rewrites~2", "15.5.18", quote, a), mk("next:rewrites~3", "16.2.6", quote, a), mk("next:isformdata", "16.2.6", "Tightened isFormData", b), mk("next:getheaders", "16.2.6", "data.getHeaders() is only merged when own", b)].map((r) => [r.id, r]),
      ),
    };
    const r = await attachAdvisories(NEXT, s, [a, b], releases, neverJudge);
    expect(r.twinsMerged).toEqual([{ advisory: a.id, from: "next:rewrites~3", into: "next:rewrites~2" }]);
    expect(s.records["next:rewrites~3"]).toMatchObject({ status: "merged", merged_into: "next:rewrites~2" });
    expect(s.records["next:rewrites~2"]!.advisories!.map((x) => x.id)).toEqual([a.id]);
    expect(r.multiHolder).toEqual([{ advisory: b.id, records: ["next:getheaders", "next:isformdata"] }]);
  });

  test("a backport whose notes name the advisory at its quote holds it even where the database lists no fix; twins merge", async () => {
    const quote = "Middleware / Proxy bypass in App Router applications using Turbopack and single locale";
    const item = `- [${quote}](https://github.com/vercel/next.js/security/advisories/GHSA-6gpp-xcg3-4w24)\n`;
    for (const v of ["15.5.18", "16.2.6"]) writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", `${v}.md`), item);
    // The database lists the fix on 16.2 only.
    const a = adv("GHSA-6GPP-XCG3-4W24", ["16.2.6"]);
    const back = record("next:middleware-proxy~5", ["15.5.18"], quote);
    const main = record("next:turbopack~9", ["16.2.6"], quote);
    const s: TechStore = { technology: "next", ingested: {}, records: { [back.id]: back, [main.id]: main } };
    const r = await attachAdvisories(NEXT, s, [a], releases, neverJudge);
    expect(r.twinsMerged).toEqual([{ advisory: a.id, from: "next:turbopack~9", into: "next:middleware-proxy~5" }]);
    expect(s.records["next:middleware-proxy~5"]!.releases.map((x) => x.version)).toEqual(["15.5.18", "16.2.6"]);
  });

  test("a later release that only mentions an advisory (\"preserves the fix for CVE-...\") does not get it", async () => {
    const notes = "- Fixes iterative decoding. This preserves the security fix for CVE-2025-66202 (bypass via double encoding)\n";
    writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR!, "releases", "next", "16.2.6.md"), notes);
    const a = { ...adv("GHSA-WHQG-PPGF-WP8C", ["15.5.18"]), aliases: ["CVE-2025-66202"] };
    const holder = record("next:pathname", ["15.5.18"], "Fix middleware pathname matching by normalizing URL-encoded paths");
    holder.advisories = [{ id: a.id, aliases: a.aliases, summary: "", url: a.url, affected: [] }];
    holder.history.push({ action: "advisory", detail: `${a.id} (judged)`, revision: 1, label_version: 2 });
    const later = record("next:decoding", ["16.2.6"], "Fixes iterative decoding. This preserves the security fix for CVE-2025-66202");
    const s: TechStore = { technology: "next", ingested: {}, records: { [holder.id]: holder, [later.id]: later } };
    const r = await attachAdvisories(NEXT, s, [a], releases, neverJudge);
    expect(later.advisories ?? []).toEqual([]);
    expect(r.twinsMerged).toEqual([]);
    expect(r.multiHolder).toEqual([]);
  });
});
