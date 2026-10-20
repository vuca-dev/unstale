// Slice 8 inventory (no model calls, network refused): every chunk production extracted, rebuilt from a restored
// state copy, with the cached step-A answer it got. A chunk is rebuilt the way extractRelease builds it (chunk(),
// partLine, splitChunk pieces after a truncated answer) for every release note (fetchReleases offline), upgrade guide
// (fetchGuides offline) and docs note (docs plan with the extracted-events ledger set aside, so every event is
// planned again), and its step-A request key is looked up in the state's model cache.
//
//   cd central && npx tsx ../eval/select/slice8/inventory.mts --state <restored store>/central
//
// Output: out/slice8/chunks.jsonl, one line per chunk: tech, source (release|guide|docs), version, keyTag, part,
// piece, status (A0 = cached `[]`, A+ = cached records, trunc = truncated (split into pieces), miss = no cached answer,
// free = empty or contentFree, never sent), records (A+ answer length), usage (the cached answer's tokens), text.
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const { values: a } = parseArgs({ options: { state: { type: "string" } } });
const STATE = a.state!;
process.env.UNSTALE_CENTRAL_DIR = STATE;
process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
process.env.UNSTALE_EXTRACT_EFFORT = "low";
for (const k of ["UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET", "UNSTALE_EXTRACT_SERVICE_TIER"]) delete process.env[k];

const { loadTechnologies, noNetwork } = await import("../slice6/common.mts");
const X = await import("../../../central/src/pipeline/extract.ts");
const { extractCacheKey, parseJson } = await import("../../../central/src/pipeline/llm.ts");
const { hashedPacks } = await import("../../../central/src/pipeline/packs.ts");
const { fetchReleases, fetchGuides } = await import("../../../central/src/pipeline/fetch.ts");
const { plan } = await import("../../../central/src/docs/extract.ts");
const { techLocal } = await import("../../../central/src/state/client.ts");
noNetwork();

const OUT = join(import.meta.dirname, "..", "out", "slice8");
mkdirSync(OUT, { recursive: true });
const FILE = join(OUT, "chunks.jsonl");
writeFileSync(FILE, "");
const cache = hashedPacks(join(STATE, "cache", "llm"), 3);

type Note = { version: string; date: string; noteDate?: string; notes: string; keyTag?: string; url?: string };
const partLine = (n: number, ci: number) => (n > 1 ? `\nPart ${ci + 1} of ${n} of these release notes.` : "");
const piecePart = (part: string, j: number, n: number): string => `${part}\nPiece ${j + 1} of ${n} of this text.`;

const counts: Record<string, number> = {};
function emit(row: Record<string, unknown>): void {
  counts[row.status as string] = (counts[row.status as string] ?? 0) + 1;
  appendFileSync(FILE, JSON.stringify(row) + "\n");
}

function visit(tech: { id: string; name: string; repo: string }, src: string, rel: Note, text: string, part: string, ci: number, nparts: number, piece: string): void {
  const base = { tech: tech.id, name: tech.name, repo: tech.repo, promptDate: rel.noteDate ?? rel.date, partText: part, source: src, version: rel.version, keyTag: rel.keyTag ?? "", url: rel.url ?? "", date: rel.date, part: ci, parts: nparts, piece, chars: text.length };
  if (!text.trim() || X.contentFree(text)) return emit({ ...base, status: "free", text });
  const prompt = X.fill(X.EXTRACT_PROMPT, { TECH: tech.name, VERSION: rel.version, DATE: rel.noteDate ?? rel.date, PART: part, NOTES: text });
  const key = extractCacheKey(prompt);
  const hit = cache.get(key);
  if (hit) {
    const v = JSON.parse(hit.toString("utf8")) as { text: string; usage?: unknown };
    const arr = parseJson(v.text, "array");
    const parsed = Array.isArray(arr) ? arr.filter((r) => X.Extracted.safeParse(r).success) : undefined;
    return emit({ ...base, key, status: parsed && parsed.length ? "A+" : parsed ? "A0" : "unparsed", records: parsed?.length ?? 0, usage: v.usage, text });
  }
  if (cache.has(`${key}.length`)) {
    emit({ ...base, key, status: "trunc", text: "" });
    if (text.length < X.MIN_SPLIT) return;
    const pieces = X.splitChunk(text);
    pieces.forEach((p, j) => visit(tech, src, rel, p, piecePart(part, j, pieces.length), ci, nparts, `${piece}${j + 1}/${pieces.length};`));
    return;
  }
  emit({ ...base, key, status: "miss", text: "" });
}

function visitNote(tech: { id: string; name: string; repo: string }, src: string, rel: Note): void {
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
  // Docs notes: the plan skips events already extracted, so the ledger is set aside while planning.
  const ledger = join(STATE, "docs", local, "extracted.json");
  const moved = existsSync(ledger);
  if (moved) renameSync(ledger, ledger + ".s8");
  try {
    const p = await plan(t.id);
    for (const pn of p.notes) visitNote(t, pn.note.kind === "upgrade_guide" ? "docs-guide" : "docs", pn.note as Note);
  } catch (e) {
    console.error(`${t.id}: docs: ${(e as Error).message.slice(0, 120)}`);
  } finally {
    if (moved) renameSync(ledger + ".s8", ledger);
  }
  if (n % 200 === 0) console.error(`${n} technologies, ${JSON.stringify(counts)}`);
}
console.log(`${n} technologies; chunks by status ${JSON.stringify(counts)}`);
