// Slice 11 load burst (PREREG.md, "Load"): the 12 DEV extract prompts on the frozen revision, cycled, N calls to
// minimax/minimax-m3.1-flash at concurrency C, without cache, with production's retry policy for a model that has no
// fallback (llm.ts: 429/5xx retried 4 times, honouring retry-after, else 2 s × 2^attempt). No held-out text.
//
//   cd central && npx tsx ../eval/select/slice11/load11.mts --addendum mm-rN [--calls 200] [--concurrency 40]
//
// Output: out/slice11/load/calls.jsonl (one line per call: start, end, statuses, 429s, retry-after values, finish,
// tokens) and summary.json (calls/minute sustained, exhausted share, latency p50/p95, output tokens/s).
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const { values: a } = parseArgs({ options: { addendum: { type: "string" }, calls: { type: "string", default: "200" }, concurrency: { type: "string", default: "40" } } });
const OUT = join(SELECT, "out", "slice11", "load");
mkdirSync(OUT, { recursive: true });
const { chunk, EXTRACT_PROMPT, fill } = await import("../../../central/src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { PROVIDERS, parseUsage } = await import("../../../central/src/pipeline/llm.ts");
const { keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { pool } = await import("../../../central/src/pipeline/util.ts");
const { withAddendum } = await import("../slice3/addenda.ts");
const S = await import("../states.ts");

// The DEV documents, as run3.mts devDocs builds them.
const items = JSON.parse(readFileSync(join(S.EVAL, "sets", "extraction-recall.json"), "utf8")).items as Array<{ event: string; in_fetched_sources: boolean; sources: Array<{ url: string }> }>;
const techOf: Record<string, string> = { next16: "next", prisma7: "prisma", nest12: "nestjs" };
const want = new Map<string, string>();
for (const it of items) if (it.in_fetched_sources) for (const s of it.sources) want.set(s.url, techOf[it.event.split("-").at(-1)!]!);
const central = join(S.STORE, "central");
const prompts: string[] = [];
const template = withAddendum(EXTRACT_PROMPT, a.addendum);
for (const [url, tech] of want) {
  const t = TECHNOLOGIES[tech]!;
  const rels = JSON.parse(readFileSync(join(central, "releases", tech, "index.json"), "utf8")).releases as Array<{ url: string; version: string; date: string }>;
  let rel = rels.find((x) => x.url === url) as { version: string; date: string; snapshot?: string } | undefined;
  let notes: string;
  if (rel) notes = t.clean(readFileSync(join(central, "releases", tech, `${rel.version}.md`), "utf8"));
  else {
    const gs = JSON.parse(readFileSync(join(central, "guides", tech, "index.json"), "utf8")).guides as Array<{ url: string; version: string; date: string; snapshot: string }>;
    const g = gs.find((x) => x.url === url)!;
    rel = g;
    notes = readFileSync(join(central, "guides", tech, `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`), "utf8");
  }
  const parts = chunk(notes);
  parts.forEach((n, ci) => {
    if (n.trim()) prompts.push(fill(template, { TECH: t.name, VERSION: rel!.version, DATE: rel!.date, PART: parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "", NOTES: n }));
  });
}
console.log(`${prompts.length} DEV extract prompts; ${a.calls} calls at concurrency ${a.concurrency}`);

const p = PROVIDERS.vercel!;
const key = keyFromEnvFile(p.keyFile, p.keyVar)();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
rmSync(join(OUT, "calls.jsonl"), { force: true });
const t0 = Date.now();
const rows = await pool(Array.from({ length: Number(a.calls) }, (_, i) => i), Number(a.concurrency), async (i) => {
  const body = { model: "minimax/minimax-m3.1-flash", messages: [{ role: "user", content: prompts[i % prompts.length]! }], max_tokens: 16_000, reasoning_effort: "low" };
  const start = Date.now();
  const statuses: number[] = [], after: number[] = [];
  let row: Record<string, unknown> = {};
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60 * 1000) });
    } catch (e) {
      statuses.push(0);
      if (attempt < 4) { await sleep(2000 * 2 ** attempt); continue; }
      row = { exhausted: true, error: String(e) };
      break;
    }
    statuses.push(res.status);
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) after.push(ra);
      await res.text();
      if (attempt < 4) { await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt); continue; }
      row = { exhausted: true };
      break;
    }
    if (!res.ok) { row = { exhausted: true, error: (await res.text()).slice(0, 200) }; break; }
    const j = (await res.json()) as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; usage?: unknown };
    const u = parseUsage(j.usage);
    row = { exhausted: false, finish: j.choices?.[0]?.finish_reason, output_tokens: u?.output_tokens ?? 0, input_tokens: u?.input_tokens ?? 0, cost: (j.usage as { cost?: number } | undefined)?.cost ?? null };
    break;
  }
  const r = { i, prompt: i % prompts.length, start: start - t0, end: Date.now() - t0, statuses, rate_limited: statuses.filter((s) => s === 429).length, retry_after: after, ...row };
  appendFileSync(join(OUT, "calls.jsonl"), JSON.stringify(r) + "\n");
  return r as typeof r & { exhausted: boolean; output_tokens?: number };
});
const wall = (Date.now() - t0) / 1000;
const lat = rows.filter((r) => !r.exhausted).map((r) => (r.end - r.start) / 1000).sort((x, y) => x - y);
const q = (f: number) => lat[Math.min(lat.length - 1, Math.floor(f * lat.length))] ?? null;
const ok = rows.filter((r) => !r.exhausted);
const summary = {
  calls: rows.length, concurrency: Number(a.concurrency), wall_s: wall,
  completed: ok.length, exhausted: rows.length - ok.length, exhausted_share: (rows.length - ok.length) / rows.length,
  calls_per_minute: (ok.length / wall) * 60,
  responses_429: rows.reduce((s, r) => s + r.rate_limited, 0), calls_with_429: rows.filter((r) => r.rate_limited > 0).length,
  retry_after_values: [...new Set(rows.flatMap((r) => r.retry_after))],
  other_errors: rows.reduce((s, r) => s + r.statuses.filter((x) => x !== 200 && x !== 429).length, 0),
  truncated: ok.filter((r) => (r as { finish?: string }).finish === "length").length,
  latency_s: { p50: q(0.5), p95: q(0.95), max: lat.at(-1) ?? null },
  output_tokens_per_s_per_stream: ok.reduce((s, r) => s + (r.output_tokens ?? 0), 0) / ok.reduce((s, r) => s + (r.end - r.start) / 1000, 0),
  cost: rows.reduce((s, r) => s + (((r as { cost?: number | null }).cost) ?? 0), 0),
  addendum: a.addendum, at: new Date().toISOString(),
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
