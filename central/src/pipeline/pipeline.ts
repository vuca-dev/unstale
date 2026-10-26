import { reconcileLinkedEvidence } from "../onboarding/source-quality.ts";
// fetch → extract → label → classify → match → publish, per technology. Idempotent: every model call is cached and
// every ingested extraction is recorded, so a rerun makes no uncached calls and leaves the catalog byte-identical.
import { join } from "node:path";
import { ChatClassifier, ClassifierCache, FallbackClassifier, Jev } from "./classify/adapter.ts";
import { extractModel } from "./llm.ts";
import { interpret, labelQuestions, recordState, type Labels } from "./classify/labels.ts";
import { type DocsNote, extractRelease, releaseCached, type Incoming } from "./extract.ts";
import type { PipelineBudget } from "./budget.ts";
import { advisoryStage, type AttachReport } from "./advisories.ts";
import { fetchGuides, fetchReleases, foreignGuides, guideBounds, type GuideNote, type ReleaseNote } from "./fetch.ts";
import { withTechLock } from "./lock.ts";
import { buildIndex } from "./lines.ts";
import { ingest, mergeChunkDuplicates, mergeSplitRecords } from "./match.ts";
import { catalogDir, centralDir } from "./paths.ts";
import { activeTerms, publishTechnology } from "./publish.ts";
import { drawSample, sampleCounts } from "./sample.ts";
import { checkIncoming } from "./prereqs.ts";
import { boundGuideRecords, loadStore, retractForeignGuideRecords, saveStore } from "./store.ts";
import { typeStubDeprecations } from "./type-stubs.ts";
import { TECHNOLOGIES, type Technology } from "./technologies.ts";
import { compareVersions, pool, writeAtomic } from "./util.ts";
import { DEFAULT_HTTP, HttpClient } from "../collector/http.ts";
import { completeEvents, dailyPass, DOCS_PASS, markExtracted, plan } from "../docs/extract.ts";
import { techLocal } from "../state/client.ts";

export function makeClassifier(): FallbackClassifier {
  let lastLogged = "";
  return new FallbackClassifier(new Jev(), new ChatClassifier(), new ClassifierCache(join(centralDir(), "cache", "classifier")), {
    fallback: (e) => {
      const msg = `${e.kind}: ${e.message}`;
      if (msg !== lastLogged) console.error(`classifier: Jev → ${extractModel().model} fallback (${msg})`);
      lastLogged = msg;
    },
  });
}

export interface TechReport {
  technology: string;
  releases: number;
  fetchRequests: number;
  extracted: number;
  failedCalls: number;
  ungrounded: number;
  ingestedNow: number;
  matched: number;
  guardBlocked: { breaking: number; advisory: number; quote: number; cross: number; lineage: number };
  relatedLinks: number;
  active: number;
  stubs: number;
  shards: number;
  catalogBytes: number;
  shardsWritten: number;
  sampleN: number;
  prerequisitesToConditions: number;
  advisories?: AttachReport;
  /** The docs pass (when due this run) and the docs section notes extracted. */
  docs?: { checked?: number; events?: Record<string, number>; notes: number; pending: number; held: number };
  /** Notes not extracted this run: the period budget was spent, or the technology is past its quarterly cap. */
  deferred?: { budget: number; cap: number };
}

export async function runTechnology(
  t: Technology,
  opts: { limit?: number; refresh?: boolean; offline?: boolean; publish?: boolean; sample?: boolean; guides?: boolean; registry?: boolean; advisories?: boolean; docs?: boolean; budget?: PipelineBudget; liftCap?: boolean },
  cls: FallbackClassifier,
): Promise<TechReport> {
  const fetched = await fetchReleases(t, { refresh: !!opts.refresh, offline: !!opts.offline });
  const releases = opts.limit ? fetched.notes.slice(0, opts.limit) : fetched.notes;
  console.log(`${t.id}: ${releases.length} releases (${fetched.stats.requests} list requests)`);

  // The docs module's daily pass: when due, check the technology's docs pages and record change events. Off for a trial
  // (`limit`), offline, or opts.docs === false.
  const docsOn = opts.docs !== false && !opts.limit;
  const http = new HttpClient(DEFAULT_HTTP);
  const pass = docsOn && !opts.offline ? await dailyPass(t, { http, log: (s) => console.error(`${t.id} docs: ${s}`) }) : undefined;
  if (pass) console.log(`${t.id}: docs ${pass.checked} pages checked, events ${JSON.stringify(pass.events)}, ${pass.sections.publishable} versioned sections`);

  // Upgrade guides go through the same extraction and labelling as release notes (opts.guides === false skips them).
  const guides = opts.guides === false ? [] : await fetchGuides(t, fetched.notes, { refresh: !!opts.refresh, offline: !!opts.offline, http, ...(pass ? { checked: true } : {}) });
  if (guides.length) console.log(`${t.id}: ${guides.length} upgrade guide(s) (${guides.map((g) => `${g.url} @ ${g.snapshot.slice(7, 19)}`).join(", ")})`);
  // Versioned docs changes as section notes, guides first, at most DOCS_PASS.notes a run (the rest wait).
  const docsPlan = docsOn ? await plan(t.id) : undefined;
  const docsPlanned = docsPlan?.notes.slice(0, DOCS_PASS.notes) ?? [];
  // The coverage budget (budget.ts): each note that will reach the extraction model is charged before any call; a
  // refused note is deferred to a later run. Notes are charged newest first, as fetched.
  const nameOf = (rel: ReleaseNote | GuideNote | DocsNote) => ("keyTag" in rel ? `${rel.version}${rel.keyTag}` : rel.version);
  const deferred = { budget: 0, cap: 0 };
  // Release versions whose notes this run does not read: the advisories stage judges nothing against them yet.
  const unread = new Set<string>();
  const admitted = (rel: ReleaseNote | GuideNote | DocsNote): boolean => {
    if (!opts.budget) return true;
    const c = opts.budget.charge(t.id, rel.notes, releaseCached(t, rel), !!opts.liftCap);
    if (c === "budget" || c === "cap") deferred[c]++;
    const ok = c === "ok" || c === "cached";
    if (!ok && !("keyTag" in rel)) unread.add(rel.version);
    return ok;
  };
  const notesToRun = [...releases, ...guides].filter(admitted);
  const docsNotes = docsPlanned.filter((n) => admitted(n.note));
  const extracted = await pool([...notesToRun, ...docsNotes.map((n) => n.note)], 6, async (rel) => {
    const r = await extractRelease(t, rel);
    writeAtomic(join(centralDir(), "extractions", techLocal(t.id), `${nameOf(rel)}.json`), JSON.stringify(r.incoming, null, 1) + "\n");
    return r;
  });
  if (deferred.budget || deferred.cap) console.log(`${t.id}: ${deferred.budget} notes deferred by the period budget, ${deferred.cap} past the quarterly cap`);
  const incoming: Incoming[] = extracted.flatMap((e) => e.incoming);
  const failedCalls = extracted.reduce((s, e) => s + e.failed, 0);
  console.log(`${t.id}: ${incoming.length} records extracted and labelled${failedCalls ? `, ${failedCalls} failed calls` : ""}`);

  const order = [...incoming].sort(
    (a, b) => a.date.localeCompare(b.date) || compareVersions(a.version, b.version) || a.key.localeCompare(b.key, "en", { numeric: true }),
  );
  const label = (inc: Incoming) => cls.classify(recordState(t.name, inc), labelQuestions()).then(interpret);
  // Only records the ingest loop will take are labelled: an ingested key is skipped there and its labels discarded. The
  // store read here (outside the lock) is a guess; the loop labels any record it takes that was not labelled here.
  const labels = await labelPending(order, loadStore(t.id).ingested, label);
  console.log(`${t.id}: classified ${labels.size} of ${incoming.length} (the rest are skipped by ingestion)`);

  // From loading the store to publishing it, this process is the technology's only writer (lock.ts).
  return withTechLock(t.id, "pipeline", async () => {
    const store = loadStore(t.id);
    if (!opts.limit) reconcileLinkedEvidence(t, fetched.notes, store);
    // Release lines derived from the release index (lines.ts), before anything combines releases.
    if (!opts.limit) store.releaseIndex = buildIndex(fetched.notes);
    // Prerequisite names of records not yet ingested are checked against the npm registry (one cached GET per name).
    const fresh = order.filter((inc) => !store.ingested[inc.key]) as Array<Incoming & { registry?: string }>;
    const movedToConditions = opts.registry === false ? 0 : await checkIncoming(fresh);
    let ingestedNow = 0;
    let matched = 0;
    const guardBlocked = { breaking: 0, advisory: 0, quote: 0, cross: 0, lineage: 0 };
    let relatedLinks = 0;
    for (const inc of order) {
      if (store.ingested[inc.key]) continue;
      const lab = labels.get(inc) ?? (await label(inc));
      const o = await ingest(store, t.name, t.components, inc, lab, (s, q) => cls.classify(s, q));
      const reg = (inc as Incoming & { registry?: string }).registry;
      if (reg) {
        const r = store.records[o.id]!;
        r.history.push({ action: "prerequisite-check", detail: `${inc.key}: ${reg}`, revision: r.revision, label_version: r.label_version });
      }
      ingestedNow++;
      if (o.matched) matched++;
      for (const j of o.judged) {
        if (j.outcome.startsWith("guard:")) {
          const rule = j.outcome.slice(6) as keyof typeof guardBlocked;
          guardBlocked[rule]++;
          console.log(`${t.id}: ${j.outcome} blocked ${inc.key} → ${j.id} (p=${j.p})`);
        }
      }
      relatedLinks += o.related.length;
      if (ingestedNow % 25 === 0) saveStore(store);
    }
    if (!opts.limit) {
      // Records cut from one release-note item (one per API it names, same quote, summary and labels) become one.
      const split = mergeSplitRecords(store);
      if (split.length) console.log(`${t.id}: ${split.length} records cut from the same release-note item merged`);
      // The same change in two parts of one release body, ingested before retrieval compared them: judged once each.
      const chunks = (await mergeChunkDuplicates(store, t.name, (s, q) => cls.classify(s, q))).filter((j) => j.outcome === "same");
      if (chunks.length) console.log(`${t.id}: ${chunks.length} records from another part of the same release notes merged`);
    }
    if (!opts.limit) {
      // Deprecations the technology's type stubs state in their declarations (no release notes say them).
      const typed = await typeStubDeprecations(t, store, { refresh: !!opts.refresh, offline: !!opts.offline });
      if (typed.length) console.log(`${t.id}: ${typed.length} deprecations from its type stubs' declarations`);
      const bounded = boundGuideRecords(store, guideBounds(t, fetched.notes));
      if (bounded) console.log(`${t.id}: ${bounded} records from a moving upgrade guide given a release bound`);
      const foreign = retractForeignGuideRecords(store, foreignGuides(t));
      if (foreign.length) console.log(`${t.id}: ${foreign.length} records read only from another technology's upgrade guide retracted`);
    }
    saveStore(store);
    // Docs events whose notes all extracted are done; one with a failed call is planned again next run.
    if (docsPlan) {
      const base = notesToRun.length;
      const failed = new Set(docsNotes.filter((_, i) => extracted[base + i]!.failed > 0).map((n) => n.event));
      markExtracted(t.id, [...completeEvents(docsNotes, failed, docsPlan.notes), ...docsPlan.settled]);
    }
    // Security advisories (OSV) attached to the records of their fix (advisories.ts).
    let advisoryReport: AttachReport | undefined;
    if (opts.advisories !== false && !opts.limit) {
      advisoryReport = await advisoryStage(t, store, fetched.notes, (s, q) => cls.classify(s, q), { refresh: !!opts.refresh, offline: !!opts.offline, unread });
      saveStore(store);
    }
    const recs = Object.values(store.records);
    const report: TechReport = {
      technology: t.id,
      releases: releases.length,
      fetchRequests: fetched.stats.requests,
      extracted: incoming.length,
      failedCalls,
      ungrounded: incoming.filter((i) => !i.grounded).length,
      ingestedNow,
      matched,
      guardBlocked,
      relatedLinks,
      active: recs.filter((r) => r.status === "active").length,
      stubs: recs.filter((r) => r.status !== "active").length,
      shards: 0,
      catalogBytes: 0,
      shardsWritten: 0,
      sampleN: 0,
      prerequisitesToConditions: movedToConditions,
      ...(advisoryReport ? { advisories: advisoryReport } : {}),
      ...(deferred.budget || deferred.cap ? { deferred } : {}),
      ...(docsPlan
        ? {
            docs: {
              ...(pass ? { checked: pass.checked, events: pass.events } : {}),
              notes: docsNotes.length,
              pending: docsPlan.notes.length - docsNotes.length,
              held: Object.values(docsPlan.held).reduce((a, b) => a + b, 0),
            },
          }
        : {}),
    };
    // The rarity sample is drawn only on request (the catalog ships with the edge's fallback rarity, since no selection
    // rule beat it); a sample in the store (`sample.json`) is still counted and published.
    if (opts.sample === true) await drawSample(t, store);
    if (opts.publish !== false) {
      const sample = sampleCounts(t.id, activeTerms(store));
      report.sampleN = sample?.n ?? 0;
      const p = publishTechnology(store, fetched.checked, catalogDir(), sample);
      report.shards = p.index.shards.length;
      report.catalogBytes = p.bytes;
      report.shardsWritten = p.written;
    }
    return report;
  });
}

/**
 * Labels the records an ingest in this order will take: the first of each key not in `ingested` (ingest records every
 * key it takes, so a later record with the same key is skipped too). Labels of any other record would be discarded.
 */
export async function labelPending(order: Incoming[], ingested: Record<string, string>, label: (inc: Incoming) => Promise<Labels>): Promise<Map<Incoming, Labels>> {
  const seen = new Set(Object.keys(ingested));
  const todo = order.filter((inc) => !seen.has(inc.key) && !!seen.add(inc.key));
  const out = await pool(todo, 4, label);
  return new Map(todo.map((inc, i) => [inc, out[i]!]));
}

export function technologies(filter?: string): Technology[] {
  if (!filter) return Object.values(TECHNOLOGIES);
  const t = TECHNOLOGIES[filter];
  if (!t) throw new Error(`unknown technology ${filter}; known: ${Object.keys(TECHNOLOGIES).join(", ")}`);
  return [t];
}
