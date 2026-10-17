// The classifier and judge requests of the labelled sets, rebuilt from stored data (read only) and checked for
// faithfulness: a rebuilt request counts only if it is byte-identical to one the pipeline asked, which is proven by a
// hit in that store's classifier cache (keyed by sha256 of the full request), and, for judge pairs, if the cached
// answer reproduces the p the audit recorded. Anything else is listed as not reconstructable, never approximated.
// The one exception is stated where it is built: the breaking set's states are synthesised (its records never went
// through this pipeline).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Classification, Questions } from "../../central/src/pipeline/classify/adapter.ts";
import { interpret, labelQuestions, recordState, type Labels } from "../../central/src/pipeline/classify/labels.ts";
import type { Incoming } from "../../central/src/pipeline/extract.ts";
import { ingest, kindOf, matchRequest, retrieve, type IncomingForGuard } from "../../central/src/pipeline/match.ts";
import { REPO_ROOT } from "../../central/src/pipeline/paths.ts";
import type { StoredRecord, TechStore } from "../../central/src/pipeline/store.ts";
import { TECHNOLOGIES } from "../../central/src/pipeline/technologies.ts";
import { canonical, compareVersions, sha256 } from "../../central/src/pipeline/util.ts";

export const STORE = join(REPO_ROOT, ".store");
export const EVAL = join(REPO_ROOT, "eval");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

/** Technologies outside TECHNOLOGIES that a set uses (eval/heldout/nuxt.mts NUXT). */
const EXTRA: Record<string, { name: string; components: string[] }> = { nuxt: { name: "Nuxt", components: ["pkg:npm/nuxt"] } };
export const techName = (id: string): string => TECHNOLOGIES[id]?.name ?? EXTRA[id]?.name ?? id;
const components = (id: string): string[] => TECHNOLOGIES[id]?.components ?? EXTRA[id]?.components ?? [];

/** The pipeline's cached answer to exactly this request (Jev as primary, the Codex fallback second), if any. */
export function cached(cacheDirs: string | string[], state: Record<string, unknown>, questions: Questions): Classification | undefined {
  for (const dir of typeof cacheDirs === "string" ? [cacheDirs] : cacheDirs)
    for (const [classifier, model] of [["jev", "jev-latest"], ["codex", "gpt-5.6-luna"]] as const) {
      const k = sha256(canonical({ classifier, model, state, questions }));
      const p = join(dir, k.slice(0, 2), `${k}.json`);
      if (existsSync(p)) return readJson<Classification>(p);
    }
  return undefined;
}

/** Every stored extraction of a technology in a store snapshot (pipeline Incoming records), by key. */
export function extractions(central: string, tech: string): Map<string, Incoming> {
  const dir = join(central, "extractions", tech);
  const out = new Map<string, Incoming>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) for (const inc of readJson<Incoming[]>(join(dir, f))) out.set(inc.key, inc);
  return out;
}

// ---- Step D: record labels ----

export interface ClassifyUnit {
  set: "benefit" | "breaking";
  /** The incoming key (benefit) or the set's rid (breaking). */
  id: string;
  /** The reference item the unit's answer is aggregated into. */
  item: string;
  tech: string;
  state: Record<string, unknown>;
  /** Proven identical to a request the pipeline asked (a cache hit); false for synthesised states. */
  faithful: boolean;
}

export interface Built<U> {
  units: U[];
  excluded: Array<{ item: string; why: string }>;
  note?: string;
}

/**
 * The benefit set (eval/sets/benefit/reference.json): each record's label is the union of the labels of the incoming
 * records it was built from (match.ts `combine`), so one unit per source incoming. Drawn from the catalog of
 * 15 October 2026 (catalog-trust: 150 of 150 ids active); its store is central-trust.
 */
export function benefitUnits(central = join(STORE, "central-trust")): Built<ClassifyUnit> {
  const ref = readJson<{ items: Array<{ id: string }> }>(join(EVAL, "sets", "benefit", "reference.json")).items;
  const cache = join(central, "cache", "classifier");
  const units: ClassifyUnit[] = [];
  const excluded: Built<ClassifyUnit>["excluded"] = [];
  const stores = new Map<string, TechStore>();
  const exts = new Map<string, Map<string, Incoming>>();
  const q = labelQuestions();
  for (const { id } of ref) {
    const tech = id.slice(0, id.indexOf(":"));
    if (!stores.has(tech)) stores.set(tech, readJson<TechStore>(join(central, "records", `${tech}.json`)));
    if (!exts.has(tech)) exts.set(tech, extractions(central, tech));
    const r = stores.get(tech)!.records[id];
    if (!r) {
      excluded.push({ item: id, why: "record not in the store" });
      continue;
    }
    for (const key of r.sources) {
      const inc = exts.get(tech)!.get(key);
      if (!inc) {
        excluded.push({ item: id, why: `source ${key} has no stored extraction (advisory or onboarding source)` });
        continue;
      }
      const state = recordState(techName(tech), inc);
      units.push({ set: "benefit", id: key, item: id, tech, state, faithful: !!cached(cache, state, q) });
    }
  }
  return { units, excluded };
}

export const BREAKING_ITEMS = join(homedir(), "ati-slice2", "results", "datamodel", "breaking", "items.json");

/**
 * The breaking set (vault 241, ~/ati-slice2 items.json). SYNTHESISED, not reconstructed: these records come from the
 * Slice 2 extractor, not this pipeline, so there is no pipeline request to match. recordState is filled from the
 * item's fields (key → subject, evidence → quote, guide → upgrade guide); facet, section, introduces and replaces do not
 * exist in the item and are empty. The published 89.6% (Jev) used the hill-climb's P0 state (no introduces/replaces
 * keys, breaking asked alone), so numbers from these units are comparable only with each other.
 */
export function breakingUnits(): Built<ClassifyUnit> {
  const items = readJson<Array<{ rid: string; tech: string; release: string; kind: string; key: string; summary: string; evidence: string }>>(BREAKING_ITEMS);
  const names: Record<string, string> = { laravel: "Laravel" };
  const units = items.map((i): ClassifyUnit => {
    const inc = { kind: i.kind === "guide" ? "upgrade_guide" : "release_notes", version: i.release, subject: i.key, summary: i.summary, quote: i.evidence, introduces: [], replaces: [] } as unknown as Incoming;
    return { set: "breaking", id: i.rid, item: i.rid, tech: i.tech, state: recordState(names[i.tech] ?? techName(i.tech), inc), faithful: false };
  });
  return { units, excluded: [], note: "states synthesised from Slice 2 items; see breakingUnits()" };
}

/** Per-item labels as the store would hold them: benefit is the union of non-none benefits, breaking is any (combine). */
export function aggregate(units: ClassifyUnit[], labels: Map<string, Labels>): Map<string, { benefit: string[]; breaking: boolean }> {
  const out = new Map<string, { benefit: string[]; breaking: boolean }>();
  for (const u of units) {
    const l = labels.get(u.id);
    if (!l) continue;
    const prev = out.get(u.item);
    const b = l.benefit.filter((x) => x !== "none");
    const benefit = [...new Set([...(prev?.benefit ?? []), ...b])];
    out.set(u.item, { benefit, breaking: (prev?.breaking ?? false) || l.breaking });
  }
  for (const v of out.values()) if (!v.benefit.length) v.benefit = ["none"];
  return out;
}

// ---- Step E: same-or-new judge ----

export interface JudgeUnit {
  set: "within" | "guides" | "nuxt";
  /** The audit's pair number (n) or table row. */
  n: number;
  tech: string;
  key: string;
  candidate: string;
  /** Index of the audited candidate in the request (question `same_c{index+1}`). */
  index: number;
  state: Record<string, unknown>;
  questions: Questions;
  /** The p the audit recorded (Jev at the time); reproduced from the cache for every included unit. */
  p: number;
  verdict: "SAME" | "DIFFERENT" | "UNSURE";
  /** guides set: the deterministic guard flags the audit recorded. */
  guards?: { breaking: boolean; advisory: boolean };
  /** A guide item against a release-notes record (ingest uses CROSS_SAME_P). */
  cross: boolean;
  /** The candidate records as they stood when the request was asked, and the incoming side of the guards: with them,
   *  match.ts `pick` gives ingest's own decision (judge plus guards) for any answer. */
  cands: StoredRecord[];
  guardInc: IncomingForGuard;
}

interface Request {
  state: Record<string, unknown>;
  questions: Questions;
  cands: StoredRecord[];
  guardInc: IncomingForGuard;
  answer?: Classification;
}

const guardOf = (inc: Incoming, breaking: boolean): IncomingForGuard => ({ breaking, quote: inc.quote, summary: inc.summary, kind: kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version });

/**
 * Re-runs the ingest loop of pipeline.ts (sorted by date, version, key) from an empty store over a snapshot's stored
 * extractions, with every label and judge answer taken from the snapshot's classifier cache. Faithful only for a store
 * built in one pass from empty; a miss means the request differs from what the pipeline asked.
 */
export async function replay(central: string, tech: string): Promise<{ requests: Map<string, Request>; hits: number; misses: number }> {
  const cache = join(central, "cache", "classifier");
  const real = readJson<TechStore>(join(central, "records", `${tech}.json`));
  const q = labelQuestions();
  const order: Array<{ inc: Incoming; lab: Labels }> = [];
  let hits = 0;
  let misses = 0;
  for (const inc of extractions(central, tech).values()) {
    if (!real.ingested[inc.key]) continue;
    const a = cached(cache, recordState(techName(tech), inc), q);
    if (a) order.push({ inc, lab: interpret(a) });
    else misses++;
  }
  order.sort((a, b) => a.inc.date.localeCompare(b.inc.date) || compareVersions(a.inc.version, b.inc.version) || a.inc.key.localeCompare(b.inc.key, "en", { numeric: true }));
  const s: TechStore = { technology: tech, records: {}, ingested: {}, ...(real.releaseIndex ? { releaseIndex: real.releaseIndex } : {}) };
  const requests = new Map<string, Request>();
  for (const { inc, lab } of order) {
    // The candidates exactly as ingest retrieves them, copied before ingest changes the store.
    const cands = structuredClone(retrieve(inc, Object.values(s.records)).map((c) => s.records[c.id]!));
    await ingest(s, techName(tech), components(tech), inc, lab, async (state, questions) => {
      const answer = cached(cache, state, questions);
      requests.set(inc.key, { state, questions, cands, guardInc: guardOf(inc, lab.breaking), ...(answer ? { answer } : {}) });
      if (answer) {
        hits++;
        return answer;
      }
      misses++;
      const no = { choice: "no", confidence: 1, probabilities: { yes: 0, no: 1 } };
      return { classifier: "jev", model: "miss", answers: Object.fromEntries(Object.keys(questions).map((k) => [k, no])) };
    });
  }
  return { requests, hits, misses };
}

const pOf = (a: Classification | undefined, i: number): number | undefined => a?.answers[`same_c${i + 1}`]?.probabilities.yes;

function fromRequest(set: JudgeUnit["set"], n: number, tech: string, key: string, candidate: string, p: number, verdict: JudgeUnit["verdict"], req: Request | undefined, excluded: Built<JudgeUnit>["excluded"]): JudgeUnit | undefined {
  const item = `${set}#${n} ${key} → ${candidate}`;
  if (!req) return void excluded.push({ item, why: "no judge request for this incoming in the replay" });
  if (!req.answer) return void excluded.push({ item, why: "rebuilt request is not in the classifier cache" });
  const index = req.cands.findIndex((c) => c.id === candidate);
  if (index < 0) return void excluded.push({ item, why: "audited candidate not among the rebuilt request's candidates" });
  if (pOf(req.answer, index) !== p) return void excluded.push({ item, why: `cached p ${pOf(req.answer, index)} differs from the audit's ${p}` });
  return { set, n, tech, key, candidate, index, state: req.state, questions: req.questions, p, verdict, cross: set === "guides", cands: req.cands, guardInc: req.guardInc };
}

/** docs/match-audit.md: the 83 "same" matches of the first full run, replayed from central-v1 (the first full run's store). */
export async function withinUnits(central = join(STORE, "central-v1")): Promise<Built<JudgeUnit>> {
  const rows = readFileSync(join(REPO_ROOT, "docs", "match-audit.md"), "utf8")
    .split("\n")
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => l.split("|").map((c) => c.trim()));
  const excluded: Built<JudgeUnit>["excluded"] = [];
  const units: JudgeUnit[] = [];
  const replays = new Map<string, Map<string, Request>>();
  for (const c of rows) {
    const [n, tech, id, inc, , p, verdict] = [Number(c[1]), c[2]!, c[3]!, c[4]!.split(" ")[0]!, c[5], Number(c[6]), c[7] as JudgeUnit["verdict"]];
    if (!replays.has(tech)) replays.set(tech, (await replay(central, tech)).requests);
    const u = fromRequest("within", n, tech, inc, id, p, verdict, replays.get(tech)!.get(inc), excluded);
    if (u) units.push(u);
  }
  return { units, excluded };
}

/**
 * eval/guides/pairs.json: guide items against the release-notes store before the rematch (central-pre-rematch), as
 * eval/guides/audit.mts built them (retrieve over the whole store, then one judge request). The guide items' own
 * extractions and labels live in the current store (the audit ran with the current central dir for its caches), so
 * both caches are searched; a hit in either proves the request was asked. Verdicts: verdicts.json.
 */
export const GUIDE_CACHES = [join(STORE, "central-pre-rematch", "cache", "classifier"), join(STORE, "central", "cache", "classifier")];
export function guideUnits(central = join(STORE, "central-pre-rematch")): Built<JudgeUnit> {
  const pairs = readJson<Array<{ n: number; technology: string; incoming: { key: string }; candidate: { id: string }; p: number; guards: { breaking: boolean; advisory: boolean } }>>(join(EVAL, "guides", "pairs.json"));
  const verdicts = readJson<Record<string, string>>(join(EVAL, "guides", "verdicts.json"));
  const V: Record<string, JudgeUnit["verdict"]> = { S: "SAME", D: "DIFFERENT", U: "UNSURE" };
  const cache = GUIDE_CACHES;
  const excluded: Built<JudgeUnit>["excluded"] = [];
  const units: JudgeUnit[] = [];
  const stores = new Map<string, TechStore>();
  const exts = new Map<string, Map<string, Incoming>>();
  const reqs = new Map<string, Request | undefined>();
  for (const p of pairs) {
    const t = p.technology;
    if (!stores.has(t)) stores.set(t, readJson<TechStore>(join(central, "records", `${t}.json`)));
    if (!exts.has(t)) exts.set(t, new Map([...extractions(join(STORE, "central"), t), ...extractions(central, t)]));
    if (!reqs.has(p.incoming.key)) {
      const inc = exts.get(t)!.get(p.incoming.key);
      const lab = inc && cached(cache, recordState(techName(t), inc), labelQuestions());
      if (!inc || !lab) {
        reqs.set(p.incoming.key, undefined);
        excluded.push({ item: `guides ${p.incoming.key}`, why: inc ? "guide item's label request not in any cache" : "guide item has no stored extraction" });
      }
      else {
        const store = stores.get(t)!;
        const cands = retrieve(inc, Object.values(store.records)).map((c) => store.records[c.id]!);
        const breaking = interpret(lab).breaking;
        const r = matchRequest(techName(t), inc, breaking, cands);
        const answer = cached(cache, r.state, r.questions);
        reqs.set(p.incoming.key, { ...r, cands, guardInc: guardOf(inc, breaking), ...(answer ? { answer } : {}) });
      }
    }
    const u = fromRequest("guides", p.n, t, p.incoming.key, p.candidate.id, p.p, V[verdicts[String(p.n)]!]!, reqs.get(p.incoming.key), excluded);
    if (u) units.push({ ...u, guards: p.guards });
  }
  return { units, excluded };
}

/** eval/heldout/pairs.json: Nuxt run from empty into central-trust-nuxt (eval/heldout/nuxt.mts); verdicts as table.py. */
export async function nuxtUnits(central = join(STORE, "central-trust-nuxt")): Promise<Built<JudgeUnit>> {
  const pairs = readJson<Array<{ n: number; incoming: { key: string }; candidate: { id: string }; p: number; reference: string; cross: boolean }>>(join(EVAL, "heldout", "pairs.json"));
  const over = readJson<Record<string, [JudgeUnit["verdict"], string] | string>>(join(EVAL, "heldout", "verdicts.json"));
  const { requests } = await replay(central, "nuxt");
  const excluded: Built<JudgeUnit>["excluded"] = [];
  const units: JudgeUnit[] = [];
  for (const p of pairs) {
    const o = over[String(p.n)];
    const verdict = Array.isArray(o) ? o[0] : p.reference === "same" ? "SAME" : "DIFFERENT";
    const u = fromRequest("nuxt", p.n, "nuxt", p.incoming.key, p.candidate.id, p.p, verdict, requests.get(p.incoming.key), excluded);
    if (u) units.push({ ...u, cross: p.cross });
  }
  return { units, excluded };
}
