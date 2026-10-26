// Matching at ingest (identity rules v3 from ~/ati-slice2/harness/dm_match.py): up to 8 candidates of the same
// technology, a yes/no same-or-new judgement per candidate through the classifier adapter, "same" only at p >= SAME_P,
// the breaking guard, and the combine rule. The id never changes on a match.
import { attributeEvidence, type Classification, type Questions } from "./classify/adapter.ts";
import type { Labels } from "./classify/labels.ts";
import type { Incoming } from "./extract.ts";
import { lineFn } from "./lines.ts";
import { applyChange, combineReleases, mergeInto, mintId, union, type Evidence, type Judged, type StoredRecord, type TechStore } from "./store.ts";
import { CROSS_SAME_P, CROSS_SAME_P_SHORT, LINEAGE_SAME_P, QUESTION_FLOOR, QUOTE_GUARD_BELOW_SHORT, SAME_P, SAME_P_SHORT } from "./thresholds.ts";
import { FLIPS, technical } from "../docs/materiality.ts";

export const K = 8;
const STOP = new Set(
  "the a an and or of to in for on with by from is are be as at this that it its when now can new no not use uses used using support supports supported adds added add".split(" "),
);

export function tokens(s: string | undefined): Set<string> {
  const t = (s ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return new Set((t.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)));
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

export interface Candidate {
  id: string;
  score: number;
}

/** The extraction call an incoming key came from: `{technology}@{version}[tag]#{chunk}` of `…#{chunk}.{index}`;
 * undefined for a key of another form. */
export const chunkOf = (key: string): string | undefined => /^(.+#\d+)\.\d+$/.exec(key)?.[1];

/**
 * A record of the same document snapshot that the extractor did not see beside the incoming item: no source of it is
 * from the incoming item's chunk (a release body over MAX_CHUNK is extracted in parts), and it has the same subject
 * and facet. One release that names a change in its highlights and again in its commit list gives two records the
 * extractor never compared (zod 4.5.0's `z.compile`).
 */
export function otherChunkSameSubject(inc: Pick<Incoming, "key" | "subject" | "facet">, r: Pick<StoredRecord, "sources" | "subject" | "facet">): boolean {
  const c = chunkOf(inc.key);
  if (!c || r.sources.some((k) => chunkOf(k) === c || !chunkOf(k))) return false;
  return r.subject.toLowerCase() === inc.subject.toLowerCase() && (r.facet ?? "").toLowerCase() === (inc.facet ?? "").toLowerCase();
}

/**
 * Candidates for an incoming record: active records of the same technology scored by subject (twice the weight),
 * summary and term overlap and a shared evidence document; the same release line breaks ties. Records that already
 * hold evidence from the same document snapshot are excluded, since the extractor separated those changes itself,
 * unless it never saw them together (`otherChunkSameSubject`).
 */
export function retrieve(inc: Incoming, records: StoredRecord[], k = K): Candidate[] {
  const st = tokens(`${inc.subject} ${inc.facet ?? ""}`);
  const su = tokens(inc.summary);
  const terms = new Set(inc.terms);
  const out: Candidate[] = [];
  for (const r of records) {
    if (r.status !== "active" || r.technology !== inc.technology) continue;
    if (r.evidence.some((e) => e.snapshot === inc.snapshot) && !otherChunkSameSubject(inc, r)) continue;
    let score = 2 * jaccard(st, tokens(`${r.subject} ${r.facet ?? ""}`)) + jaccard(su, tokens(r.summary));
    const rt = new Set(r.terms);
    score += jaccard(terms, rt);
    if (r.evidence.some((e) => e.url === inc.url)) score += 1;
    if (score <= 0) continue;
    if (r.releases.some((x) => x.line === inc.line)) score += 0.05;
    out.push({ id: r.id, score });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

export const RULES_V3 = `Identity rules:
- Same change: the same thing changed in the same way. The change_type label does NOT matter: extractors label the
  same change as a fix in one run and a behaviour change in another. The same change shipped in different releases
  (a backport to an older release line) is the same change.
- Not the same, even if related: a record about one specific function, option, flag or channel and a broader record
  about the feature it belongs to; the deprecation or removal of an old API and the addition of its replacement; a
  rename and the addition of the new name; two different options of one API; two separate fixes to one API; a change
  that breaks existing code and one that does not.
If you are unsure, answer no: a duplicate costs little, a wrong match hides a change.`;

/** Said only in requests where a source other than release notes takes part (release-notes requests are unchanged). */
export const CROSS_SOURCE_RULE =
  "The same change described in release notes and in an upgrade guide is the same change; the wording and the level of detail differ between the two kinds of source.";

const SOURCE_NAME: Record<Evidence["kind"], string> = {
  release_notes: "release notes",
  upgrade_guide: "upgrade guide",
  docs: "documentation",
  changelog: "changelog",
  advisory: "security advisory",
  other: "other",
};

/**
 * The shorter rule text ("M8", eval/select/slice5/RESULTS-judge2.md): the same rules, reworded, inside every question.
 * Held-out against RULES_V3 at K = 8: false merges 0.8 per 100 both, recall 88.8% both, Jev input −22%. It shifts
 * Jev's probabilities, so it has its own thresholds (SAME_P_SHORT, CROSS_SAME_P_SHORT). Used only where it was
 * measured: release notes and upgrade guides, never advisories, docs or a guide against an earlier version of a guide
 * (lineage), which keep RULES_V3 and their calibrated thresholds.
 */
export const shortRules = (c: string): string => `Is the incoming record the same change as candidate ${c}?
Same: the same thing changed in the same way. Ignore change_type labels and release lines (a backport is the same change).
Not the same, even if related: a specific function, option, flag or channel vs the broader feature; deprecating or removing an API vs adding its replacement; a rename vs adding the new name; two different options, or two separate fixes, of one API; a breaking vs a non-breaking change.
Unsure: answer no (a wrong match hides a change).`;
export const SHORT_CROSS_RULE = "Release notes and an upgrade guide describe the same change in different words and detail.";

/** Whether a request uses the shorter rules: release notes and guides only, and no guide against a guide (lineage). */
export function shortRulesApply(inc: { kind?: Evidence["kind"] }, cands: Pick<StoredRecord, "evidence">[]): boolean {
  const ik = inc.kind ?? "release_notes";
  if (ik !== "release_notes" && ik !== "upgrade_guide") return false;
  return cands.every((c) => [...kindsOf(c)].every((k) => k === "release_notes" || (k === "upgrade_guide" && ik === "release_notes")));
}

/** Said only in requests where a security advisory takes part. */
export const ADVISORY_RULE =
  "A security advisory and a release-notes or guide item that describes the fix for that vulnerability are the same change; a fix for a different vulnerability, or a general hardening change, is not.";

const brief = (r: { subject: string; facet?: string | undefined; summary: string; breaking: boolean }, release: string, sources?: string) => ({
  subject: r.subject,
  ...(r.facet ? { facet: r.facet } : {}),
  breaking: r.breaking,
  release,
  ...(sources ? { source: sources } : {}),
  summary: r.summary,
});

/** The evidence kinds a stored record holds. */
export const kindsOf = (r: Pick<StoredRecord, "evidence">): Set<Evidence["kind"]> => new Set(r.evidence.map((e) => e.kind ?? "release_notes"));
export const kindOf = (inc: { kind?: Incoming["kind"] }): Evidence["kind"] => inc.kind ?? "release_notes";

/**
 * The judge request. With retrieval `scores` (one per candidate) and the shorter rules, only candidates scored at or
 * above QUESTION_FLOOR get a question; the state keeps every candidate, so the questions asked read the same request.
 */
export function matchRequest(techName: string, inc: Incoming, breaking: boolean, cands: StoredRecord[], scores?: number[]): { state: Record<string, unknown>; questions: Questions } {
  // Sources are named only when something other than release notes takes part, so release-notes-only requests (and
  // their cached answers) are byte-identical to the ones before upgrade guides were added.
  const mixed = kindOf(inc) !== "release_notes" || cands.some((c) => [...kindsOf(c)].some((k) => k !== "release_notes"));
  const names = (ks: Iterable<Evidence["kind"]>) => [...ks].map((k) => SOURCE_NAME[k]).sort().join(", ");
  const state = {
    technology: techName,
    incoming: brief({ ...inc, breaking }, inc.version, mixed ? SOURCE_NAME[kindOf(inc)] : undefined),
    candidates: Object.fromEntries(
      cands.map((c, i) => [
        `c${i + 1}`,
        brief(c, c.releases.map((r) => r.version).filter((v, j, a) => a.indexOf(v) === j).join(", "), mixed ? names(kindsOf(c)) : undefined),
      ]),
    ),
  };
  const rules = kindOf(inc) === "advisory" ? `${RULES_V3}\n${ADVISORY_RULE}` : mixed ? `${RULES_V3}\n${CROSS_SOURCE_RULE}` : RULES_V3;
  const short = shortRulesApply(inc, cands);
  const asked = (i: number) => !short || !scores || scores[i]! >= QUESTION_FLOOR;
  const questions: Questions = Object.fromEntries(
    cands
      .map((_, i) => i)
      .filter(asked)
      .map((i) => [
        `same_c${i + 1}`,
        {
          instructions: short
            ? `${shortRules(`c${i + 1}`)}${mixed ? `\n${SHORT_CROSS_RULE}` : ""}`
            : `Does the incoming record describe the same change as candidate c${i + 1}?\n${rules}`,
          options: { yes: `The same change as candidate c${i + 1}.`, no: `A different change from candidate c${i + 1}, or unsure.` },
        },
      ]),
  );
  attributeEvidence(state, inc.quote);
  return { state, questions };
}

// ---- Deterministic guards (can only block a merge; the judge at p >= SAME_P is the first gate). ----
// Tuned on the 83 ingest matches of the first full run, so not an independent measurement.

/** At or above this p the quote guard is skipped (the advisory and breaking guards still apply); requests under the
 * shorter rules use QUOTE_GUARD_BELOW_SHORT (thresholds.ts). */
export const QUOTE_GUARD_BELOW = 0.95;
/** Ratcliff/Obershelp similarity (as Python's difflib.SequenceMatcher.ratio, without its junk heuristic). */
export const QUOTE_SIMILARITY = 0.9;

const ADVISORY = /\bGHSA(?:-[a-z0-9]{4}){3}\b|\bCVE-\d{4}-\d{4,}\b/gi;

/** Security advisory ids (GHSA-xxxx-xxxx-xxxx, CVE-yyyy-nnnn) named in a text, upper-cased. */
export function advisoryIds(text: string): Set<string> {
  return new Set((text.match(ADVISORY) ?? []).map((x) => x.toUpperCase()));
}

/** Quote normalisation for comparison: advisory ids, PR refs, markup, case and whitespace removed. */
export function normQuote(q: string): string {
  return q
    .replace(ADVISORY, " ")
    .replace(/\(\s*#\d+\s*\)/g, " ")
    .replace(/#\d+\b/g, " ")
    .replace(/[`*_\\]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Ratcliff/Obershelp: 2 * matched characters / total characters, matching longest common blocks recursively. */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matched = (a0: number, a1: number, b0: number, b1: number): number => {
    let best = 0;
    let bi = 0;
    let bj = 0;
    let prev = new Array<number>(b1 - b0 + 1).fill(0);
    for (let i = a0; i < a1; i++) {
      const cur = new Array<number>(b1 - b0 + 1).fill(0);
      for (let j = b0; j < b1; j++) {
        if (a[i] === b[j]) {
          const v = prev[j - b0]! + 1;
          cur[j - b0 + 1] = v;
          if (v > best) {
            best = v;
            bi = i - v + 1;
            bj = j - v + 1;
          }
        }
      }
      prev = cur;
    }
    if (!best) return 0;
    return best + matched(a0, bi, b0, bj) + matched(bi + best, a1, bj + best, b1);
  };
  return (2 * matched(0, a.length, 0, b.length)) / (a.length + b.length);
}

/** Word tokens of a quote, without numbers and versions. */
const quoteWords = (q: string): Set<string> => new Set((q.match(/[a-z][a-z0-9_.@/-]*/g) ?? []).map((w) => w.replace(/[.\-/]+$/, "")).filter(Boolean));

/**
 * Near-identical evidence: after normalisation one quote contains the other or their similarity is at least
 * QUOTE_SIMILARITY, and the incoming quote adds no word absent from the target quote (numbers and versions aside).
 */
export function nearIdenticalQuote(incoming: string, target: string): boolean {
  const a = normQuote(incoming);
  const b = normQuote(target);
  if (!a || !b) return false;
  if (!(a.includes(b) || b.includes(a) || similarity(a, b) >= QUOTE_SIMILARITY)) return false;
  const tw = quoteWords(b);
  for (const w of quoteWords(a)) if (!tw.has(w)) return false;
  return true;
}

export interface IncomingForGuard {
  breaking: boolean;
  quote: string;
  summary: string;
  /** Evidence kind of the incoming record; release notes when absent. */
  kind?: Evidence["kind"];
  /** Source document, its snapshot and the release the item is dated to: what lineage matching compares. */
  url?: string;
  snapshot?: string;
  version?: string;
}

/**
 * A document's identity across its versions and representations: the last two path segments, without ordering
 * prefixes, extension or `index`. A guide's repository file (`github.com/…/blob/<commit>/docs/01-app/02-guides/
 * upgrading/version-16.mdx`) and its page (`nextjs.org/docs/app/guides/upgrading/version-16`) are one document.
 */
export function documentKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let path = u.pathname;
  const blob = /^\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/.exec(path);
  if (u.hostname === "github.com" && blob) path = "/" + blob[1];
  const segs = path
    .toLowerCase()
    .replace(/\.(mdx?|markdown|rst|html?)$/, "")
    .split("/")
    .filter(Boolean)
    .map((x) => x.replace(/^\d+[-_.](?=\D)/, ""))
    .filter((x) => x !== "index" && x !== "readme");
  return segs.slice(-2).join("/");
}

const DOC_KINDS = new Set<Evidence["kind"]>(["upgrade_guide", "docs"]);

/**
 * The incoming item comes from a later version of a document the candidate already cites, for the same release: an
 * edited guide or docs page restating a fact it stated before, worded or quoted differently. Documentation only;
 * release notes keep their guards (match audits: docs/match-audit*.md). Upgrade guides are one document per major
 * whatever their path: the path can change between repository and site (NestJS `content/migration.md` and
 * `/migration-guide`), and one guide can be served under several sections (Next.js's App and Pages Router copies).
 */
export function sameLineage(inc: IncomingForGuard, c: StoredRecord): boolean {
  const kind = inc.kind ?? "release_notes";
  if (!inc.url || !inc.version || !DOC_KINDS.has(kind)) return false;
  if (!c.releases.some((r) => r.version === inc.version)) return false;
  const key = documentKey(inc.url);
  return c.evidence.some((e) => {
    const ek = e.kind ?? "release_notes";
    if (!DOC_KINDS.has(ek) || e.snapshot === inc.snapshot) return false;
    return documentKey(e.url) === key || (kind === "upgrade_guide" && ek === "upgrade_guide");
  });
}

/** Version numbers, quantities and technical tokens of a summary, lower-cased: what makes a statement specific. */
function specifics(s: string): Set<string> {
  const out = new Set([...technical(s)].map((x) => x.toLowerCase()));
  for (const m of s.matchAll(/\b\d+(?:\.\d+)*\b/g)) out.add(m[0]);
  return out;
}

const wordsOf = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * `a` refines `b`: it keeps every specific of `b` and adds at least one, keeps every meaning-flipping word of `b`
 * ("stable", "deprecated", "default"), and keeps at least half of `b`'s other words, so a restatement that drops a
 * clause ("with a codemod available") is not taken ("The PRISMA_CLIENT_ENGINE_TYPE variable was removed" over "This
 * environment variable has been removed").
 */
export function moreSpecific(a: string, b: string): boolean {
  const [sa, sb] = [specifics(a), specifics(b)];
  if (!(sa.size > sb.size && [...sb].every((x) => sa.has(x)))) return false;
  const [wa, wb] = [wordsOf(a), wordsOf(b)];
  if ([...wb].some((w) => FLIPS.has(w) && !wa.has(w))) return false;
  const content = [...wb].filter((w) => w.length >= 4 && !FLIPS.has(w));
  return content.filter((w) => wa.has(w)).length * 2 >= content.length;
}

/**
 * Which guard blocks merging the incoming record into a candidate judged "same" at p, if any. The breaking and
 * advisory guards apply to every pair. The quote guard compares quotes of one evidence kind only: when the target
 * holds evidence of the incoming record's kind, below QUOTE_GUARD_BELOW one of those quotes must be near-identical.
 * Across kinds (a guide item against a record built from release notes) quotes are not expected to agree, so instead
 * the judge must reach CROSS_SAME_P (match audit: docs/match-audit-guides.md).
 */
export function guard(inc: IncomingForGuard, c: StoredRecord, p: number, crossP = CROSS_SAME_P, quoteBelow = QUOTE_GUARD_BELOW): Judged["outcome"] | undefined {
  // A breaking record never merges into a non-breaking one.
  if (inc.breaking && !c.breaking) return "guard:breaking";
  // Disjoint advisory ids on both sides: two different advisories.
  const ia = advisoryIds(`${inc.quote} ${inc.summary}`);
  const ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
  if (ia.size && ca.size && ![...ia].some((x) => ca.has(x))) return "guard:advisory";
  // A later version of a document the candidate cites: the quote and cross-source guards do not apply, the bar is
  // LINEAGE_SAME_P.
  if (sameLineage(inc, c)) return p < LINEAGE_SAME_P ? "guard:lineage" : undefined;
  // The same document (another part of one release body, `otherChunkSameSubject`): a change it names twice is worded
  // differently each time, so quotes are not expected to agree; as across kinds, the judge must reach crossP.
  if (inc.snapshot && c.evidence.some((e) => e.snapshot === inc.snapshot)) return p < crossP ? "guard:cross" : undefined;
  const kind = inc.kind ?? "release_notes";
  const same = c.evidence.filter((e) => (e.kind ?? "release_notes") === kind);
  if (!same.length) return p < crossP ? "guard:cross" : undefined;
  // Below QUOTE_GUARD_BELOW the evidence must be near-identical to one of the target's quotes of the same kind.
  if (p < quoteBelow && !same.some((e) => nearIdenticalQuote(inc.quote, e.quote))) return "guard:quote";
  return undefined;
}

/**
 * The judge's pick: the candidate with the highest p(same) at or above SAME_P (SAME_P_SHORT under the shorter rules) that no guard blocks. Every candidate's
 * p and outcome is returned, so the record's history keeps the rejected ones too.
 */
export function pick(cands: StoredRecord[], answers: Classification["answers"], inc: IncomingForGuard, calibrated = true): { id?: string; p?: number; judged: Judged[] } {
  const short = shortRulesApply(inc, cands);
  const sameP = short ? SAME_P_SHORT : SAME_P;
  const crossP = short ? CROSS_SAME_P_SHORT : CROSS_SAME_P;
  const quoteBelow = short ? QUOTE_GUARD_BELOW_SHORT : QUOTE_GUARD_BELOW;
  const judged: Judged[] = cands.map((c, i) => {
    const a = answers[`same_c${i + 1}`];
    if (!a) return { id: c.id, p: 0, outcome: "unasked" };
    const p = a.probabilities.yes ?? 0;
    if (p < sameP) return { id: c.id, p, outcome: "below" };
    // An uncalibrated "yes" (a text generator's choice, adapter.ts) is no evidence of how sure the judge is: every
    // probability-gated guard applies as if p were 0, so it merges only on a near-identical quote of the same kind,
    // never across kinds or by lineage.
    return { id: c.id, p, outcome: guard(inc, c, calibrated ? p : 0, crossP, quoteBelow) ?? "same" };
  });
  let best: Judged | undefined;
  for (const j of judged) if (j.outcome === "same" && (!best || j.p > best.p)) best = j;
  for (const j of judged) if (j.outcome === "same" && j !== best) j.outcome = "not-best";
  return best ? { id: best.id, p: best.p, judged } : { judged };
}

/** A finer record and the broader one it belongs to: same subject with a facet on one side only, or a dotted prefix. */
export function finerOrBroader(a: { subject: string; facet?: string | undefined }, b: { subject: string; facet?: string | undefined }): boolean {
  const sa = a.subject.toLowerCase();
  const sb = b.subject.toLowerCase();
  if (sa === sb) return !!a.facet !== !!b.facet;
  return (sa.startsWith(`${sb}.`) || sb.startsWith(`${sa}.`)) && !a.facet && !b.facet;
}

export function releasesOf(inc: Incoming, components: string[]) {
  return components.map((component) => ({ component, version: inc.version, date: inc.date, line: inc.line, ...(inc.noLaterThan ? { no_later_than: inc.noLaterThan } : {}) }));
}

export function evidenceOf(inc: Incoming): Evidence {
  return {
    kind: kindOf(inc),
    url: inc.url,
    ...(inc.section ? { section: inc.section } : {}),
    quote: inc.quote,
    snapshot: inc.snapshot,
  };
}

const literal = (inc: Incoming): string[] =>
  inc.subject_kind === "literal" ? [inc.subject, ...(inc.facet ? [inc.facet] : [])] : inc.facet ? [inc.facet] : [];

/** Combine rule: evidence and releases added, `breaking` if either, the incoming subject and facet join the terms. */
export function combine(r: StoredRecord, inc: Incoming, labels: Labels, components: string[], p?: number, judged: Judged[] = [], lineOf?: (version: string) => string): void {
  // A later version of a document the record cites, stating the fact more specifically, gives the record its summary:
  // the document now says this.
  const restated = sameLineage({ ...inc, breaking: labels.breaking, kind: kindOf(inc) }, r) && moreSpecific(inc.summary, r.summary);
  if (!r.evidence.some((e) => e.url === inc.url && e.quote === inc.quote)) r.evidence.push(evidenceOf(inc));
  const terms = union(r.terms, literal(inc).filter((t) => t !== r.subject));
  const extra = inc.terms.filter((t) => !terms.includes(t));
  const benefit = labels.benefit.includes("none") ? r.benefit : union(r.benefit.filter((b) => b !== "none"), labels.benefit);
  applyChange(
    r,
    {
      releases: combineReleases(r.releases, releasesOf(inc, components), lineOf),
      breaking: r.breaking || labels.breaking,
      terms: union(terms, extra.slice(0, Math.max(0, 12 - terms.length))),
      replaces: union(r.replaces, inc.replaces),
      requires: union(r.requires, inc.requires),
      introduces: union(r.introduces, inc.introduces),
      prerequisites: [...r.prerequisites, ...inc.prerequisites.filter((p) => !r.prerequisites.some((q) => q.ecosystem === p.ecosystem && q.name === p.name))],
      conditions: union(r.conditions, inc.conditions),
      benefit,
      ...(restated ? { summary: inc.summary } : {}),
    },
    "match",
    { detail: p === undefined ? inc.key : `${inc.key} p=${p}` },
  );
  r.sources = union(r.sources, [inc.key]);
  // The match's history entry (or a plain one when no counter moved) keeps every candidate's judgement.
  const last = r.history.at(-1);
  if (judged.length && last?.action === "match" && last.detail?.startsWith(inc.key)) last.judged = judged;
  else if (judged.length) r.history.push({ action: "match", detail: inc.key, revision: r.revision, label_version: r.label_version, judged });
}

export function create(s: TechStore, inc: Incoming, labels: Labels, components: string[]): StoredRecord {
  const id = mintId(inc.technology, inc.subject, inc.facet, (x) => x in s.records);
  const r: StoredRecord = {
    id,
    technology: inc.technology,
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: labels.change_type,
    breaking: labels.breaking,
    surface: labels.surface,
    subject: inc.subject,
    subject_kind: inc.subject_kind,
    ...(inc.facet ? { facet: inc.facet } : {}),
    summary: inc.summary,
    benefit: labels.benefit,
    releases: combineReleases([], releasesOf(inc, components), lineFn(s)),
    prerequisites: inc.prerequisites,
    conditions: inc.conditions,
    requires: inc.requires,
    introduces: inc.introduces,
    terms: inc.terms,
    replaces: inc.replaces,
    evidence: [evidenceOf(inc)],
    related: [],
    classifier: labels.classifier,
    sources: [inc.key],
    history: [{ action: "created", detail: inc.key, revision: 1, label_version: 1 }],
  };
  s.records[id] = r;
  return r;
}

export interface MatchOutcome {
  key: string;
  id: string;
  matched: boolean;
  candidates: number;
  judged: Judged[];
  related: string[];
}

/**
 * Ingests one incoming record into the store: match or create; links finer/broader candidates via `related`.
 * `questionFloor: false` asks every candidate, as ingest did before QUESTION_FLOOR: for replaying stores built then.
 */
export async function ingest(
  s: TechStore,
  techName: string,
  components: string[],
  inc: Incoming,
  labels: Labels,
  judge: (state: Record<string, unknown>, questions: Questions) => Promise<Classification>,
  { questionFloor = true }: { questionFloor?: boolean } = {},
): Promise<MatchOutcome> {
  const prev = s.ingested[inc.key];
  if (prev) return { key: inc.key, id: prev, matched: false, candidates: 0, judged: [], related: [] };
  const found = retrieve(inc, Object.values(s.records));
  const cands = found.map((c) => s.records[c.id]!);
  let chosen: { id?: string; p?: number; judged: Judged[] } = { judged: [] };
  if (cands.length) {
    const req = matchRequest(techName, inc, labels.breaking, cands, questionFloor ? found.map((c) => c.score) : undefined);
    // No candidate at the question floor: nothing to ask, the record is new.
    const verdict: Pick<Classification, "answers" | "calibrated"> = Object.keys(req.questions).length ? await judge(req.state, req.questions) : { answers: {} };
    chosen = pick(cands, verdict.answers, { breaking: labels.breaking, quote: inc.quote, summary: inc.summary, kind: kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version }, verdict.calibrated !== false);
  }
  if (chosen.id) {
    const r = s.records[chosen.id]!;
    combine(r, inc, labels, components, chosen.p, chosen.judged, lineFn(s));
    s.ingested[inc.key] = r.id;
    return { key: inc.key, id: r.id, matched: true, candidates: cands.length, judged: chosen.judged, related: [] };
  }
  const r = create(s, inc, labels, components);
  if (chosen.judged.length) r.history[0]!.judged = chosen.judged;
  const related = cands.filter((c) => finerOrBroader(inc, c)).map((c) => c.id).sort();
  if (related.length) {
    r.related = related;
    for (const id of related) {
      const o = s.records[id]!;
      applyChange(o, { related: union(o.related, [r.id]) }, "related", { detail: r.id });
    }
  }
  s.ingested[inc.key] = r.id;
  return { key: inc.key, id: r.id, matched: false, candidates: cands.length, judged: chosen.judged, related };
}

/** Numeric-aware order of extraction keys (`tech@1.2.0#0.10` after `#0.9`): which record of a group came first. */
const keyOrder = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/**
 * Records cut from one release-note item: the extractor sometimes makes one record per API an item names ("Add
 * `codePoints`, `maxCodePoints`, `minCodePoints` and `notCodePoints` validation actions" became four records), each with
 * the item's quote and the same summary and labels. Ingest never compares them (`retrieve` skips records of the same
 * snapshot), and to a reader they are one change shown several times. Active records that share an evidence entry
 * (snapshot and normalised quote) and have the same summary, change_type and breaking flag are merged into the first
 * extracted one: the others' subjects join its terms and their replaces, requires, introduces, conditions,
 * prerequisites and benefits are kept. No model call. Returns the merges made, in order.
 */
export function mergeSplitRecords(s: TechStore): Array<{ from: string; into: string }> {
  const active = Object.values(s.records)
    .filter((r) => r.status === "active")
    .sort((a, b) => keyOrder(a.sources[0] ?? "", b.sources[0] ?? "") || a.id.localeCompare(b.id));
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const first = new Map<string, string>();
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    let x = id;
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const r of active) {
    parent.set(r.id, r.id);
    for (const e of r.evidence) {
      const q = normQuote(e.quote);
      if (!q || !e.snapshot) continue;
      const k = [e.snapshot, q, norm(r.summary), r.change_type, r.breaking].join("\u0000");
      const seen = first.get(k);
      if (seen === undefined) first.set(k, r.id);
      else {
        // The earlier record (in extraction order) stays the root.
        const [a, b] = [root(seen), root(r.id)];
        if (a !== b) parent.set(b, a);
      }
    }
  }
  const out: Array<{ from: string; into: string }> = [];
  for (const r of active) {
    const into = root(r.id);
    if (into === r.id) continue;
    const t = s.records[into]!;
    const benefit = r.benefit.includes("none") ? t.benefit : union(t.benefit.filter((b) => b !== "none"), r.benefit);
    applyChange(t, {
      replaces: union(t.replaces, r.replaces),
      requires: union(t.requires, r.requires),
      introduces: union(t.introduces, r.introduces),
      conditions: union(t.conditions, r.conditions),
      prerequisites: [...t.prerequisites, ...r.prerequisites.filter((p) => !t.prerequisites.some((q) => q.ecosystem === p.ecosystem && q.name === p.name))],
      benefit,
    }, "split-merge");
    mergeInto(s, r.id, into, "cut from the same release-note item");
    out.push({ from: r.id, into });
  }
  return out;
}

/** A stored record as the incoming item it was created from (its first source and evidence). */
function asIncoming(r: StoredRecord): Incoming {
  const e = r.evidence[0]!;
  const rel = r.releases[0]!;
  const kind = e.kind === "upgrade_guide" || e.kind === "docs" ? e.kind : undefined;
  return {
    key: r.sources[0]!, technology: r.technology, version: rel.version, date: rel.date, line: rel.line, url: e.url, snapshot: e.snapshot,
    subject: r.subject, subject_kind: r.subject_kind === "literal" ? "literal" : "concept", ...(r.facet ? { facet: r.facet } : {}), summary: r.summary, introduces: r.introduces,
    quote: e.quote, grounded: true, terms: r.terms, replaces: r.replaces, requires: r.requires, prerequisites: [],
    conditions: r.conditions, ...(kind ? { kind } : {}),
  };
}

/**
 * Records ingested before `retrieve` asked about other chunks of the same document (`otherChunkSameSubject`): each
 * later record is asked against each earlier one of the same snapshot, subject and facet, one candidate per request,
 * with ingest's rules, threshold and guards, and merged into it when judged the same. A pair already judged (in either
 * record's history) is not asked again. Returns every judgement, merged or not. eval/dedupe/RESULTS.md: 541 pairs on
 * the full store, 182 merged, one Jev request each (about 1.5K input tokens).
 */
export async function mergeChunkDuplicates(
  s: TechStore,
  techName: string,
  judge: (state: Record<string, unknown>, questions: Questions) => Promise<Classification>,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<Array<{ from: string; into: string; p: number; outcome: Judged["outcome"] }>> {
  const order = (a: StoredRecord, b: StoredRecord) => keyOrder(a.sources[0] ?? "", b.sources[0] ?? "") || a.id.localeCompare(b.id);
  // Groups by snapshot, subject and facet: only records sharing all three can be such a pair.
  const groups = new Map<string, StoredRecord[]>();
  for (const r of Object.values(s.records).filter((x) => x.status === "active" && x.sources.length && x.evidence.length).sort(order)) {
    for (const snap of new Set(r.evidence.map((e) => e.snapshot))) {
      const k = [snap, r.subject.toLowerCase(), (r.facet ?? "").toLowerCase()].join("\u0000");
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
  }
  const asked = (r: StoredRecord, c: StoredRecord) => r.history.some((h) => (h.action === "chunk-match" && h.detail === c.id) || h.judged?.some((j) => j.id === c.id));
  const out: Array<{ from: string; into: string; p: number; outcome: Judged["outcome"] }> = [];
  for (const g of [...groups.values()].filter((x) => x.length > 1)) {
    for (const [i, r] of g.entries()) {
      const inc = asIncoming(r);
      for (const c of g.slice(0, i)) {
        if (r.status !== "active") break;
        if (c.status !== "active" || !c.evidence.some((e) => e.snapshot === inc.snapshot)) continue;
        if (!otherChunkSameSubject(inc, c) || asked(r, c)) continue;
        const req = matchRequest(techName, inc, r.breaking, [c], [1]);
        const v = await judge(req.state, req.questions);
        const got = pick([c], v.answers, { breaking: r.breaking, quote: inc.quote, summary: inc.summary, kind: kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version }, v.calibrated !== false);
        const j = got.judged[0]!;
        out.push({ from: r.id, into: c.id, p: j.p, outcome: j.outcome });
        if (dryRun) continue;
        r.history.push({ action: "chunk-match", detail: c.id, revision: r.revision, label_version: r.label_version, judged: got.judged });
        if (j.outcome === "same") mergeInto(s, r.id, c.id, `the same change in another part of the same release notes (p=${j.p})`);
      }
    }
  }
  return out;
}
