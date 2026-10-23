// Slice 16 (PREREG.md): the fresh set's pairs and their reference verdicts, the Nuxt held-out method
// (eval/heldout/audit.mts): every (request, candidate) asked with Jev p >= 0.5; Codex gpt-5.6-luna under the v3 identity
// rules, 12 pairs a call, as audit.mts's prompt and display. My verdicts are applied on top (verdicts.json, by pair id).
//
//   cd central && UNSTALE_STORE=<side store> npx tsx ../eval/select/slice16/audit.mts <tech>... [--show]
//
// --show prints the pairs for reading, without any arm's decision.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codex, codexStats } from "../../lib/codex.ts";
import { parseJson } from "../../../central/src/pipeline/llm.ts";
import { shortRulesApply } from "../../../central/src/pipeline/match.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { StoredRecord } from "../../../central/src/pipeline/store.ts";
import type { Classification, Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { techLocal } from "../../../central/src/state/client.ts";
import { pool } from "../../../central/src/pipeline/util.ts";

const show = process.argv.includes("--show");
const techs = process.argv.slice(2).filter((x) => !x.startsWith("--"));
const OUT = join(import.meta.dirname, "..", "out", "slice16");
interface Req { key: string; tech: string; state: Record<string, unknown>; questions: Questions; cands: StoredRecord[]; answer: Classification; incoming: Incoming }
export interface Pair { id: string; tech: string; key: string; candidate: string; index: number; p: number; short: boolean; cross: boolean; incoming: Incoming; items: Incoming[]; reference?: "same" | "different" }
const kindOf = (x: { kind?: string }) => x.kind ?? "release_notes";
const pairs: Pair[] = [];
for (const tech of techs) {
  const reqs = JSON.parse(readFileSync(join(OUT, `${tech}-requests.json`), "utf8")) as Record<string, Req>;
  const incs = new Map<string, Incoming>();
  const ex = join(centralDir(), "extractions", techLocal(tech));
  for (const f of readdirSync(ex).filter((f) => f.endsWith(".json"))) for (const i of JSON.parse(readFileSync(join(ex, f), "utf8")) as Incoming[]) incs.set(i.key, i);
  for (const r of Object.values(reqs)) {
    const short = shortRulesApply(r.incoming, r.cands);
    r.cands.forEach((c, i) => {
      const p = r.answer.answers[`same_c${i + 1}`]?.probabilities.yes;
      if (p === undefined || p < 0.5) return;
      const items = c.sources.map((k) => incs.get(k)).filter((x): x is Incoming => !!x);
      pairs.push({ id: `${tech}|${r.key}|${c.id}`, tech, key: r.key, candidate: c.id, index: i, p, short, cross: !c.evidence.some((e) => kindOf(e) === kindOf(r.incoming)), incoming: r.incoming, items });
    });
  }
}

const RULES_V3 = `Identity rules:
- Same change: the same thing changed in the same way. The change_type label does NOT matter: extractors label the
  same change as a fix in one run and a behaviour change in another. The same change shipped in different releases
  (a backport to an older release line) is the same change.
- Not the same, even if related: a record about one specific function, option, flag or channel and a broader record
  about the feature it belongs to; the deprecation or removal of an old API and the addition of its replacement; a
  rename and the addition of the new name; two different options of one API; two separate fixes to one API; a change
  that breaks existing code and one that does not.`;
const REF = `You maintain a catalog of change records for %TECH%. Each numbered pair below holds an incoming item (A),
extracted from an official release note or upgrade guide, and an existing catalog record (B) with the items it was
built from. For each pair, decide whether A describes the same change as B.

${RULES_V3}
Two different security fixes or advisories are different changes, even in the same area.
If you are unsure, answer "different": a duplicate costs little, a wrong match hides a change.

Output only a JSON object mapping each pair number to "same" or "different".

%PAIRS%
`;
const src = (x: Incoming) => (kindOf(x) === "upgrade_guide" ? "upgrade guide" : `release notes ${x.version}`);
const fmt = (n: number, p: Pair) =>
  `${n}.\n  A (${src(p.incoming)}${p.incoming.section ? `, section "${p.incoming.section}"` : ""}): subject ${p.incoming.subject}${p.incoming.facet ? ` [${p.incoming.facet}]` : ""}. ${p.incoming.summary}\n     Evidence: "${p.incoming.quote}"\n` +
  `  B (${p.candidate}):\n` +
  p.items.slice(0, 3).map((x) => `     - ${src(x)}: subject ${x.subject}${x.facet ? ` [${x.facet}]` : ""}. ${x.summary} Evidence: "${x.quote}"`).join("\n");

if (show) {
  const prior = existsSync(join(OUT, "pairs.json")) ? (JSON.parse(readFileSync(join(OUT, "pairs.json"), "utf8")) as Pair[]) : [];
  const ref = new Map(prior.map((p) => [p.id, p.reference]));
  pairs.forEach((p, i) => console.log(`#${i + 1} [${p.short ? "short" : "other"}${p.cross ? ",cross" : ""}] codex=${ref.get(p.id) ?? "?"} ${p.id}\n${fmt(i + 1, p).split("\n").slice(1).join("\n")}\n`));
  process.exit(0);
}
const byTech = new Map<string, Pair[]>();
for (const p of pairs) byTech.set(p.tech, [...(byTech.get(p.tech) ?? []), p]);
const batches: Array<{ tech: string; b: Pair[] }> = [];
for (const [tech, ps] of byTech) for (let i = 0; i < ps.length; i += 12) batches.push({ tech, b: ps.slice(i, i + 12) });
await pool(batches, 4, async ({ tech, b }) => {
  const prompt = REF.replace("%TECH%", tech.replace(/-[0-9a-f]{8}$/, "")).replace("%PAIRS%", b.map((p, i) => fmt(i + 1, p)).join("\n\n"));
  const ans = await codex(prompt, (text: string) => {
    const v = parseJson(text, "object") as Record<string, unknown> | undefined;
    if (!v || !b.every((_, i) => v[String(i + 1)] === "same" || v[String(i + 1)] === "different")) return undefined;
    return v as Record<string, "same" | "different">;
  });
  b.forEach((p, i) => { if (ans) p.reference = ans[String(i + 1)]; });
});
writeFileSync(join(OUT, "pairs.json"), JSON.stringify(pairs, null, 1) + "\n");
console.log(JSON.stringify({ pairs: pairs.length, short: pairs.filter((p) => p.short).length, cross: pairs.filter((p) => p.cross).length, same: pairs.filter((p) => p.reference === "same").length, unjudged: pairs.filter((p) => !p.reference).length, codex: codexStats }));
