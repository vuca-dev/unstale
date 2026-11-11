// Every model-facing text central sends (prompts, structured-output schemas, label questions, rubrics, definitions,
// judge rules) and the classifier thresholds, read from the data files in schema/prompts/. The client reads the same
// files (local/cli/src/prompts.rs), so both build the same requests. The cache keys of the extraction model and of
// Jev hash these bytes: an edit to a file empties those caches for every request it touches
// (test/prompt-snapshot.test.ts fails on any such change).
//
// Format: JSON; each file has an integer `version`, raised whenever its text changes. A text is a string, or an
// array of lines joined with "\n". `%NAME%` marks a value filled at the call site. A variant is a list of edits
// applied in order to a base template: each replaces the first occurrence of `find` with `replace`, and an edit
// whose `find` is not found is an error.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the files are read from: UNSTALE_PROMPTS_DIR, else the repository's schema/prompts. The central image keeps
 * the repository layout (/app/central beside /app/schema/prompts), so the default holds there too. */
export const promptsDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.UNSTALE_PROMPTS_DIR ? resolve(env.UNSTALE_PROMPTS_DIR) : fileURLToPath(new URL("../../../schema/prompts/", import.meta.url));
const DIR = promptsDir();

const Text = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v.join("\n") : v));
const Version = z.number().int().positive();
const Option = z.object({ id: z.string().min(1), text: z.string().min(1) }).strict();
const Edit = z.object({ find: Text, replace: Text }).strict();
export type Edit = z.infer<typeof Edit>;

const ExtractFile = z
  .object({
    version: Version,
    extract: Text,
    label: Text,
    part_line: Text,
    piece_line: Text,
    docs_preamble: Text,
    docs_preamble_marked: Text,
    variants: z.object({ one_call: z.array(Edit), one_call_schema: z.array(Edit), evidence_ids: z.array(Edit), diet_full: z.array(Edit), diet_compact: z.array(Edit), batch: z.array(Edit) }).strict(),
    /** One chunk of a batch (the client's Codex route): `%ID%`, `%TECH%`, `%VERSION%`, `%DATE%`, `%NOTES%`. */
    batch_chunk: Text,
    one_call_schema_response_format: z
      .object({
        type: z.literal("json_schema"),
        json_schema: z.object({ name: z.string(), strict: z.boolean(), schema: z.object({ required: z.array(z.string()) }).loose() }).strict(),
      })
      .strict(),
  })
  .strict();

const LabelsFile = z
  .object({
    version: Version,
    change_types: z.array(Option),
    surfaces: z.array(Option),
    benefits: z.array(Option),
    benefit_rule: Text,
    breaking_rubric: Text,
    sources: z.object({ release_notes: z.string(), upgrade_guide: z.string(), docs: z.string() }).strict(),
    questions: z
      .object({ change_type: Text, surface: Text, breaking: Text, breaking_options: z.array(Option), benefit: Text, benefit_options: z.array(Option) })
      .strict(),
  })
  .strict();

const JudgeFile = z
  .object({
    version: Version,
    rules: Text,
    cross_source_rule: Text,
    advisory_rule: Text,
    question: Text,
    short_question: Text,
    short_cross_rule: Text,
    options: z.array(Option),
    sources: z.object({ release_notes: z.string(), upgrade_guide: z.string(), docs: z.string(), changelog: z.string(), advisory: z.string(), other: z.string() }).strict(),
  })
  .strict();

const PromptFile = z.object({ version: Version, prompt: Text }).strict();
/** The choice prompt, and its batched form (the client's Codex route: several records, answered by record id). */
const ChoiceFile = z.object({ version: Version, prompt: Text, batch: z.array(Edit) }).strict();

const Probability = z.number().min(0).max(1);
const ThresholdsFile = z
  .object({
    version: Version,
    breaking_p: Probability,
    benefit_p: Probability,
    borderline: z.tuple([Probability, Probability]),
    choice_confidence: Probability,
    same_p: Probability,
    cross_same_p: Probability,
    same_p_short: Probability,
    cross_same_p_short: Probability,
    quote_guard_below: Probability,
    quote_guard_below_short: Probability,
    quote_similarity: Probability,
    question_floor: z.number().nonnegative(),
    lineage_same_p: Probability,
    /** The judge's bars for a text model read on its choices (the client's route without the labelling service). */
    chat_judge: z.object({ same_p: Probability, cross_same_p: Probability, quote_guard_below: z.number().min(0).max(1.01) }).strict(),
  })
  .strict();

function load<T extends z.ZodType>(file: string, schema: T): z.output<T> {
  const path = join(DIR, file);
  if (!existsSync(path)) throw new Error(`schema/prompts/${file} not found at ${path}: central needs the repository's schema/prompts (set UNSTALE_PROMPTS_DIR to its location)`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`schema/prompts/${file}: ${r.error.message}`);
  return r.data;
}

export const PROMPT_FILES = ["extract.json", "labels.json", "judge.json", "choice.json", "advisory-apis.json", "thresholds.json"] as const;

export const extractText = load("extract.json", ExtractFile);
export const labelsText = load("labels.json", LabelsFile);
export const judgeText = load("judge.json", JudgeFile);
export const choiceText = load("choice.json", ChoiceFile);
export const advisoryApisText = load("advisory-apis.json", PromptFile);
export const thresholdsData = load("thresholds.json", ThresholdsFile);

/** A variant of a template: its edits applied in order. */
export function applyEdits(template: string, edits: readonly Edit[], what: string): string {
  let out = template;
  for (const e of edits) {
    const at = out.indexOf(e.find);
    if (at < 0) throw new Error(`schema/prompts: ${what}: edit target not found (${JSON.stringify(e.find.slice(0, 60))})`);
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return out;
}

/** `%NAME%` placeholders filled from `v` (a name absent from `v` becomes ""); inserted values are not scanned again. */
export const fill = (tpl: string, v: Record<string, string>): string => tpl.replace(/%([A-Z]+)%/g, (_, k: string) => v[k] ?? "");

/** Ordered options as the record a question carries (insertion order is the file's). */
export const optionRecord = (opts: readonly { id: string; text: string }[]): Record<string, string> => Object.fromEntries(opts.map((o) => [o.id, o.text]));
