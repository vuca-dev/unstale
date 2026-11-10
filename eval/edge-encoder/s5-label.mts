// Edge encoder, stage 5 (PREREG.md): two blind reference labelers on s5-units.py's packet (record states only), on
// the held-out packet's questions (../select/holdout/classify/PACKET.md, "## Questions", verbatim). J1 is Codex
// gpt-5.6-luna, J2 openai/gpt-6-luna on the AI gateway (reasoning low), as slice 17: the same prompt, 12 records a call.
//
//   cd central && npx tsx ../eval/edge-encoder/s5-label.mts judge <s5 dir>
//   cd central && npx tsx ../eval/edge-encoder/s5-label.mts show <s5 dir>     (J1/J2 disagreements, states only)
//
// judge writes <s5 dir>/labels-j1.json, labels-j2.json and label-usage.json. Adjudications: s5-adjudicated.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codex, codexStats } from "../lib/codex.ts";
import { ChatClient, PROVIDERS } from "../select/client.ts";
import { parseJson } from "../../central/src/pipeline/llm.ts";
import { pool } from "../../central/src/pipeline/util.ts";

const [mode, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: s5-label.mts <judge|show> <s5 dir>");
const rj = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const packetMd = readFileSync(join(import.meta.dirname, "..", "select", "holdout", "classify", "PACKET.md"), "utf8");
const QUESTIONS = packetMd.slice(packetMd.indexOf("## Questions"), packetMd.indexOf("## Output")).trim();
const CT = ["new_api", "new_option", "behavior_change", "default_change", "fix", "deprecation", "removal", "stability_change", "performance", "security", "tooling", "other"];
const BEN = ["security", "correctness", "performance", "cost", "maintainability", "none"];

type State = Record<string, unknown>;
interface Label { breaking: boolean; benefit: string[]; change_type: string; actionable: boolean; note?: string }
const packet = rj<Record<string, State>>(join(dir, "packet.json"));
const ids = Object.keys(packet);

const PROMPT = (body: string) => `You label change records of software libraries and frameworks. Each numbered record below is one change
record exactly as a classifier sees it (its state: technology, source, release, subject, summary, the verbatim
evidence quote and section, what it introduces and replaces). Judge each record from its state alone.

If a record does not describe a real change (garbled, or not a change at all), still answer every field from what
the record says, and add "note": "not a change".

${QUESTIONS}

## Output

Output only a JSON object mapping each record number to its labels, for example:
{"1": {"breaking": false, "benefit": ["none"], "change_type": "fix", "actionable": false},
 "2": {"breaking": true, "benefit": ["correctness"], "change_type": "removal", "actionable": true}}

## Records

${body}
`;

const okLabel = (x: unknown): x is Label => {
  const l = x as Label;
  return !!l && typeof l.breaking === "boolean" && typeof l.actionable === "boolean" && CT.includes(l.change_type) &&
    Array.isArray(l.benefit) && l.benefit.length > 0 && l.benefit.every((b) => BEN.includes(b));
};
const parseBatch = (n: number) => (t: string): Record<string, Label> | undefined => {
  const v = parseJson(t, "object") as Record<string, unknown> | undefined;
  return v && Array.from({ length: n }, (_, i) => v[String(i + 1)]).every(okLabel) ? (v as Record<string, Label>) : undefined;
};

if (mode === "judge") {
  const gw = new ChatClient({ provider: PROVIDERS.vercel!, cacheDir: join(dir, "cache", "j2"), usageLog: join(dir, "j2-usage.jsonl"), concurrency: 4 });
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 12) batches.push(ids.slice(i, i + 12));
  const j1: Record<string, Label> = {};
  const j2: Record<string, Label> = {};
  await pool(batches, 4, async (b) => {
    const prompt = PROMPT(b.map((id, i) => `${i + 1}. ${JSON.stringify(packet[id])}`).join("\n\n"));
    const parse = parseBatch(b.length);
    const [a1, c2] = await Promise.all([
      codex(prompt, parse),
      gw.complete({ model: "openai/gpt-6-luna", messages: [{ role: "user", content: prompt }], max_tokens: 16000, reasoning_effort: "low" } as never, parse, { step: "edge-s5" }),
    ]);
    b.forEach((id, i) => {
      if (a1) j1[id] = a1[String(i + 1)]!;
      if (c2.value) j2[id] = c2.value[String(i + 1)]!;
    });
  });
  writeFileSync(join(dir, "labels-j1.json"), JSON.stringify(j1, null, 1));
  writeFileSync(join(dir, "labels-j2.json"), JSON.stringify(j2, null, 1));
  const usage = { batches: batches.length, codex: codexStats, gateway: gw.stats };
  writeFileSync(join(dir, "label-usage.json"), JSON.stringify(usage, null, 1));
  console.log(JSON.stringify({ units: ids.length, j1: Object.keys(j1).length, j2: Object.keys(j2).length, ...usage }));
}

const FIELDS = ["breaking", "benefit_any", "benefit", "change_type", "actionable"] as const;
const val = (l: Label, f: (typeof FIELDS)[number]) =>
  f === "benefit_any" ? l.benefit.some((b) => b !== "none") : f === "benefit" ? [...new Set(l.benefit.filter((b) => b !== "none"))].sort().join(",") || "none" : l[f];

if (mode === "show") {
  const j1 = rj<Record<string, Label>>(join(dir, "labels-j1.json"));
  const j2 = rj<Record<string, Label>>(join(dir, "labels-j2.json"));
  const counts: Record<string, number> = {};
  for (const id of ids) {
    const a = j1[id], b = j2[id];
    if (!a || !b) { console.log(`#${id} missing ${a ? "" : "j1 "}${b ? "" : "j2"}`); continue; }
    const diff = FIELDS.filter((f) => String(val(a, f)) !== String(val(b, f)));
    if (!diff.length) continue;
    diff.forEach((f) => (counts[f] = (counts[f] ?? 0) + 1));
    console.log(`## ${id}\n  ${diff.map((f) => `${f}: j1=${val(a, f)} j2=${val(b, f)}`).join(" | ")}\n  ${JSON.stringify(packet[id])}`);
  }
  console.log(JSON.stringify({ disagreements_by_field: counts }));
}
if (mode !== "judge" && mode !== "show") throw new Error(`unknown mode ${mode}`);
