// Slice 17 (PREREG.md): the sets' units and their two reference judges. J1 is Codex gpt-5.6-luna; J2 is
// openai/gpt-6-luna on the AI gateway (reasoning low). Both get the same prompt, 12 units a call. Pair sets get audit.mts's
// prompt with the v3 identity rules (ADV adds ADVISORY_RULE); SURF gets the SURFACES definitions.
//
//   cd central && UNSTALE_STORE=<side store 2> npx tsx ../eval/select/slice17/label.mts prep
//   cd central && npx tsx ../eval/select/slice17/label.mts judge <adv|docs|lin|qg|surf>
//   cd central && npx tsx ../eval/select/slice17/label.mts show <set>      (J1/J2 disagreements, for adjudication)
//
// prep writes out/slice17/<set>-units.json. judge adds j1 and j2 to each unit. Adjudications are in adjudicated.json.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codex } from "../../lib/codex.ts";
import { ChatClient, PROVIDERS } from "../client.ts";
import { parseJson } from "../../../central/src/pipeline/llm.ts";
import { ADVISORY_RULE, sameLineage } from "../../../central/src/pipeline/match.ts";
import { labelQuestions, recordState } from "../../../central/src/pipeline/classify/labels.ts";
import { SURFACES } from "../../../central/src/pipeline/vocab.ts";
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";
import type { Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
import { techLocal } from "../../../central/src/state/client.ts";
import { canonical, pool, sha256 } from "../../../central/src/pipeline/util.ts";

const OUT = join(import.meta.dirname, "..", "out", "slice17");
const [mode, set] = process.argv.slice(2);
const DOCS_TECHS = ["pandas-d8b9c8be", "langsmith-cdf1f6c9", "langchain-langgraph-checkpoint-8e08c094", "langchain-anthropic-8cfb8bfa", "langchain-openai-0b6283d3", "qdrant-js-client-rest-08c8827b", "sphinx-03452f47", "effect-platform-bun-80481307", "effect-vitest-aee60558"];
const rj = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const kindOf = (x: { kind?: string }) => x.kind ?? "release_notes";
const order = (seed: string) => <T extends { key: string }>(xs: T[]) => [...xs].sort((a, b) => sha256(`${seed}:${a.key}`).localeCompare(sha256(`${seed}:${b.key}`)));

interface Side { kind?: string; subject: string; facet?: string; summary: string; quotes: string[] }
export interface PairUnit { id: string; set: string; key: string; tech: string; request: string; candidate: string; A: Side; B: Side; j1?: string; j2?: string }
export interface SurfUnit { id: string; key: string; tech: string; item: { subject: string; summary: string; quote: string; section?: string; kind?: string }; jev: string; j1?: string; j2?: string }
const sideOfInc = (i: Incoming): Side => ({ kind: kindOf(i), subject: i.subject, ...(i.facet ? { facet: i.facet } : {}), summary: i.summary, quotes: [i.quote] });
const sideOfRec = (r: StoredRecord): Side => ({ subject: r.subject, ...(r.facet ? { facet: r.facet } : {}), summary: r.summary, quotes: r.evidence.slice(0, 3).map((e) => `[${kindOf(e)}] ${e.quote}`) });

const keep = (file: string, data: unknown) => { const p = join(OUT, file); if (!existsSync(p)) writeFileSync(p, JSON.stringify(data, null, 1)); };
if (mode === "prep") {
  // ADV: the 130 sampled requests, every candidate.
  const adv = rj<Record<string, { key: string; tech: string; incoming: Incoming; cands: StoredRecord[] }>>(join(OUT, "advisory-requests.json"));
  const advUnits: PairUnit[] = Object.values(adv).flatMap((r) => r.cands.map((c) => ({ id: `${r.tech}|${r.key}|${c.id}`, set: "adv", key: r.key, tech: r.tech, request: r.key, candidate: c.id, A: sideOfInc(r.incoming), B: sideOfRec(c) })));
  keep("adv-units.json", advUnits);
  // DOCS and LIN from the docs replays.
  type Req = { key: string; tech: string; kind: string; cands: StoredRecord[]; incoming: Incoming; guardInc: never };
  const reqs: Req[] = DOCS_TECHS.flatMap((t) => (existsSync(join(OUT, `${t}-requests.json`)) ? Object.values(rj<Record<string, Req>>(join(OUT, `${t}-requests.json`))) : []));
  const lin = reqs.filter((r) => r.cands.some((c) => sameLineage(r.guardInc, c)));
  const docs = order("slice17-docs")(reqs.filter((r) => r.kind === "docs" && !lin.includes(r))).slice(0, 150);
  const units = (rs: Req[], s: string): PairUnit[] => rs.flatMap((r) => r.cands.map((c) => ({ id: `${r.tech}|${r.key}|${c.id}`, set: s, key: r.key, tech: r.tech, request: r.key, candidate: c.id, A: sideOfInc(r.incoming), B: sideOfRec(c) })));
  keep("docs-units.json", units(docs, "docs"));
  keep("lin-units.json", units(lin, "lin"));
  keep("docs-sample.json", { docs: docs.map((r) => `${r.tech}|${r.key}`), lin: lin.map((r) => `${r.tech}|${r.key}`), docs_population: reqs.filter((r) => r.kind === "docs" && !lin.includes(r)).length });
  // QG: slice 16's 35 pairs.
  const qg = rj<Array<{ tech: string; record: string; key: string; kind: string; incoming: { quote: string }; record_subject: string; record_summary: string; before: Array<{ kind: string; quote: string }> }>>(join(OUT, "..", "slice16", "otherkinds.json"));
  keep("qg-units.json", qg.map((x): PairUnit => ({ id: `${x.tech}|${x.key}|${x.record}`, set: "qg", key: x.key, tech: x.tech, request: x.key, candidate: x.record, A: { kind: x.kind, subject: "(not stored)", summary: "(not stored: only the evidence quote of a merged item is kept)", quotes: [x.incoming.quote] }, B: { subject: x.record_subject, summary: x.record_summary, quotes: x.before.slice(0, 3).map((b) => `[${b.kind}] ${b.quote}`) } })));
  // SURF: 130 incoming items of the docs replays with the run's Jev label answer.
  const items: SurfUnit[] = [];
  for (const t of DOCS_TECHS) {
    const ap = join(OUT, `${t}-answers.json`);
    if (!existsSync(ap)) continue;
    const answers = rj<Record<string, Classification>>(ap);
    const name = rj<{ technology: string }>(join(centralDir(), "records", `${techLocal(t)}.json`)).technology;
    const desc = readdirSync(join(centralDir(), "onboarding", "jobs")).map((f) => rj<{ descriptor?: { id: string; name: string } }>(join(centralDir(), "onboarding", "jobs", f))).find((j) => j.descriptor?.id === t)!.descriptor!;
    void name;
    const ex = join(centralDir(), "extractions", techLocal(t));
    for (const f of readdirSync(ex)) for (const i of rj<Incoming[]>(join(ex, f))) {
      const a = answers[sha256(canonical({ state: recordState(desc.name, i), questions: labelQuestions() }))];
      if (a?.answers.surface) items.push({ id: `${t}|${i.key}`, key: i.key, tech: t, item: { subject: i.subject, summary: i.summary, quote: i.quote, ...(i.section ? { section: i.section } : {}), kind: kindOf(i) }, jev: a.answers.surface.choice });
    }
  }
  keep("surf-units.json", order("slice17-surf")(items).slice(0, 130));
  console.log(JSON.stringify({ adv: advUnits.length, docs_requests: docs.length, docs_pairs: units(docs, "docs").length, lin_requests: lin.length, lin_pairs: units(lin, "lin").length, qg: qg.length, surf_population: items.length }));
}

const RULES_V3 = `Identity rules:
- Same change: the same thing changed in the same way. The change_type label does NOT matter: extractors label the
  same change as a fix in one run and a behaviour change in another. The same change shipped in different releases
  (a backport to an older release line) is the same change.
- Not the same, even if related: a record about one specific function, option, flag or channel and a broader record
  about the feature it belongs to; the deprecation or removal of an old API and the addition of its replacement; a
  rename and the addition of the new name; two different options of one API; two separate fixes to one API; a change
  that breaks existing code and one that does not.`;
const PAIR_PROMPT = (tech: string, adv: boolean, body: string) => `You maintain a catalog of change records for ${tech}. Each numbered pair below holds an incoming item (A),
extracted from an official source (release notes, an upgrade guide, a docs page, or a security advisory), and an
existing catalog record (B) with evidence it was built from. For each pair, decide whether A describes the same change
as B.

${RULES_V3}${adv ? `\n${ADVISORY_RULE}` : ""}
Two different security fixes or advisories are different changes, even in the same area.
If you are unsure, answer "different": a duplicate costs little, a wrong match hides a change.

Output only a JSON object mapping each pair number to "same" or "different".

${body}
`;
const showSide = (s: Side) => `${s.kind ? `(${s.kind}) ` : ""}subject ${s.subject}${s.facet ? ` [${s.facet}]` : ""}. ${s.summary}\n     Evidence: ${s.quotes.map((q) => `"${q}"`).join(" | ")}`;
const SURF_PROMPT = (tech: string, body: string) => `You label change records for ${tech}. For each numbered record, pick the one surface where a project that uses
${tech} meets this change:
${Object.entries(SURFACES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Output only a JSON object mapping each record number to one surface key.

${body}
`;

const gw = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(OUT, "cache", "j2"), usageLog: join(OUT, "j2-usage.jsonl"), concurrency: 4 });
async function j2(prompt: string, ok: (v: Record<string, unknown>) => boolean): Promise<Record<string, string> | undefined> {
  const c = await gw.complete({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: prompt }], max_tokens: 8000, reasoning_effort: "low" } as never, (t) => { const v = parseJson(t, "object") as Record<string, unknown> | undefined; return v && ok(v) ? (v as Record<string, string>) : undefined; }, { step: `slice17:${set}` });
  return c.value;
}
if (mode === "judge") {
  const path = join(OUT, `${set}-units.json`);
  const units = rj<Array<PairUnit | SurfUnit>>(path);
  const byTech = new Map<string, typeof units>();
  // Units already judged by both (carried over from an earlier set) are not asked again.
  for (const u of units) if (!(u.j1 && u.j2)) byTech.set(u.tech, [...(byTech.get(u.tech) ?? []), u]);
  const batches: Array<{ tech: string; b: typeof units }> = [];
  for (const [tech, us] of byTech) for (let i = 0; i < us.length; i += 12) batches.push({ tech, b: us.slice(i, i + 12) });
  const valid = (v: Record<string, unknown>, n: number) => Array.from({ length: n }, (_, i) => v[String(i + 1)]).every((x) => (set === "surf" ? typeof x === "string" && x in SURFACES : x === "same" || x === "different"));
  await pool(batches, 4, async ({ tech, b }) => {
    const name = tech.replace(/-[0-9a-f]{8}$/, "");
    const body = b.map((u, i) => set === "surf"
      ? `${i + 1}. (${(u as SurfUnit).item.kind}) subject ${(u as SurfUnit).item.subject}. ${(u as SurfUnit).item.summary}${(u as SurfUnit).item.section ? ` Section "${(u as SurfUnit).item.section}".` : ""}\n   Evidence: "${(u as SurfUnit).item.quote}"`
      : `${i + 1}.\n  A: ${showSide((u as PairUnit).A)}\n  B (${(u as PairUnit).candidate}): ${showSide((u as PairUnit).B)}`).join("\n\n");
    const prompt = set === "surf" ? SURF_PROMPT(name, body) : PAIR_PROMPT(name, set === "adv", body);
    const [a1, a2] = await Promise.all([
      codex(prompt, (t: string) => { const v = parseJson(t, "object") as Record<string, unknown> | undefined; return v && valid(v, b.length) ? (v as Record<string, string>) : undefined; }),
      j2(prompt, (v) => valid(v, b.length)),
    ]);
    b.forEach((u, i) => { if (a1) u.j1 = a1[String(i + 1)]; if (a2) u.j2 = a2[String(i + 1)]; });
  });
  writeFileSync(path, JSON.stringify(units, null, 1));
  const agree = units.filter((u) => u.j1 && u.j1 === u.j2).length;
  console.log(JSON.stringify({ set, units: units.length, j1: units.filter((u) => u.j1).length, j2: units.filter((u) => u.j2).length, agree, disagree: units.filter((u) => u.j1 && u.j2 && u.j1 !== u.j2).length }));
}

if (mode === "show") {
  const units = rj<Array<PairUnit | SurfUnit>>(join(OUT, `${set}-units.json`));
  units.forEach((u, i) => {
    if (u.j1 === u.j2) return;
    if (set === "surf") { const s = u as SurfUnit; console.log(`#${i} ${s.id}\n  j1=${s.j1} j2=${s.j2}\n  (${s.item.kind}) ${s.item.subject}: ${s.item.summary}\n  "${s.item.quote.slice(0, 220)}"`); }
    else { const p = u as PairUnit; console.log(`#${i} ${p.id}\n  A: ${showSide(p.A).slice(0, 420)}\n  B: ${showSide(p.B).slice(0, 420)}`); }
  });
}
