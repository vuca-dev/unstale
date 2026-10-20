// Slice 12 inventory (no model calls, network refused): every chunk production extracted, rebuilt from a restored
// state copy as slice 8's inventory does (chunk(), part line, splitChunk pieces after a truncated answer), for release
// notes (fetchReleases offline), upgrade guides (fetchGuides offline) and docs notes (docs plan, ledger set aside). For
// each chunk it looks up the cached step-A answer and, from it, rebuilds the step-B (label) request as twoCall does and
// looks that up too. Both answers' usage is kept, so spend can be split by source (score12.py share).
//
//   cd central && npx tsx ../eval/select/slice12/inventory.mts --state <restored store>/central
//
// Output: out/slice12/chunks.jsonl, one line per chunk: tech, name, components, source (release|guide|docs|docs-guide),
// version, date, promptDate, partText, part, parts, piece, chars, status (A0, A+, trunc, miss, free, unparsed),
// records, usageA, usageB (null when B is not cached), keyA, text.
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values: a } = parseArgs({ options: { state: { type: "string" } } });
const STATE = a.state!;
process.env.UNSTALE_CENTRAL_DIR = STATE;
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET", "UNSTALE_EXTRACT_SERVICE_TIER", "UNSTALE_EXTRACT_FALLBACK"]) delete process.env[k];

const { loadTechnologies, noNetwork } = await import("../slice6/common.mts");
const X = await import("../../../central/src/pipeline/extract.ts");
const { extractCacheKey, parseJson } = await import("../../../central/src/pipeline/llm.ts");
const { hashedPacks } = await import("../../../central/src/pipeline/packs.ts");
const { fetchReleases, fetchGuides } = await import("../../../central/src/pipeline/fetch.ts");
const { plan } = await import("../../../central/src/docs/extract.ts");
const { techLocal } = await import("../../../central/src/state/client.ts");
noNetwork();

const OUT = join(import.meta.dirname, "..", "out", "slice12");
mkdirSync(OUT, { recursive: true });
const FILE = join(OUT, "chunks.jsonl");
writeFileSync(FILE, "");
const cache = hashedPacks(join(STATE, "cache", "llm"), 3);

type Note = { version: string; date: string; noteDate?: string; notes: string; keyTag?: string; url?: string };
type Tech = { id: string; name: string; repo: string; components: string[] };
const partLine = (n: number, ci: number) => (n > 1 ? `\nPart ${ci + 1} of ${n} of these release notes.` : "");
const piecePart = (part: string, j: number, n: number): string => `${part}\nPiece ${j + 1} of ${n} of this text.`;

const counts: Record<string, number> = {};
function emit(row: Record<string, unknown>): void {
  const k = `${row.source}:${row.status}`;
  counts[k] = (counts[k] ?? 0) + 1;
  appendFileSync(FILE, JSON.stringify(row) + "\n");
}

function labelUsage(tech: Tech, rel: Note, recs: Array<Record<string, unknown>>, notes: string): unknown {
  const brief = recs.map((r, i) => ({
    id: `r${i + 1}`,
    subject: r.subject,
    facet: r.facet ?? null,
    change_type: r.change_type ?? null,
    summary: r.summary,
    introduces: X.strings(r.introduces as unknown[], 20),
    evidence: r.evidence ?? "",
  }));
  const hit = cache.get(extractCacheKey(X.fill(X.LABEL_PROMPT, { TECH: tech.name, VERSION: rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes })));
  return hit ? ((JSON.parse(hit.toString("utf8")) as { usage?: unknown }).usage ?? null) : null;
}

function visit(tech: Tech, src: string, rel: Note, text: string, part: string, ci: number, nparts: number, piece: string): void {
  const base = { tech: tech.id, name: tech.name, repo: tech.repo, components: tech.components, promptDate: rel.noteDate ?? rel.date, partText: part, source: src, version: rel.version, keyTag: rel.keyTag ?? "", url: rel.url ?? "", date: rel.date, part: ci, parts: nparts, piece, chars: text.length };
  if (!text.trim() || X.contentFree(text)) return emit({ ...base, status: "free", text });
  const prompt = X.fill(X.EXTRACT_PROMPT, { TECH: tech.name, VERSION: rel.version, DATE: rel.noteDate ?? rel.date, PART: part, NOTES: text });
  const key = extractCacheKey(prompt);
  const hit = cache.get(key);
  if (hit) {
    const v = JSON.parse(hit.toString("utf8")) as { text: string; usage?: unknown };
    const arr = parseJson(v.text, "array");
    const parsed = Array.isArray(arr) ? (arr.filter((r) => X.Extracted.safeParse(r).success) as Array<Record<string, unknown>>) : undefined;
    const usageB = parsed?.length ? labelUsage(tech, rel, parsed, text) : null;
    return emit({ ...base, keyA: key, status: parsed && parsed.length ? "A+" : parsed ? "A0" : "unparsed", records: parsed?.length ?? 0, usageA: v.usage ?? null, usageB, text });
  }
  const tr = cache.get(`${key}.length`);
  if (tr) {
    emit({ ...base, keyA: key, status: "trunc", usageA: (JSON.parse(tr.toString("utf8")) as { usage?: unknown }).usage ?? null, text: "" });
    if (text.length < X.MIN_SPLIT) return;
    const pieces = X.splitChunk(text);
    pieces.forEach((p, j) => visit(tech, src, rel, p, piecePart(part, j, pieces.length), ci, nparts, `${piece}${j + 1}/${pieces.length};`));
    return;
  }
  emit({ ...base, keyA: key, status: "miss", text: "" });
}

function visitNote(tech: Tech, src: string, rel: Note): void {
  const parts = X.chunk(rel.notes);
  parts.forEach((p, ci) => visit(tech, src, rel, p, partLine(parts.length, ci), ci, parts.length, ""));
}

const techs = loadTechnologies(join(STATE, "onboarding", "jobs"));
let n = 0;
for (const t of techs.values()) {
  const local = techLocal(t.id);
  if (!existsSync(join(STATE, "releases", local)) && !existsSync(join(STATE, "guides", local)) && !existsSync(join(STATE, "docs", local))) continue;
  n++;
  try {
    const fetched = await fetchReleases(t, { offline: true });
    for (const r of fetched.notes) visitNote(t, "release", r);
    const guides = await fetchGuides(t, fetched.notes, { offline: true });
    for (const g of guides) visitNote(t, "guide", g);
  } catch (e) {
    console.error(`${t.id}: releases/guides: ${(e as Error).message.slice(0, 120)}`);
  }
  const ledger = join(STATE, "docs", local, "extracted.json");
  const moved = existsSync(ledger);
  if (moved) renameSync(ledger, ledger + ".s12");
  try {
    const p = await plan(t.id);
    for (const pn of p.notes) visitNote(t, pn.note.kind === "upgrade_guide" ? "docs-guide" : "docs", pn.note as Note);
  } catch (e) {
    console.error(`${t.id}: docs: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    if (moved) renameSync(ledger + ".s12", ledger);
  }
  if (n % 200 === 0) console.error(`${n} technologies, ${JSON.stringify(counts)}`);
}
console.log(`${n} technologies; chunks by source:status ${JSON.stringify(counts)}`);
