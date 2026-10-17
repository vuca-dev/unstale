// Matching at ingest and the record store: candidate retrieval, the same-or-new pick with its threshold and breaking
// guard, the combine rule, id minting, and the two counters (vault: Data Model Contract, "Identity and revision").
import { describe, expect, test } from "vitest";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import type { Labels } from "../src/pipeline/classify/labels.ts";
import type { Incoming } from "../src/pipeline/extract.ts";
import { advisoryIds, documentKey, finerOrBroader, guard, ingest, nearIdenticalQuote, normQuote, pick, retrieve, sameLineage, similarity } from "../src/pipeline/match.ts";
import { applyChange, combineReleases, mergeInto, mintId, retract, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";

const COMPONENTS = ["pkg:npm/next"];

function inc(over: Partial<Incoming> & { key: string }): Incoming {
  return {
    technology: "next",
    version: "16.3.2",
    date: "2026-08-21",
    line: "16",
    url: "https://github.com/vercel/next.js/releases/tag/v16.3.2",
    snapshot: "sha256:aaa",
    subject: "images.minimumCacheTTL",
    subject_kind: "literal",
    summary: "The default minimum cache TTL for optimized images is now four hours.",
    introduces: [],
    quote: "minimumCacheTTL default is now 4 hours",
    grounded: true,
    terms: ["images", "minimumCacheTTL"],
    replaces: [],
    requires: [],
    prerequisites: [],
    conditions: [],
    ...over,
  };
}

function labels(over: Partial<Labels> = {}): Labels {
  return {
    change_type: "default_change",
    surface: "configuration",
    breaking: false,
    benefit: ["none"],
    classifier: { classifier: "jev", model: "jev-1.13.0", change_type: 0.9, surface: 0.9, breaking: 0.1, benefit: [], borderline: [] },
    ...over,
  };
}

const store = (): TechStore => ({ technology: "next", records: {}, ingested: {} });

/** A judge that answers p(yes) per candidate subject, and counts its calls. */
function judge(p: (subject: string) => number) {
  const calls: Array<Record<string, unknown>> = [];
  const fn = async (state: Record<string, unknown>, questions: Record<string, unknown>): Promise<Classification> => {
    calls.push(state);
    const cands = state.candidates as Record<string, { subject: string }>;
    const answers = Object.fromEntries(
      Object.keys(questions).map((q) => {
        const y = p(cands[q.replace("same_", "")]!.subject);
        return [q, { choice: y >= 0.5 ? "yes" : "no", confidence: 0.9, probabilities: { yes: y, no: 1 - y } }];
      }),
    );
    return { classifier: "jev", model: "jev-1.13.0", answers };
  };
  return { fn, calls };
}

describe("id minting", () => {
  test("slug from subject and facet, lowercased, other characters as -; collisions get ~2, ~3", () => {
    const taken = new Set<string>();
    const mint = (s: string, f?: string) => {
      const id = mintId("prisma", s, f, (x) => taken.has(x));
      taken.add(id);
      return id;
    };
    expect(mint("prisma migrate diff", "--from-url")).toBe("prisma:prisma-migrate-diff-from-url");
    expect(mint("images.minimumCacheTTL")).toBe("prisma:images.minimumcachettl");
    expect(mint("images.minimumCacheTTL")).toBe("prisma:images.minimumcachettl~2");
    expect(mint("images.minimumCacheTTL")).toBe("prisma:images.minimumcachettl~3");
    expect(mint("`@prisma/client`")).toBe("prisma:prisma-client");
    expect(mint("!!!")).toBe("prisma:change");
  });
});

describe("candidate retrieval", () => {
  test("same technology, scored by overlap; same document snapshot excluded; at most 8", async () => {
    const s = store();
    const j = judge(() => 0);
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    // Same snapshot: the extractor separated these changes itself, so they are not candidates.
    expect(retrieve(inc({ key: "b" }), Object.values(s.records))).toEqual([]);
    const other = inc({ key: "c", snapshot: "sha256:bbb", version: "15.5.24", line: "15" });
    expect(retrieve(other, Object.values(s.records)).map((c) => c.id)).toEqual(["next:images.minimumcachettl"]);
    expect(retrieve({ ...other, technology: "prisma" }, Object.values(s.records))).toEqual([]);
    expect(retrieve({ ...other, subject: "proxy.ts", summary: "Renames middleware.", terms: [], url: "u" }, Object.values(s.records))).toEqual([]);
    for (let i = 0; i < 12; i++) {
      await ingest(s, "Next.js", COMPONENTS, inc({ key: `x${i}`, snapshot: `sha256:${i}`, subject: `images.option${i}` }), labels(), j.fn);
    }
    expect(retrieve(other, Object.values(s.records))).toHaveLength(8);
  });
});

describe("same or new", () => {
  const Q = "minimumCacheTTL default is now 4 hours";
  const cand = (id: string, breaking: boolean, quote = Q) => ({ id, breaking, summary: "s", evidence: [{ quote }] }) as StoredRecord;
  const answers = (ps: number[]) =>
    Object.fromEntries(ps.map((p, i) => [`same_c${i + 1}`, { choice: "x", confidence: 1, probabilities: { yes: p, no: 1 - p } }]));
  const incoming = (breaking: boolean, quote = Q) => ({ breaking, quote, summary: "s" });

  test("release notes: same only at p >= SAME_P_SHORT (0.87); the highest wins; every candidate's p is kept", () => {
    expect(pick([cand("a", false)], answers([0.86]), incoming(false))).toEqual({ judged: [{ id: "a", p: 0.86, outcome: "below" }] });
    expect(pick([cand("a", false)], answers([0.87]), incoming(false)).id).toBe("a");
    const r = pick([cand("a", false), cand("b", false)], answers([0.88, 0.9]), incoming(false));
    expect(r.id).toBe("b");
    expect(r.judged.map((j) => j.outcome)).toEqual(["not-best", "same"]);
  });

  test("an uncalibrated yes (a text generator's choice) merges only on a near-identical same-kind quote", () => {
    const c = cand("a", false);
    const same = { ...incoming(false), quote: c.evidence[0]!.quote };
    expect(pick([c], answers([1]), same, false).id).toBe("a");
    const other = { ...incoming(false), quote: "A different sentence about some other part of the API entirely" };
    expect(pick([c], answers([1]), other, false).judged[0]!.outcome).toBe("guard:quote");
    expect(pick([c], answers([1]), other, true).id).toBe("a"); // a calibrated p of 1 clears the quote guard
  });

  test("breaking guard: a breaking record never merges into a non-breaking one", () => {
    const r = pick([cand("a", false), cand("b", true)], answers([0.95, 0.88]), incoming(true));
    expect(r.id).toBe("b");
    expect(r.judged[0]).toEqual({ id: "a", p: 0.95, outcome: "guard:breaking" });
    expect(pick([cand("a", false)], answers([0.99]), incoming(true)).id).toBeUndefined();
    // A non-breaking record may join a breaking one.
    expect(pick([cand("a", true)], answers([0.95]), incoming(false)).id).toBe("a");
  });

  test("finer and broader records are told apart", () => {
    expect(finerOrBroader({ subject: "next build" }, { subject: "next build", facet: "--turbopack" })).toBe(true);
    expect(finerOrBroader({ subject: "images" }, { subject: "images.remotePatterns" })).toBe(true);
    expect(finerOrBroader({ subject: "images", facet: "a" }, { subject: "images", facet: "b" })).toBe(false);
    expect(finerOrBroader({ subject: "after" }, { subject: "afterAll" })).toBe(false);
  });
});

describe("ingest", () => {
  test("a backport matches: id kept, release and evidence added, revision bumped for the new line, terms joined", async () => {
    const s = store();
    const j = judge(() => 0.92);
    const a = await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    expect(j.calls).toHaveLength(0); // no candidates, no call
    const b = await ingest(
      s,
      "Next.js",
      COMPONENTS,
      inc({ key: "b", snapshot: "sha256:bbb", version: "15.5.24", line: "15", url: "u15", quote: "minimumCacheTTL default is now 4 hours (#91660)", subject: "minimumCacheTTL", terms: ["next.config.js"] }),
      labels({ benefit: ["performance"] }),
      j.fn,
    );
    expect(b).toMatchObject({ id: a.id, matched: true, candidates: 1 });
    const r = s.records[a.id]!;
    expect(r.releases.map((x) => `${x.line}:${x.version}`)).toEqual(["15:15.5.24", "16:16.3.2"]);
    expect(r.evidence.map((e) => e.url)).toEqual(["https://github.com/vercel/next.js/releases/tag/v16.3.2", "u15"]);
    expect(r.history.at(-1)!.judged).toEqual([{ id: a.id, p: 0.92, outcome: "same" }]);
    expect(r.terms).toEqual(["images", "minimumCacheTTL", "next.config.js"]);
    expect(r.benefit).toEqual(["performance"]);
    expect([r.revision, r.label_version]).toEqual([2, 2]);
    expect(s.ingested).toEqual({ a: a.id, b: a.id });
    // Rerun: an ingested key is skipped without a call.
    const n = j.calls.length;
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:bbb" }), labels(), j.fn);
    expect(j.calls.length).toBe(n);
  });

  test("a later patch on the same line adds evidence only: no counter moves", async () => {
    const s = store();
    const j = judge(() => 0.9);
    const a = await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:b", version: "16.3.5", url: "u2" }), labels(), j.fn);
    const r = s.records[a.id]!;
    expect(r.releases).toHaveLength(1);
    expect(r.releases[0]!.version).toBe("16.3.2");
    expect(r.evidence).toHaveLength(2);
    expect([r.revision, r.label_version]).toEqual([1, 1]);
  });

  test("the guard keeps a breaking incoming record new; a finer record is new and linked both ways", async () => {
    const s = store();
    const j = judge(() => 0.95);
    const a = await ingest(s, "Next.js", COMPONENTS, inc({ key: "a", subject: "next build" }), labels(), j.fn);
    const b = await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:b", subject: "next build", facet: "--turbopack" }), labels({ breaking: true }), j.fn);
    expect(b.matched).toBe(false);
    expect(b.judged).toEqual([{ id: a.id, p: 0.95, outcome: "guard:breaking" }]);
    expect(s.records[b.id]!.history[0]!.judged).toEqual(b.judged);
    expect(b.id).toBe("next:next-build-turbopack");
    expect(s.records[b.id]!.related).toEqual([a.id]);
    expect(s.records[a.id]!.related).toEqual([b.id]);
    expect(s.records[a.id]!.label_version).toBe(2);
    expect(s.records[a.id]!.revision).toBe(1);
  });

  test("below the threshold a similar record is new, with a minted collision id", async () => {
    const s = store();
    const j = judge(() => 0.6);
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    const b = await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:b" }), labels(), j.fn);
    expect(b).toMatchObject({ id: "next:images.minimumcachettl~2", matched: false });
  });
});

describe("counters", () => {
  const rec = (): StoredRecord => {
    const s = store();
    void ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), judge(() => 0).fn);
    return Object.values(s.records)[0]!;
  };

  test("revision fields bump revision; label fields bump label_version; once each per change", () => {
    const r = rec();
    expect(applyChange(r, { change_type: "behavior_change", replaces: ["old"] }, "correction")).toEqual({ revision: true, label: false });
    expect([r.revision, r.label_version]).toEqual([2, 1]);
    expect(applyChange(r, { summary: "Reworded.", terms: ["x"] }, "relabel")).toEqual({ revision: false, label: true });
    expect([r.revision, r.label_version]).toEqual([2, 2]);
    applyChange(r, { prerequisites: [{ ecosystem: "npm", name: "node", min: "20.9.0" }], surface: "code_api" }, "both");
    expect([r.revision, r.label_version]).toEqual([3, 3]);
  });

  test("an unchanged value bumps nothing; a claim correction bumps revision explicitly", () => {
    const r = rec();
    applyChange(r, { change_type: r.change_type, summary: r.summary }, "noop");
    expect([r.revision, r.label_version]).toEqual([1, 1]);
    applyChange(r, {}, "claim", { claim: true, detail: "meaning corrected" });
    expect([r.revision, r.label_version]).toEqual([2, 1]);
    expect(r.history.at(-1)).toMatchObject({ action: "claim", revision: 2 });
  });

  test("combineReleases keeps the earliest version per component and line", () => {
    const rel = (v: string, line: string) => ({ component: "pkg:npm/next", version: v, date: "d", line });
    expect(combineReleases([rel("16.3.5", "16")], [rel("16.3.2", "16"), rel("15.5.24", "15")]).map((r) => r.version)).toEqual(["15.5.24", "16.3.2"]);
  });
});

describe("merge and retraction", () => {
  test("a merge leaves a stub with merged_into; evidence and releases move; relations follow the target", async () => {
    const s = store();
    const j = judge(() => 0);
    const a = await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    const b = await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:b", version: "15.5.24", line: "15", url: "u15", subject: "minimumCacheTTL" }), labels(), j.fn);
    const c = await ingest(s, "Next.js", COMPONENTS, inc({ key: "c", snapshot: "sha256:c", subject: "minimumCacheTTL", facet: "x" }), labels(), j.fn);
    expect(s.records[c.id]!.related).toEqual([b.id]);
    mergeInto(s, b.id, a.id);
    const stub = s.records[b.id]!;
    expect(stub).toMatchObject({ status: "merged", merged_into: a.id, stub_line: "15" });
    expect(stub.summary).toBeUndefined();
    const t = s.records[a.id]!;
    expect(t.id).toBe(a.id);
    expect(t.evidence.map((e) => e.url)).toContain("u15");
    expect(t.releases.map((r) => r.line)).toEqual(["15", "16"]);
    expect(t.revision).toBe(2); // a new release line
    expect(t.terms).toContain("minimumCacheTTL");
    expect(s.ingested.b).toBe(a.id);
    expect(s.records[c.id]!.related).toEqual([a.id]);
    expect(() => mergeInto(s, b.id, a.id)).toThrow(/active/);
  });

  test("a retraction leaves a stub in the record's line and unlinks it", async () => {
    const s = store();
    const j = judge(() => 0);
    const a = await ingest(s, "Next.js", COMPONENTS, inc({ key: "a", subject: "next build" }), labels(), j.fn);
    const b = await ingest(s, "Next.js", COMPONENTS, inc({ key: "b", snapshot: "sha256:b", subject: "next build", facet: "--debug" }), labels(), j.fn);
    retract(s, b.id, "reverted upstream");
    expect(s.records[b.id]).toMatchObject({ status: "retracted", stub_line: "16" });
    expect(s.records[a.id]!.related).toEqual([]);
    expect(() => retract(s, b.id)).toThrow(/already/);
  });
});

// Real cases from the audit of the first full run's 83 ingest matches (orchestrator, 15 October 2026).
describe("deterministic guards on real audit cases", () => {
  const target = (quotes: string[], summary = "", breaking = false) =>
    ({ id: "t", breaking, summary, evidence: quotes.map((quote) => ({ quote })) }) as unknown as StoredRecord;

  test("similarity is Ratcliff/Obershelp (difflib ratio)", () => {
    expect(similarity("abcd", "abcd")).toBe(1);
    expect(similarity("abcd", "bcde")).toBe(0.75); // difflib.SequenceMatcher(None, "abcd", "bcde").ratio()
    expect(similarity("", "x")).toBe(0);
  });

  test("normalisation strips advisory ids, PR refs, markup, case and whitespace", () => {
    expect(normQuote("GHSA-h64f-5h5j-jqjh: Denial of  Service in the `Image` API (#93101)")).toBe(": denial of service in the image api");
    expect([...advisoryIds("CVE-2025-59471 and ghsa-h64f-5h5j-jqjh")]).toEqual(["CVE-2025-59471", "GHSA-H64F-5H5J-JQJH"]);
  });

  test("nestjs:pending-requests: an inserted word (rmq) blocks, although the quotes are 97% similar", () => {
    const inc = "fix(microservices): fail pending rmq requests on client close";
    const tgt = "fix(microservices): fail pending requests on client close";
    expect(similarity(normQuote(inc), normQuote(tgt))).toBeGreaterThan(0.9);
    expect(nearIdenticalQuote(inc, tgt)).toBe(false);
    expect(guard({ breaking: false, quote: inc, summary: "Pending RMQ requests now fail when the client closes." }, target([tgt]), 0.91)).toBe("guard:quote");
  });

  test("next:remotepatterns: GHSA-h64f against CVE-2025-59471 is blocked by the advisory guard even at p 0.99", () => {
    const t = target([
      "affects the Image Optimizer when external image optimization is enabled via `remotePatterns`.",
      "CVE-2025-59471 affects the Image Optimizer when external image optimization is enabled via `remotePatterns`.",
    ]);
    const inc = { breaking: false, quote: "GHSA-h64f-5h5j-jqjh: Denial of Service in the Image Optimization API", summary: "Fixes a moderate denial-of-service vulnerability in the Image Optimization API." };
    expect(guard(inc, t, 0.99)).toBe("guard:advisory");
    expect(guard(inc, t, 0.85)).toBe("guard:advisory");
  });

  test("the same advisory on another line still merges (next:middleware-proxy, p 0.79); a shared id passes the advisory guard", () => {
    const q = "GHSA-267c-6grr-h53f: Middleware / Proxy bypass in App Router applications via segment-prefetch routes";
    expect(guard({ breaking: false, quote: q, summary: "App Router middleware and proxy bypass vulnerabilities were addressed." }, target([q]), 0.79)).toBeUndefined();
  });

  test("a verbatim backport with a PR ref still merges below 0.95 (next:images.maximumdiskcachesize)", () => {
    const t = target(["feat(next/image): add lru disk cache and `images.maximumDiskCacheSize`"]);
    expect(guard({ breaking: false, quote: "feat(next/image): add lru disk cache and images.maximumDiskCacheSize (#91660)", summary: "" }, t, 0.8)).toBeUndefined();
  });

  test("a different change with low quote similarity is blocked below 0.95 (next:csp-nonces, p 0.73), allowed at 0.95", () => {
    const t = target(["GHSA-ffhc-5mcf-pf4q: Cross-site scripting in App Router applications using CSP nonces"]);
    const inc = { breaking: false, quote: "Add CSP nonce to script tags of loading and template files (#98403)", summary: "Adds CSP nonces to script tags in loading and template files." };
    expect(guard(inc, t, 0.73)).toBe("guard:quote");
    expect(guard(inc, t, 0.95)).toBeUndefined();
  });

  test("version numbers alone do not block (next:next-swc-wasm-web wording differs, so it stays separate below 0.95)", () => {
    expect(nearIdenticalQuote("publishing `@next/swc-wasm-web` which was accidentally not published since 15.5.15", "publishing `@next/swc-wasm-web` which was accidentally not published since 16.2.4")).toBe(true);
    expect(
      nearIdenticalQuote(
        "Contains no changes except publishing `@next/swc-wasm-web` which was accidentally not published since 16.2.4.",
        "publishing `@next/swc-wasm-web` which was accidentally not published since 15.5.15",
      ),
    ).toBe(false);
  });
});

// Upgrade guides (cross-source rule, docs/match-audit-guides.md; 15 October 2026).
describe("cross-source matching: upgrade guide items against release-notes records", () => {
  const rn = (quote: string, breaking = false) =>
    ({ id: "t", breaking, summary: "", evidence: [{ kind: "release_notes", quote }] }) as unknown as StoredRecord;
  const g = (over: Partial<{ breaking: boolean; quote: string; summary: string }> = {}) => ({
    breaking: false,
    quote: "Turbopack is stable and used by default with `next dev` and `next build`",
    summary: "Turbopack is stable and becomes the default.",
    kind: "upgrade_guide" as const,
    ...over,
  });

  test("across kinds the quote guard does not apply; the judge must reach CROSS_SAME_P (0.85)", async () => {
    const { CROSS_SAME_P } = await import("../src/pipeline/thresholds.ts");
    expect(CROSS_SAME_P).toBe(0.85);
    const t = rn("Add a --webpack flag and default --turbopack to true");
    expect(guard(g(), t, 0.84)).toBe("guard:cross");
    expect(guard(g(), t, 0.85)).toBeUndefined();
    // The same p within one kind is still subject to the quote guard.
    expect(guard({ ...g(), kind: "release_notes" }, t, 0.9)).toBe("guard:quote");
  });

  test("the breaking and advisory guards still apply across kinds, at any p", () => {
    expect(guard(g({ breaking: true }), rn("Add `images.dangerouslyAllowLocalIP`"), 0.99)).toBe("guard:breaking");
    expect(guard(g({ quote: "Fixes CVE-2026-0001" }), rn("Fixes CVE-2025-59471"), 0.99)).toBe("guard:advisory");
  });

  test("within a kind only that kind's quotes count: a guide quote on the target does not let release notes through", () => {
    const t = { id: "t", breaking: false, summary: "", evidence: [{ kind: "release_notes", quote: "Deprecate `middleware` and recommend `proxy`" }, { kind: "upgrade_guide", quote: "The `middleware` filename is deprecated, and has been renamed to `proxy`" }] } as unknown as StoredRecord;
    const notes = { breaking: false, quote: "The `middleware` filename is deprecated, and has been renamed to `proxy`", summary: "" };
    expect(guard(notes, t, 0.9)).toBe("guard:quote");
    expect(guard({ ...notes, kind: "upgrade_guide" }, t, 0.9)).toBeUndefined();
  });

  test("release-notes-only requests are unchanged; a guide in the request names each source and adds the cross-source rule", async () => {
    const { matchRequest, shortRules, SHORT_CROSS_RULE, evidenceOf } = await import("../src/pipeline/match.ts");
    const s = store();
    const j = judge(() => 0);
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "a" }), labels(), j.fn);
    const cand = Object.values(s.records);
    const plain = matchRequest("Next.js", inc({ key: "b", snapshot: "sha256:b" }), false, cand);
    expect(plain.state).toEqual({
      technology: "Next.js",
      incoming: { subject: "images.minimumCacheTTL", breaking: false, release: "16.3.2", summary: inc({ key: "x" }).summary },
      candidates: { c1: { subject: "images.minimumCacheTTL", breaking: false, release: "16.3.2", summary: inc({ key: "x" }).summary } },
    });
    expect(plain.questions.same_c1!.instructions).toBe(shortRules("c1"));
    const guide = inc({ key: "next@16.0.0+guide.abcd1234#0.1", snapshot: "sha256:g", kind: "upgrade_guide" });
    const mixed = matchRequest("Next.js", guide, false, cand);
    expect((mixed.state.incoming as Record<string, unknown>).source).toBe("upgrade guide");
    expect((mixed.state.candidates as Record<string, Record<string, unknown>>).c1!.source).toBe("release notes");
    expect(mixed.questions.same_c1!.instructions).toBe(`${shortRules("c1")}\n${SHORT_CROSS_RULE}`);
    expect(evidenceOf(guide).kind).toBe("upgrade_guide");
    expect(evidenceOf(inc({ key: "c" })).kind).toBe("release_notes");
  });

  test("a guide item merges into a release-notes record at p >= CROSS_SAME_P_SHORT (0.87) and is kept apart below", async () => {
    const s = store();
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "a", quote: "BREAKING CHANGE!: bump default images.minimumCacheTTL" }), labels(), judge(() => 0).fn);
    const lo = await ingest(s, "Next.js", COMPONENTS, inc({ key: "g1", snapshot: "sha256:g", kind: "upgrade_guide", quote: "The default value has changed from 60 seconds to 4 hours" }), labels(), judge(() => 0.86).fn);
    expect(lo.matched).toBe(false);
    expect(lo.judged[0]!.outcome).toBe("below");
    const hi = await ingest(s, "Next.js", COMPONENTS, inc({ key: "g2", snapshot: "sha256:g2", kind: "upgrade_guide", quote: "The default value has changed from 60 seconds to 4 hours" }), labels(), judge((subj) => (subj === "images.minimumCacheTTL" ? 0.9 : 0)).fn);
    expect(hi.matched).toBe(true);
    expect(s.records[hi.id]!.evidence.map((e) => e.kind)).toEqual(["release_notes", "upgrade_guide"]);
  });
});

describe("shorter rule text scope (eval/select/slice5/RESULTS-judge2.md, M8)", () => {
  const rec = (...kinds: string[]) => ({ evidence: kinds.map((kind) => ({ kind })) }) as unknown as StoredRecord;
  test("release notes and guide-against-notes use it; advisories, docs and guide-against-guide keep RULES_V3", async () => {
    const { shortRulesApply } = await import("../src/pipeline/match.ts");
    expect(shortRulesApply({}, [rec("release_notes")])).toBe(true);
    expect(shortRulesApply({ kind: "release_notes" }, [rec("release_notes", "upgrade_guide")])).toBe(true);
    expect(shortRulesApply({ kind: "upgrade_guide" }, [rec("release_notes")])).toBe(true);
    expect(shortRulesApply({ kind: "upgrade_guide" }, [rec("release_notes", "upgrade_guide")])).toBe(false);
    expect(shortRulesApply({ kind: "advisory" }, [rec("release_notes")])).toBe(false);
    expect(shortRulesApply({ kind: "docs" }, [rec("release_notes")])).toBe(false);
    expect(shortRulesApply({}, [rec("release_notes"), rec("docs")])).toBe(false);
  });
});

describe("lineage matching (a later version of the same document)", () => {
  const guideUrl = "https://github.com/vercel/next.js/blob/604704de/docs/01-app/02-guides/upgrading/version-16.mdx";
  const pageUrl = "https://nextjs.org/docs/app/guides/upgrading/version-16";
  const rec = async (over: Partial<Incoming> = {}): Promise<StoredRecord> => {
    const s = store();
    await ingest(s, "Next.js", COMPONENTS, inc({ key: "g", kind: "upgrade_guide", url: guideUrl, version: "16.0.0", line: "16", snapshot: "sha256:old", quote: "The `middleware` filename is deprecated", ...over }), labels(), judge(() => 0).fn);
    return Object.values(s.records)[0]!;
  };
  const later = { breaking: false, summary: "s", quote: "A rewritten sentence about proxy", kind: "upgrade_guide" as const, url: pageUrl, snapshot: "sha256:new", version: "16.0.0" };

  test("a guide's repository file and its page are one document", () => {
    expect(documentKey(guideUrl)).toBe("upgrading/version-16");
    expect(documentKey(pageUrl)).toBe(documentKey(guideUrl));
    expect(documentKey("https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7")).toBe(documentKey("https://github.com/prisma/web/blob/abc/apps/docs/content/docs/guides/upgrade-prisma-orm/v7.mdx"));
  });

  test("an edited guide's restatement merges at LINEAGE_SAME_P without a near-identical quote", async () => {
    const r = await rec();
    expect(sameLineage(later, r)).toBe(true);
    expect(guard(later, r, 0.82)).toBeUndefined();
    expect(guard(later, r, 0.75)).toBe("guard:lineage");
    // Without lineage (a docs page that is not the guide) the same pair is blocked by the cross-source guard.
    expect(guard({ ...later, kind: "docs", url: "https://nextjs.org/docs/app/api-reference/file-conventions/proxy" }, r, 0.82)).toBe("guard:cross");
  });

  test("an upgrade guide is one document per major, whatever its path (NestJS's repository file and page)", async () => {
    const r = await rec({ url: "https://github.com/nestjs/docs.nestjs.com/blob/abc/content/migration.md" });
    const page = { ...later, url: "https://docs.nestjs.com/migration-guide" };
    expect(documentKey(page.url)).not.toBe(documentKey(r.evidence[0]!.url));
    expect(sameLineage(page, r)).toBe(true);
    expect(sameLineage({ ...page, kind: "docs" }, r)).toBe(false); // a docs page still needs the same document
    expect(sameLineage({ ...page, version: "15.0.0" }, r)).toBe(false); // another major's guide is another document
  });

  test("a lineage merge takes the later, more specific summary; a vaguer or different one is not taken", async () => {
    const s = store();
    const judgeSame = judge(() => 0.9).fn;
    const first = inc({ key: "g1", kind: "upgrade_guide", url: pageUrl, version: "16.0.0", line: "16", snapshot: "sha256:old", subject: "react", summary: "Requires a newer React version", quote: "Update React" });
    await ingest(s, "Next.js", COMPONENTS, first, labels(), judgeSame);
    const r = Object.values(s.records)[0]!;
    await ingest(s, "Next.js", COMPONENTS, { ...first, key: "g2", snapshot: "sha256:new", summary: "Requires a newer React version, 19 or later", quote: "The minimum React version is 19" }, labels(), judgeSame);
    expect(Object.keys(s.records)).toHaveLength(1);
    expect(r.summary).toBe("Requires a newer React version, 19 or later");
    // Vaguer, or more specific but dropping a clause or a meaning-flipping word: the summary stays.
    for (const [key, summary] of [["g3", "Requires React"], ["g4", "React 19 or later"], ["g5", "React 19.2 is used"]] as const)
      await ingest(s, "Next.js", COMPONENTS, { ...first, key, snapshot: `sha256:${key}`, summary, quote: "React is required" }, labels(), judgeSame);
    expect(r.summary).toBe("Requires a newer React version, 19 or later");
  });

  test("not lineage: release notes, the same snapshot, or another release", async () => {
    const r = await rec();
    expect(sameLineage({ ...later, kind: "release_notes" }, r)).toBe(false);
    expect(sameLineage({ ...later, snapshot: "sha256:old" }, r)).toBe(false);
    expect(sameLineage({ ...later, version: "15.0.0" }, r)).toBe(false);
    const notes = await rec({ kind: "release_notes", url: "https://github.com/vercel/next.js/releases/tag/v16.0.0" });
    expect(sameLineage(later, notes)).toBe(false);
  });

  test("the breaking guard still applies within a lineage", async () => {
    const r = await rec();
    expect(guard({ ...later, breaking: true }, r, 0.9)).toBe("guard:breaking");
  });
});
