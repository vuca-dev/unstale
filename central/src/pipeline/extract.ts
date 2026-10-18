// Extraction and free-text labelling on the configured model (llm.ts). Prompts ported from ~/ati-slice2/harness/dm_ident.py (NEW: subject,
// subject_kind, facet) and ~/ati-slice0/harness/fw_spike.py (PROMPT, LABEL_PROMPT_V2). Extraction's own `breaking`
// is not asked: it is set by the classifier.
// The extraction model's output schemas are hand-written Zod.
import { z } from "zod";
import { extractCached, extractLlm, extractTruncated, parseJson } from "./llm.ts";
import type { GuideNote, ReleaseNote } from "./fetch.ts";
import type { Technology } from "./technologies.ts";
import { CHANGE_TYPES, SURFACES } from "./vocab.ts";
import { oneLine, releaseLine } from "./util.ts";
import { markViews, PREAMBLE_MARKED, unmarkQuote } from "../docs/render.ts";

export const MAX_CHUNK = 30_000;

export const EXTRACT_PROMPT = `You extract change records from official release notes. Output only a JSON array, no prose.

Technology: %TECH%
Release: %VERSION% (%DATE%)%PART%

Emit one record for each distinct change in these notes that could alter what a developer using this technology
writes, configures, runs or decides. Skip internal refactors, documentation, examples, tests, build chores, dependency
bumps of the project's own repository and contributor news. If nothing qualifies, output [].

Each record:
{
 "subject": the one thing that changed, exactly as a developer writes it in code, configuration or a terminal:
            an API (\`after\`, \`PrismaClient\`), a configuration key as a full dotted path (\`images.remotePatterns\`),
            a command with its subcommands (\`prisma migrate diff\`), a file name (\`proxy.ts\`), an environment variable,
            a package name, a decorator or directive. No backticks, no call parentheses, no version numbers.
            If the change has no such name (a general behaviour, a runtime requirement), a short lowercase phrase
            naming the feature as the documentation names it.
 "subject_kind": "literal" if subject is a name a developer writes, "concept" if it is a phrase,
 "facet": when the change is to one option, flag, parameter or field OF the subject, that name exactly as written
          (\`--turbopack\`, \`cache\`, \`env\`); otherwise null,
 "change_type": one of ${Object.keys(CHANGE_TYPES).join(" | ")},
 "surface": where a project meets this change, one of ${Object.keys(SURFACES).join(" | ")},
 "summary": at most 40 words, what changed and why a developer would care, using only what the notes say,
 "audience": "application" for ordinary users of the framework/API, "extension_author" when authoring custom
             providers, plugins, adapters or integrations, "maintainer" for technology-internal work,
             or "general" when the source does not establish a narrower audience,
 "introduces": [literal identifiers, options, file names or flags that exist only from this release; [] if none],
 "evidence": a sentence or phrase copied verbatim from the notes that supports the record
}

Release notes:
<notes>
%NOTES%
</notes>
`;

// The meaning of `requires`: applies only to projects that already use X. At the edge a record whose `requires` matches
// nothing in the repository goes to the end of the review, so a value the change has the project add (the opposite of a
// precondition) demotes a required migration (eval/rank/RESULTS.md).
export const REQUIRES_RULE = `"requires" (usually []): literals a project must ALREADY use for this change to apply to it at all: a database driver
or adapter package, a dialect, a platform (for example \`oracledb\`, \`@prisma/adapter-d1\`, \`fastify\`). [] unless
the notes limit the change to such projects. Never list what the change asks the project to add, install, load or
switch to (a package it must now install, a loader it must now call, the replacement for a removed package): those go
in "introduces" or "terms", and the old name in "replaces". Write each value as a project's code or package.json
contains it (\`pg\`, \`postgresql\` as in \`provider = "postgresql"\`, \`sqlite\`, \`better-sqlite3\`), never as a product
name (PostgreSQL, SQLite, SQL Server).`;

export const LABEL_PROMPT = `You write search terms and applicability labels for change records. A local tool will search a project's
source files and file paths for the terms as exact text. Each match is weighted by how rare the term is across projects
that use the technology, so broad terms cost little and specific terms count most. Output only a JSON object that maps
each record id to {"terms": [...], "replaces": [...], "requires": [...], "prerequisites": [...], "conditions": [...]}, no prose.

Technology: %TECH%
Release: %VERSION%

Rules for "terms" (up to 12 per record, most specific first):
- Each term is text that literally occurs in a project's own code, configuration or file tree, written the way
  projects write it: a call as code makes it, an import specifier, a configuration key, a file name, a command as
  typed in a script, a directive string. Never a product or feature name, and never a documentation reference name
  that does not appear in project code.
- Cover the different ways projects write the same thing: qualified and unqualified names, the import specifier
  and the imported name, a configuration key as a nested key and as a dotted path, alternative file extensions.
- Choose text present in projects this change concerns today: the API it alters; for a new option, the function,
  hook, class or configuration object that receives it and its sibling options; for a new API, the existing APIs it
  is used with or would replace.
- After the specific terms you may add broader ones for the same feature area; they are down-weighted, not ignored.
- Never use names listed in "introduces": projects cannot contain them yet.
- Give [] only if the change concerns no project-visible text at all.

"replaces" (0 to 4 terms): upstream literals that existing code contains and that this change makes obsolete, such as
an older API, option, file name or a package used for the same job. Same literal rules. [] when there is no old literal
(most behaviour changes, new requirements, constructor arguments).

${REQUIRES_RULE}

"prerequisites" (usually []): version requirements the notes state, written as a project's manifest declares them:
{"ecosystem": "npm", "name": "<name as written in package.json dependencies or engines>", "min": "<version>", "max": "<version>"}.
Examples: {"ecosystem": "npm", "name": "node", "min": "20.9.0"} for engines.node; {"ecosystem": "npm", "name": "typescript",
"min": "5.1.0"}; {"ecosystem": "npm", "name": "react", "min": "19.0.0"}. Omit "min" or "max" when the notes do not state
it. Only requirements the notes state.

"conditions" (usually []): requirements that cannot be checked from a manifest (a database server version, an
operating system, a hosting platform), as short phrases from the notes.

Records:
%RECORDS%

Release notes:
<notes>
%NOTES%
</notes>
`;

// One call per chunk: EXTRACT_PROMPT with LABEL_PROMPT's five fields and their rules folded into each record, so the
// notes are read once. Assembled from the two prompts at load time, so a change to either flows into it; a marker that
// is no longer found throws. Selected by UNSTALE_EXTRACT_STRUCTURE=one-call (default: two calls).
function between(s: string, from: string, to: string): string {
  const a = s.indexOf(from);
  const b = s.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`extract.ts: marker not found in a prompt (${JSON.stringify(from)} … ${JSON.stringify(to)})`);
  return s.slice(a, b);
}
const RECORD_END = '\n "evidence": a sentence or phrase copied verbatim from the notes that supports the record\n}\n';
if (!EXTRACT_PROMPT.includes(RECORD_END)) throw new Error("extract.ts: EXTRACT_PROMPT's record schema changed");
export const ONE_CALL_PROMPT = EXTRACT_PROMPT.replace(
  RECORD_END,
  RECORD_END.replace(/\n\}\n$/, ",\n") +
    ` "terms": [search terms, rules below],
 "replaces": [0 to 4 literals, rules below],
 "requires": [rules below],
 "prerequisites": [rules below],
 "conditions": [rules below]
}

The last five fields are search terms and applicability labels. ${between(LABEL_PROMPT, "A local tool will search", " Output only a JSON object").trim()}

${between(LABEL_PROMPT, 'Rules for "terms"', "\n\nRecords:").trim()}
`,
);

// One call, records first (UNSTALE_EXTRACT_STRUCTURE=one-call-schema): one JSON object {records, labels} under a strict
// response schema; every record is listed before any label is written, and labels name their record by id, so the
// labels restate nothing. Assembled from EXTRACT_PROMPT and LABEL_PROMPT like ONE_CALL_PROMPT.
const EXTRACT_HEAD = "You extract change records from official release notes. Output only a JSON array, no prose.";
if (!EXTRACT_PROMPT.startsWith(EXTRACT_HEAD)) throw new Error("extract.ts: EXTRACT_PROMPT's first line changed");
export const SCHEMA_PROMPT = EXTRACT_PROMPT.replace(
  EXTRACT_HEAD,
  `You extract change records from official release notes, then label them. Output only a JSON object, no prose:
{"records": [...], "labels": [...]}. First list EVERY record in "records"; only then write "labels".`,
)
  .replace("If nothing qualifies, output [].", 'If nothing qualifies, output {"records": [], "labels": []}.')
  .replace("Each record:\n{\n", 'Each record:\n{\n "id": "r1", "r2", … in order,\n')
  .replace(
    RECORD_END,
    RECORD_END +
      `
Then "labels": one entry per record, in the same order: {"id": the record's id, "terms": [...], "replaces": [...],
"requires": [...], "prerequisites": [...], "conditions": [...]}. These are search terms and applicability labels.
${between(LABEL_PROMPT, "A local tool will search", " Output only a JSON object").trim()}

${between(LABEL_PROMPT, 'Rules for "terms"', "\n\nRecords:").trim().replace('Omit "min" or "max" when the notes do not state\nit.', 'Use null for "min" or "max" when the notes do not state it.')}
`,
  );
if (!SCHEMA_PROMPT.includes('"id": "r1"') || !SCHEMA_PROMPT.includes('Then "labels"') || !SCHEMA_PROMPT.includes("Use null for")) throw new Error("extract.ts: SCHEMA_PROMPT assembly failed");

const str = { type: "string" };
const strs = { type: "array", items: str };
const nullable = { type: ["string", "null"] };
const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
/** The strict response schema (OpenAI `response_format: json_schema`) for SCHEMA_PROMPT. */
export const SCHEMA_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "change_records",
    strict: true,
    schema: obj({
      records: {
        type: "array",
        items: obj({
          id: str,
          subject: str,
          subject_kind: { type: "string", enum: ["literal", "concept"] },
          facet: nullable,
          change_type: { type: "string", enum: Object.keys(CHANGE_TYPES) },
          surface: { type: "string", enum: Object.keys(SURFACES) },
          summary: str,
          audience: { type: "string", enum: ["application", "extension_author", "maintainer", "general"] },
          introduces: strs,
          evidence: str,
        }),
      },
      labels: {
        type: "array",
        items: obj({
          id: str,
          terms: strs,
          replaces: strs,
          requires: strs,
          prerequisites: { type: "array", items: obj({ ecosystem: str, name: str, min: nullable, max: nullable }) },
          conditions: strs,
        }),
      },
    }),
  },
} as const;

/** A records-first answer: each record with the labels that name its id (or none). */
export function parseSchemaAnswer(text: string): Array<{ record: Extracted; labels: Record<string, unknown> | undefined }> | undefined {
  const v = parseJson(text, "object") as { records?: unknown; labels?: unknown } | undefined;
  if (!v || !Array.isArray(v.records)) return undefined;
  const labels = new Map<string, Record<string, unknown>>();
  for (const l of Array.isArray(v.labels) ? v.labels : []) if (l && typeof l === "object" && typeof (l as { id?: unknown }).id === "string") labels.set((l as { id: string }).id, l as Record<string, unknown>);
  return v.records.flatMap((r) => {
    const p = Extracted.safeParse(r);
    return p.success ? [{ record: p.data, labels: labels.get(String((r as { id?: unknown }).id)) }] : [];
  });
}

export type ExtractStructure = "two-call" | "one-call" | "one-call-schema";
export const extractStructure = (): ExtractStructure => {
  const s = process.env.UNSTALE_EXTRACT_STRUCTURE;
  return s === "one-call" || s === "one-call-schema" ? s : "two-call";
};

// Evidence by unit id: the notes go to the extract call with each unit numbered (a line, or one sentence of a line
// longer than UNIT_MAX), and the record names the unit instead of copying it; the quote is rebuilt from the notes, so
// it is grounded by construction. Selected by UNSTALE_EXTRACT_EVIDENCE=ids (default: a verbatim quote).
export const UNIT_MAX = 240;
export const MAX_UNITS_PER_QUOTE = 3;
const EVIDENCE_QUOTE = '"evidence": a sentence or phrase copied verbatim from the notes that supports the record';
export const EXTRACT_PROMPT_IDS = EXTRACT_PROMPT.replace(
  EVIDENCE_QUOTE,
  `"evidence": the numbers of the 1 to ${MAX_UNITS_PER_QUOTE} numbered lines that best support the record, the most telling first,
             as [12] or [12, 15]; usually one line. Never a range`,
).replace("Release notes:\n<notes>", "Release notes (each line starts with its number and \"|\"):\n<notes>");
if (EXTRACT_PROMPT_IDS === EXTRACT_PROMPT) throw new Error("extract.ts: EXTRACT_PROMPT's evidence field changed");

// Output diet (UNSTALE_EXTRACT_DIET=1): the extract call no longer writes change_type and surface, which only became
// unread hints (the classifier labels both), and writes compact JSON (one line, no indentation).
const HINT_LINES = `\n "change_type": one of ${Object.keys(CHANGE_TYPES).join(" | ")},\n "surface": where a project meets this change, one of ${Object.keys(SURFACES).join(" | ")},`;
export const dietPrompt = (p: string, mode: "full" | "compact" = "full"): string => {
  const out = (mode === "full" ? p.replace(HINT_LINES, "") : p).replace(EXTRACT_HEAD, "You extract change records from official release notes. Output only a JSON array on one line, with no indentation\nor line breaks, no prose.");
  if ((mode === "full" && out.includes('"change_type": one of')) || !out.includes("JSON array on one line")) throw new Error("extract.ts: diet markers not found");
  return out;
};
/** UNSTALE_EXTRACT_DIET: "1" drops the hint fields and asks for compact JSON; "compact" only asks for compact JSON. */
export const extractDiet = (): "full" | "compact" | undefined => (process.env.UNSTALE_EXTRACT_DIET === "1" ? "full" : process.env.UNSTALE_EXTRACT_DIET === "compact" ? "compact" : undefined);

export type ExtractEvidence = "quote" | "ids";
export const extractEvidence = (): ExtractEvidence => (process.env.UNSTALE_EXTRACT_EVIDENCE === "ids" ? "ids" : "quote");

/** The notes as numbered units: a line, or a sentence of a line longer than UNIT_MAX; blank lines are not numbered. */
export function numberUnits(notes: string): { text: string; units: string[] } {
  const units: string[] = [];
  const out: string[] = [];
  for (const line of notes.split("\n")) {
    if (!line.trim()) {
      out.push("");
      continue;
    }
    const parts = line.length > UNIT_MAX ? line.split(/(?<=[.!?:;])\s+(?=\S)/) : [line];
    for (const p of parts) {
      units.push(p);
      out.push(`${units.length}| ${p}`);
    }
  }
  return { text: out.join("\n"), units };
}

/** The quote evidence ids name ([12, 15], 12, "12"; a range "12-20" counts from its start), in reading order, at most
 * MAX_UNITS_PER_QUOTE units; "" when it names no unit. */
export function unitQuote(evidence: unknown, units: string[]): string {
  const ids: number[] = [];
  for (const e of Array.isArray(evidence) ? evidence : [evidence]) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(e ?? ""));
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Math.min(Number(m[2]), lo + MAX_UNITS_PER_QUOTE - 1) : lo;
    for (let n = lo; n <= hi; n++) if (n >= 1 && n <= units.length && !ids.includes(n)) ids.push(n);
  }
  return ids.slice(0, MAX_UNITS_PER_QUOTE).sort((x, y) => x - y).map((n) => units[n - 1]!.trim()).join(" ");
}

/** An extract answer in the ids form: records whose evidence id is replaced by the quote it names. */
export function parseIdsAnswer(text: string, units: string[]): Extracted[] | undefined {
  const v = parseJson(text, "array");
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const p = Extracted.safeParse({ ...(r as object), evidence: unitQuote((r as { evidence?: unknown }).evidence, units) });
    return p.success ? [p.data] : [];
  });
}

/** A one-call answer: each array element is a record and carries its own five label fields. */
export function parseOneCall(text: string): Array<{ record: Extracted; labels: Record<string, unknown> }> | undefined {
  const v = parseJson(text, "array");
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((r) => {
    const p = Extracted.safeParse(r);
    return p.success ? [{ record: p.data, labels: r as Record<string, unknown> }] : [];
  });
}

export const fill = (tpl: string, v: Record<string, string>): string => tpl.replace(/%([A-Z]+)%/g, (_, k: string) => v[k] ?? "");

export const Extracted = z.object({
  subject: z.string().min(1),
  subject_kind: z.string().optional().nullable(),
  facet: z.string().nullable().optional(),
  change_type: z.string().optional().nullable(),
  surface: z.string().optional().nullable(),
  summary: z.string().min(1),
  audience: z.enum(["application", "extension_author", "maintainer", "general"]).optional(),
  introduces: z.array(z.unknown()).optional().nullable(),
  evidence: z.string().optional().nullable(),
});
export type Extracted = z.infer<typeof Extracted>;

const Prereq = z.object({
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  min: z.union([z.string(), z.number()]).nullable().optional(),
  max: z.union([z.string(), z.number()]).nullable().optional(),
});
const Labels = z.object({
  terms: z.array(z.unknown()).optional().nullable(),
  replaces: z.array(z.unknown()).optional().nullable(),
  requires: z.array(z.unknown()).optional().nullable(),
  prerequisites: z.array(z.unknown()).optional().nullable(),
  conditions: z.array(z.unknown()).optional().nullable(),
});

export interface Prerequisite {
  ecosystem: string;
  name: string;
  min?: string;
  max?: string;
}

/** One record as extracted and labelled from one release, before classification and matching. */
export interface Incoming {
  /** `{technology}@{version}[+guide.<snap8>]#{chunk}.{index}`: what has been ingested, so a rerun skips it. */
  key: string;
  /** The evidence kind of the source document (release notes unless stated). */
  kind?: "release_notes" | "upgrade_guide" | "docs";
  /** A guide's own impact rating for the item's section (Laravel's "Likelihood Of Impact"), when it gives one. Central only. */
  impact?: string;
  technology: string;
  version: string;
  date: string;
  line: string;
  url: string;
  snapshot: string;
  subject: string;
  subject_kind: "literal" | "concept";
  facet?: string;
  hint_change_type?: string;
  hint_surface?: string;
  summary: string;
  introduces: string[];
  quote: string;
  section?: string;
  grounded: boolean;
  terms: string[];
  replaces: string[];
  requires: string[];
  prerequisites: Prerequisite[];
  conditions: string[];
}

/** Splits notes into chunks of at most `max` characters, preferring heading boundaries, then line boundaries. */
export function chunk(notes: string, max = MAX_CHUNK): string[] {
  if (notes.length <= max) return [notes];
  const lines = notes.split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    const heading = /^#{1,4}\s/.test(line);
    if (cur.length && (size + line.length + 1 > max || (heading && size > max * 0.6))) {
      out.push(cur.join("\n"));
      cur = [];
      size = 0;
    }
    // A single line longer than the chunk is cut.
    for (let s = line; ; s = s.slice(max)) {
      if (s.length <= max) {
        cur.push(s);
        size += s.length + 1;
        break;
      }
      out.push(s.slice(0, max));
    }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** A chunk whose extract answer was truncated is split into pieces of about half its length; one shorter than this is
 * not split again (its answer would fit unless the model loops). */
export const MIN_SPLIT = 2_000;

/** The pieces of a chunk whose extract answer ran out of room: two or more, at headings or lines, losing nothing. */
export const splitChunk = (notes: string): string[] => chunk(notes, Math.ceil(notes.length / 2));

/** Notes with nothing a change record could come from, so no model call is made: once headings, links, bare URLs,
 * "Full Changelog" and "View changes on GitHub" lines, "No (significant) changes" and a changesets "Updated
 * dependencies" list (its `pkg@version` lines) are set aside, no letter or digit is left. On the production store
 * (17 October 2026) 224 of 4,814 cached extract answers were for such notes, and every one was `[]`. */
export function contentFree(notes: string): boolean {
  let deps = false;
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const text = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/&nbsp;/g, "");
    if (/^[-*]?\s*Updated dependencies\b/.test(text)) {
      deps = true;
      continue;
    }
    if (deps && /^\s*[-*]\s*@?[\w./-]+@[\w.+-]+\s*$/.test(raw)) continue;
    deps = false;
    if (/^\**\s*Full Changelog\**:?\s*\S*\s*$/i.test(text)) continue;
    if (/^[#\s]*View changes on GitHub\s*$/i.test(text)) continue;
    if (/^[*_\s]*No (significant )?changes[.!]?[*_\s]*$/i.test(text)) continue;
    if (/[\p{L}\p{N}]/u.test(text)) return false;
  }
  return true;
}

const norm = (s: string): string => s.replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Where a quote sits in the notes: whether it is verbatim (after whitespace and markup folding) and its heading. */
export function locate(notes: string, quote: string): { grounded: boolean; section?: string } {
  const q = norm(quote);
  if (!q) return { grounded: false };
  const lines = notes.split("\n");
  let heading: string | undefined;
  // Search line by line first (keeps the heading), then the whole text for quotes spanning lines.
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) heading = h[1]!.replace(/[`*_]/g, "").trim().slice(0, 120) || heading;
    if (norm(line).includes(q)) return heading ? { grounded: true, section: heading } : { grounded: true };
  }
  return { grounded: norm(notes).includes(q) };
}

export const strings = (v: unknown[] | null | undefined, max: number): string[] => {
  const out: string[] = [];
  for (const x of v ?? []) {
    if (typeof x !== "string") continue;
    const s = oneLine(x.replace(/`/g, ""), 200);
    if (s && !out.includes(s) && out.length < max) out.push(s);
  }
  return out;
};

const words = (s: string, max: number): string => {
  const w = oneLine(s, 400).split(" ");
  return w.length <= max ? w.join(" ") : w.slice(0, max).join(" ").replace(/[,;:]$/, "") + "…";
};

function cleanSubject(s: string): string {
  return oneLine(s.replace(/[`*]/g, "").replace(/\(\s*\)$/, ""), 200);
}

/** A guide's impact rating for the section holding a quote ("Likelihood Of Impact: High"), if the guide states one. */
export function impactOf(notes: string, section: string | undefined): string | undefined {
  if (!section) return undefined;
  const lines = notes.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").replace(/[`*_]/g, "").trim().startsWith(section));
  if (at < 0) return undefined;
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,6}\s+/.test(l) && !/impact/i.test(l)) break;
    const m = /likelihood of impact:?\s*\**\s*(high|medium|low|very low)/i.exec(l);
    if (m) return m[1]!.toLowerCase();
  }
  return undefined;
}

export interface DocsNote extends ReleaseNote { kind: "docs"; keyTag: string }

/** The first model call for one chunk of a note under the configured structure (what the cache is keyed on). */
function firstCall(t: Technology, rel: ReleaseNote | GuideNote | DocsNote, notes: string, part: string) {
  const structure = extractStructure();
  const base = { TECH: t.name, VERSION: rel.version, DATE: rel.noteDate ?? rel.date, PART: part };
  if (structure === "one-call-schema") return { prompt: fill(SCHEMA_PROMPT, { ...base, NOTES: notes }), opts: { responseFormat: SCHEMA_RESPONSE_FORMAT, maxTokens: 24_000 } };
  if (structure === "one-call") return { prompt: fill(ONE_CALL_PROMPT, { ...base, NOTES: notes }), opts: {} };
  const numbered = extractEvidence() === "ids" ? numberUnits(notes) : undefined;
  const d = extractDiet();
  const template = numbered ? EXTRACT_PROMPT_IDS : EXTRACT_PROMPT;
  return { prompt: fill(d ? dietPrompt(template, d) : template, { ...base, NOTES: numbered ? numbered.text : notes }), opts: {}, numbered };
}

const partLine = (parts: string[], ci: number) => (parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "");

/** Whether every chunk's first call is answered from the cache, so extracting the note again costs no model tokens
 * (budget.ts). A cached first call implies its label call was made with it. */
export function releaseCached(t: Technology, rel: ReleaseNote | GuideNote | DocsNote): boolean {
  const parts = chunk(rel.notes);
  return parts.every((notes, ci) => chunkCached(t, rel, notes, partLine(parts, ci)));
}

function chunkCached(t: Technology, rel: ReleaseNote | GuideNote | DocsNote, notes: string, part: string): boolean {
  if (!notes.trim() || contentFree(notes)) return true;
  const c = firstCall(t, rel, notes, part);
  if (extractCached(c.prompt, c.opts)) return true;
  // A truncated answer is not asked again; a two-call chunk long enough is extracted as pieces instead.
  if (!extractTruncated(c.prompt, c.opts)) return false;
  if (extractStructure() !== "two-call" || notes.length < MIN_SPLIT) return true;
  const pieces = splitChunk(notes);
  return pieces.every((p, j) => chunkCached(t, rel, p, piecePart(part, j, pieces.length)));
}

const piecePart = (part: string, j: number, n: number): string => `${part}\nPiece ${j + 1} of ${n} of this text.`;

export async function extractRelease(t: Technology, rel: ReleaseNote | GuideNote | DocsNote): Promise<{ incoming: Incoming[]; failed: number }> {
  const parts = chunk(rel.notes);
  const structure = extractStructure();
  const out: Incoming[] = [];
  let failed = 0;
  await Promise.all(
    parts.map(async (notes, ci) => {
      if (!notes.trim() || contentFree(notes)) return;
      if (structure === "two-call") {
        const r = await twoCall(t, rel, notes, partLine(parts, ci));
        failed += r.failed;
        r.recs.forEach((x, i) => out.push(toIncoming(t, rel, ci, i, x.record, x.labels, x.notes)));
        return;
      }
      const first = firstCall(t, rel, notes, partLine(parts, ci));
      if (structure === "one-call-schema") {
        const recs = await extractLlm(first.prompt, parseSchemaAnswer, first.opts);
        if (!recs) failed++;
        recs?.forEach((r, i) => out.push(toIncoming(t, rel, ci, i, r.record, r.labels, notes)));
        return;
      }
      const recs = await extractLlm(first.prompt, parseOneCall);
      if (!recs) failed++;
      recs?.forEach((r, i) => out.push(toIncoming(t, rel, ci, i, r.record, r.labels, notes)));
    }),
  );
  out.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { incoming: out, failed };
}

/** Two calls (extract, then label) on one chunk. An extract answer that ran out of room is not asked again: a chunk
 * of at least MIN_SPLIT characters is extracted as pieces (splitChunk), whose records follow one another in order. */
async function twoCall(
  t: Technology,
  rel: ReleaseNote | GuideNote | DocsNote,
  notes: string,
  part: string,
): Promise<{ recs: Array<{ record: Extracted; labels: unknown; notes: string }>; failed: number }> {
  if (!notes.trim() || contentFree(notes)) return { recs: [], failed: 0 };
  const first = firstCall(t, rel, notes, part);
  const numbered = first.numbered;
  let truncated = false;
  const recs = await extractLlm(
    first.prompt,
    (text) => {
      if (numbered) return parseIdsAnswer(text, numbered.units);
      const v = parseJson(text, "array");
      if (!Array.isArray(v)) return undefined;
      return v.flatMap((r) => {
        const p = Extracted.safeParse(r);
        return p.success ? [p.data] : [];
      });
    },
    { onLength: () => (truncated = true) },
  );
  if (!recs) {
    if (!truncated || notes.length < MIN_SPLIT) return { recs: [], failed: 1 };
    const pieces = splitChunk(notes);
    const done = await Promise.all(pieces.map((p, j) => twoCall(t, rel, p, piecePart(part, j, pieces.length))));
    return { recs: done.flatMap((d) => d.recs), failed: done.reduce((s, d) => s + d.failed, 0) };
  }
  if (!recs.length) return { recs: [], failed: 0 };
  const brief = recs.map((r, i) => ({
    id: `r${i + 1}`,
    subject: r.subject,
    facet: r.facet ?? null,
    change_type: r.change_type ?? null,
    summary: r.summary,
    introduces: strings(r.introduces, 20),
    evidence: r.evidence ?? "",
  }));
  const labels = await extractLlm(
    fill(LABEL_PROMPT, { TECH: t.name, VERSION: rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes }),
    (text) => {
      const v = parseJson(text, "object");
      if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
      return v as Record<string, unknown>;
    },
  );
  return { recs: recs.map((record, i) => ({ record, labels: labels?.[`r${i + 1}`], notes })), failed: labels ? 0 : 1 };
}

export function toIncoming(t: Technology, rel: ReleaseNote | GuideNote | DocsNote, ci: number, i: number, r: Extracted, rawLabels: unknown, notes: string): Incoming {
  const l = Labels.safeParse(rawLabels ?? {});
  const lab = l.success ? l.data : {};
  const introduces = strings(r.introduces, 20);
  const subject = cleanSubject(r.subject);
  const facet = r.facet ? cleanSubject(r.facet) : "";
  // A word-marked change (docs/render.ts, docs or guide sections) marks changed words inline: the quote is page text,
  // grounded in the text after or before the change.
  const marked = rel.notes.startsWith(PREAMBLE_MARKED);
  const quote = marked ? unmarkQuote((r.evidence ?? "").trim()).trim() : (r.evidence ?? "").trim();
  const views = marked ? markViews(notes) : undefined;
  const where = views ? [locate(views.after, quote), locate(views.before, quote)].find((w) => w.grounded) ?? { grounded: false } : locate(notes, quote);
  const prerequisites: Prerequisite[] = [];
  for (const p of lab.prerequisites ?? []) {
    const q = Prereq.safeParse(p);
    if (!q.success) continue;
    const pr: Prerequisite = { ecosystem: oneLine(q.data.ecosystem, 40).toLowerCase(), name: oneLine(q.data.name, 200) };
    if (q.data.min != null && String(q.data.min).trim()) pr.min = oneLine(String(q.data.min), 40);
    if (q.data.max != null && String(q.data.max).trim()) pr.max = oneLine(String(q.data.max), 40);
    if (!prerequisites.some((x) => x.ecosystem === pr.ecosystem && x.name === pr.name)) prerequisites.push(pr);
  }
  const guide = "kind" in rel && rel.kind === "upgrade_guide" ? rel : undefined;
  const inc: Incoming = {
    key: `${t.id}@${rel.version}${"keyTag" in rel ? rel.keyTag : ""}#${ci}.${i}`,
    technology: t.id,
    version: rel.version,
    date: rel.date,
    line: releaseLine(rel.version),
    url: rel.url,
    snapshot: rel.snapshot,
    subject,
    subject_kind: r.subject_kind === "concept" ? "concept" : r.subject_kind === "literal" ? "literal" : /[._:/()@-]|[a-z][A-Z]/.test(subject) ? "literal" : "concept",
    summary: words(r.summary, 40),
    introduces,
    quote,
    grounded: where.grounded,
    terms: strings(lab.terms, 40).filter((x) => !introduces.includes(x)).slice(0, 12),
    replaces: strings(lab.replaces, 4),
    requires: strings(lab.requires, 6),
    prerequisites,
    conditions: strings(lab.conditions, 6),
  };
  if (r.audience === "extension_author") inc.conditions.push("Audience: authors of custom providers, plugins, adapters or integrations.");
  if (r.audience === "maintainer") inc.conditions.push("Audience: technology maintainers; ordinary applications may not benefit.");
  if (facet) inc.facet = facet;
  if (r.change_type) inc.hint_change_type = r.change_type;
  if (r.surface) inc.hint_surface = r.surface;
  if (where.section) inc.section = where.section;
  if ("kind" in rel && rel.kind === "docs") {
    inc.kind = "docs";
    inc.conditions.push("Documentation change observed on " + rel.date + "; confirm version applicability against the linked source.");
  }
  if (guide) {
    inc.kind = "upgrade_guide";
    const impact = impactOf(notes, where.section);
    if (impact) inc.impact = impact;
  }
  return inc;
}
