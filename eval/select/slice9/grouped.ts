// Slice 9: step D with the fixed rule text paid once per group of records, not once per record (PREREG.md).
//
// A group is N records of one technology. The eight label fields are split into N field groups of 8/N fields; one
// request per field group carries every record of the group in its state, the rule text of its fields once
// (`state.rubric`), and one short question per record and field (8/N fields × N records = 8 questions, Jev's limit).
// Answers are reassembled per record into the pipeline's own Classification shape (same question ids and options as
// labelQuestions()), so `interpret` and the thresholds are unchanged.
import type { Answer, Classification, Classifier, Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { labelQuestions } from "../../../central/src/pipeline/classify/labels.ts";
import { BENEFIT_DEFS, BENEFIT_RULE, BENEFITS, BREAKING_RUBRIC, CHANGE_TYPES, SURFACES } from "../../../central/src/pipeline/vocab.ts";

export const FIELDS = ["change_type", "surface", "breaking", ...BENEFITS.map((b) => `benefit_${b}`)] as const;

export interface Variant {
  /** Records per group (1, 2, 4 or 8). */
  n: number;
  /** Fields of each request, in order; their sizes times n must be at most 8. Default: FIELDS cut into n equal runs. */
  fieldGroups?: string[][];
  /** Fields asked per record with today's full question text (instructions and described options), not in the rubric. */
  inline?: string[];
  /** change_type / surface instructions that point at the descriptions ("…whose description in rubric.… fits best"). */
  pointer?: boolean;
  /** change_type / surface criteria: empty (default) or a pointer to the option's rubric entry. */
  criteria?: "empty" | "ref";
}

export function fieldGroups(v: Variant): string[][] {
  if (v.fieldGroups) return v.fieldGroups;
  const m = 8 / v.n;
  return Array.from({ length: v.n }, (_, i) => FIELDS.slice(i * m, (i + 1) * m));
}

/** The rule text of the given fields, stated once: the pipeline's own wording (labels.ts / vocab.ts). */
export function rubric(fields: string[], v: Variant = { n: 1 }): Record<string, unknown> {
  fields = fields.filter((f) => !v.inline?.includes(f));
  const r: Record<string, unknown> = {};
  if (fields.includes("change_type")) r.change_type = { question: "What kind of change is this? Pick the one type that fits best.", types: { ...CHANGE_TYPES } };
  if (fields.includes("surface"))
    r.surface = { question: "Where does a project that uses this technology meet this change? Pick the one surface that fits best.", surfaces: { ...SURFACES } };
  if (fields.includes("breaking")) r.breaking = { question: "Is this change breaking?", rule: BREAKING_RUBRIC };
  const bs = BENEFITS.filter((b) => fields.includes(`benefit_${b}`));
  if (bs.length)
    r.benefit = { question: "Does this change bring the named benefit?", definitions: Object.fromEntries(bs.map((b) => [b, BENEFIT_DEFS[b]])), rule: BENEFIT_RULE };
  return r;
}

const SHORT: Record<string, (rid: string) => string> = {
  change_type: (r) => `Record ${r}: what kind of change? Use rubric.change_type.`,
  surface: (r) => `Record ${r}: which surface? Use rubric.surface.`,
  breaking: (r) => `Record ${r}: breaking? Use rubric.breaking.`,
};
const POINTER: Record<string, (rid: string) => string> = {
  change_type: (r) => `Record ${r}: which type's description in rubric.change_type.types fits its change best?`,
  surface: (r) => `Record ${r}: which surface's description in rubric.surface.surfaces fits best?`,
};
const shortQ = (field: string, rid: string, v: Variant): string =>
  (v.pointer ? POINTER[field]?.(rid) : undefined) ?? SHORT[field]?.(rid) ?? `Record ${rid}: a ${field.slice("benefit_".length)} benefit? Use rubric.benefit.`;

/** Option keys of a field; the descriptions are in the rubric, so the criteria are empty (Jev accepts "": each
 * described option costs about 10 Jev tokens more per question). */
function shortOptions(field: string, v: Variant): Record<string, string> {
  const crit = (path: string, k: string) => (v.criteria === "ref" ? `As ${path}.${k} describes.` : "");
  if (field === "change_type") return Object.fromEntries(Object.keys(CHANGE_TYPES).map((k) => [k, crit("rubric.change_type.types", k)]));
  if (field === "surface") return Object.fromEntries(Object.keys(SURFACES).map((k) => [k, crit("rubric.surface.surfaces", k)]));
  return { yes: "Yes.", no: "No." };
}

export interface Request {
  state: Record<string, unknown>;
  questions: Questions;
  /** question id → [record index in the group, field] */
  map: Record<string, [number, string]>;
}

/** The requests for one group of record states (each from recordState; they share `technology`). */
export function requests(states: Record<string, unknown>[], v: Variant): Request[] {
  if (states.length > v.n) throw new Error(`group of ${states.length} > n ${v.n}`);
  const tech = states[0]!.technology;
  const records = Object.fromEntries(
    states.map((s, i) => {
      const { technology: _t, ...rest } = s;
      return [`r${i + 1}`, rest];
    }),
  );
  return fieldGroups(v).map((fields) => {
    const questions: Questions = {};
    const map: Request["map"] = {};
    for (let i = 0; i < states.length; i++)
      for (const f of fields) {
        const id = `r${i + 1}_${f}`;
        const full = labelQuestions()[f]!;
        questions[id] = v.inline?.includes(f)
          ? { instructions: `Record r${i + 1}: ${full.instructions}`, options: full.options }
          : { instructions: shortQ(f, `r${i + 1}`, v), options: shortOptions(f, v) };
        map[id] = [i, f];
      }
    if (Object.keys(questions).length > 8) throw new Error("more than 8 questions");
    return { state: { technology: tech, rubric: rubric(fields, v), records }, questions, map };
  });
}

/** Asks a group's requests and returns one Classification per record, in labelQuestions()' ids and option keys. */
export async function classifyGroup(cls: Classifier, states: Record<string, unknown>[], v: Variant, ask?: (r: Request) => Promise<Classification>): Promise<Classification[]> {
  const out: Array<Record<string, Answer>> = states.map(() => ({}));
  let model = cls.model;
  for (const r of requests(states, v)) {
    const c = ask ? await ask(r) : await cls.classify(r.state, r.questions);
    model = c.model;
    for (const [id, [i, f]] of Object.entries(r.map)) out[i]![f] = c.answers[id]!;
  }
  const want = Object.keys(labelQuestions());
  return out.map((answers) => {
    for (const f of want) if (!answers[f]) throw new Error(`missing ${f}`);
    return { classifier: cls.name, model, answers };
  });
}

/** Consecutive runs of at most n units sharing a technology, in the given order. */
export function groupUnits<T>(units: T[], tech: (u: T) => string, n: number): T[][] {
  const out: T[][] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.length < n && tech(last[0]!) === tech(u)) last.push(u);
    else out.push([u]);
  }
  return out;
}

/** The arms (PREREG.md). Revisions are added here, never edited after a held-out look. */
export const VARIANTS: Record<string, Variant> = {
  g2: { n: 2 },
  g4: { n: 4 },
  // Dev revision 1 (diag.mts: with empty criteria, change_type and surface drift from today's answers even for one
  // record per request, so the drift is the descriptions' placement, not grouping): change_type and surface asked with
  // today's described options; only breaking's and the benefits' rule text is shared.
  g2i: { n: 2, inline: ["change_type", "surface"] },
  g4i: { n: 4, inline: ["change_type", "surface"] },
};
