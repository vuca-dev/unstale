// Label-field set, step 2: two blind Claude labelers (A = Opus, B = Sonnet) label every record of items.json from the
// notes and the record brief only (never a model's label answer), under the pipeline's own field rules (LABEL_PROMPT).
// Step 3 (--adjudicate): an Opus adjudicator settles each record field where A and B differ (replaces, requires,
// prerequisites, conditions), shown the two answers as "Labeler 1/2" in an order fixed by hash, not by labeler.
//
//   cd central && npx tsx ../eval/select/labels/reference.mts --labeler A|B   (then --adjudicate)
// Runs `claude -p` (the user's plan) from an empty directory with no tools. Answers are cached in
// out/labels/ref/<labeler>/<batch>.json; only answers that parse are kept. H2 chunks are split into batches of at most
// 20 records (same notes), so one answer never covers more than 20 records.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { fill, LABEL_PROMPT } = await import("../../../central/src/pipeline/extract.ts");
const { parseJson: strictJson } = await import("../../../central/src/pipeline/codex.ts");
// Labelers occasionally write a regex-like term ("\\.safeParse(") with an invalid JSON escape; double such backslashes.
const parseJson = (t: string, k: "array" | "object") => strictJson(t, k) ?? strictJson(t.replace(/\\(?!["\\/bfnrtu])/g, "\\\\"), k);
const { pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
import type { Brief, Chunk } from "./items.mts";

const { values: a } = parseArgs({ options: { labeler: { type: "string" }, adjudicate: { type: "boolean", default: false }, limit: { type: "string" }, concurrency: { type: "string", default: "4" } } });
const OUT = join(SELECT, "out", "labels", "ref");
const items = (JSON.parse(readFileSync(join(import.meta.dirname, "items.json"), "utf8")) as { chunks: Chunk[] }).chunks;
const BATCH = 20;
export interface Batch { id: string; chunk: Chunk; records: Brief[] }
export function batches(chunks: Chunk[]): Batch[] {
  const out: Batch[] = [];
  for (const c of chunks) for (let i = 0; i < c.records.length; i += BATCH) out.push({ id: `${c.doc}#${c.ci}.${i / BATCH}`.replace(/[^\w.@#+-]/g, "_"), chunk: c, records: c.records.slice(i, i + BATCH) });
  return out;
}
const MODELS: Record<string, string> = { A: "opus", B: "sonnet", ADJ: "opus" };
const work = mkdtempSync(join(tmpdir(), "labels-ref-"));

function claude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("claude", ["-p", "--model", model, "--tools", "", "--no-session-persistence", "--output-format", "json", "--system-prompt", "You are a careful annotator building a gold-standard reference set. Follow the task's rules exactly. Answer with JSON only."], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", () => {});
    p.on("close", () => {
      try { resolve(String((JSON.parse(out) as { result?: string }).result ?? "")); } catch { resolve(""); }
    });
    p.stdin.end(prompt);
  });
}

const PREFACE = `Gold-standard annotation. Label every record below from the release notes alone, following the rules exactly as
written. Be precise: a value belongs in a field only when the notes support it under that field's rule; leave a field []
when they do not. For "terms", give the most specific terms first (up to 12).

`;

function labelPrompt(b: Batch): string {
  return PREFACE + fill(LABEL_PROMPT, { TECH: b.chunk.name, VERSION: b.chunk.version, RECORDS: JSON.stringify(b.records, null, 1), NOTES: b.chunk.notes });
}

async function cached(path: string, make: () => Promise<unknown>): Promise<unknown> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const v = await make();
  if (v !== undefined) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(v, null, 1) + "\n"); }
  return v;
}

const all = batches(items).slice(0, a.limit ? Number(a.limit) : undefined);
const FIELDS = ["replaces", "requires", "prerequisites", "conditions"] as const;

if (a.labeler) {
  const L = a.labeler;
  let failed = 0;
  await pool(all, Number(a.concurrency), async (b) => {
    const v = await cached(join(OUT, L, `${b.id}.json`), async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const t = await claude(labelPrompt(b), MODELS[L]!);
        const o = parseJson(t, "object");
        if (o && typeof o === "object" && !Array.isArray(o) && b.records.every((r) => r.id in (o as object))) return o;
        console.error(`${L} ${b.id}: attempt ${attempt + 1} unparseable or incomplete`);
      }
      return undefined;
    });
    if (!v) failed++;
  });
  console.log(JSON.stringify({ labeler: L, batches: all.length, failed }));
}

const norm = (x: unknown) => JSON.stringify(x ?? []);
export function canonField(field: string, v: unknown): string {
  const arr = Array.isArray(v) ? v : [];
  const keys = arr.map((x) => field === "prerequisites" ? JSON.stringify(x) : String(x).trim().toLowerCase()).sort();
  return JSON.stringify(keys);
}

if (a.adjudicate) {
  const stats = { batches: 0, disputes: 0, sideA: 0, sideB: 0, other: 0, failed: 0 };
  await pool(all, Number(a.concurrency), async (b) => {
    const A = JSON.parse(readFileSync(join(OUT, "A", `${b.id}.json`), "utf8")) as Record<string, Record<string, unknown>>;
    const B = JSON.parse(readFileSync(join(OUT, "B", `${b.id}.json`), "utf8")) as Record<string, Record<string, unknown>>;
    const disputes: Array<{ id: string; field: string; one: unknown; two: unknown; aIsOne: boolean }> = [];
    for (const r of b.records) for (const f of FIELDS) {
      if (canonField(f, A[r.id]?.[f]) === canonField(f, B[r.id]?.[f])) continue;
      const aIsOne = parseInt(sha256(`${b.id}/${r.id}/${f}`).slice(0, 2), 16) % 2 === 0;
      disputes.push({ id: r.id, field: f, one: aIsOne ? A[r.id]?.[f] ?? [] : B[r.id]?.[f] ?? [], two: aIsOne ? B[r.id]?.[f] ?? [] : A[r.id]?.[f] ?? [], aIsOne });
    }
    stats.batches++;
    stats.disputes += disputes.length;
    if (!disputes.length) return;
    const prompt = `Two annotators labelled the same change records under the rules below and disagree on some fields. For each
dispute, give the correct value for that field under the rules, judged from the release notes. You may choose either
annotator's value, part of one, or a corrected value. Output only a JSON object mapping "<record id>/<field>" to the
final value (a JSON array).

${fill(LABEL_PROMPT, { TECH: b.chunk.name, VERSION: b.chunk.version, RECORDS: JSON.stringify(b.records.filter((r) => disputes.some((d) => d.id === r.id)), null, 1), NOTES: b.chunk.notes })}

Disputes:
${JSON.stringify(disputes.map((d) => ({ key: `${d.id}/${d.field}`, "Annotator 1": d.one, "Annotator 2": d.two })), null, 1)}
`;
    const v = (await cached(join(OUT, "ADJ", `${b.id}.json`), async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const o = parseJson(await claude(prompt, MODELS.ADJ!), "object");
        if (o && typeof o === "object" && disputes.every((d) => `${d.id}/${d.field}` in (o as object))) return o;
        console.error(`ADJ ${b.id}: attempt ${attempt + 1} unparseable or incomplete`);
      }
      return undefined;
    })) as Record<string, unknown> | undefined;
    if (!v) { stats.failed++; return; }
    for (const d of disputes) {
      const fin = canonField(d.field, v[`${d.id}/${d.field}`]);
      const av = canonField(d.field, A[d.id]?.[d.field]), bv = canonField(d.field, B[d.id]?.[d.field]);
      if (fin === av) stats.sideA++; else if (fin === bv) stats.sideB++; else stats.other++;
    }
  });
  console.log(JSON.stringify(stats));
}
void norm;
