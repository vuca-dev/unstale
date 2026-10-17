// Held-out match audit (docs/match-audit-heldout.md). Reads the side store the held-out run wrote, rebuilds every
// pair the judge saw from the records' history (merges, p in [0.5, threshold), guard blocks at p >= 0.7) with each
// candidate as it stood when the incoming item was judged, and asks Codex gpt-5.6-luna for a reference verdict under
// the v3 identity rules (12 pairs per call, cached by request). No store writes.
//
//   cd central && UNSTALE_SRC=<exported central/src> UNSTALE_CENTRAL_DIR=<side store> \
//     npx tsx ../eval/heldout/audit.mts <technology> <out-dir>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = process.env.UNSTALE_SRC;
if (!SRC) throw new Error("set UNSTALE_SRC to an exported central/src");
const { codex, parseJson, codexStats } = await import(new URL("../lib/codex.ts", import.meta.url).href);
const { centralDir } = await import(`${SRC}/pipeline/paths.ts`);
const { advisoryIds, nearIdenticalQuote } = await import(`${SRC}/pipeline/match.ts`);
const { SAME_P, CROSS_SAME_P } = await import(`${SRC}/pipeline/thresholds.ts`);
const { compareVersions, pool, writeAtomic } = await import(`${SRC}/pipeline/util.ts`);

const [tech, out] = process.argv.slice(2);
if (!tech || !out) throw new Error("usage: audit.mts <technology> <out-dir>");

interface Inc {
  key: string;
  kind?: string;
  version: string;
  date: string;
  subject: string;
  facet?: string;
  summary: string;
  quote: string;
  section?: string;
}
interface Judged {
  id: string;
  p: number;
  outcome: string;
}
interface Rec {
  id: string;
  status: string;
  breaking: boolean;
  sources: string[];
  history: Array<{ action: string; detail?: string; judged?: Judged[] }>;
}

const dir = centralDir();
const store = JSON.parse(readFileSync(join(dir, "records", `${tech}.json`), "utf8")) as { records: Record<string, Rec>; ingested: Record<string, string> };
const incs = new Map<string, Inc>();
for (const f of readdirSync(join(dir, "extractions", tech))) {
  for (const i of JSON.parse(readFileSync(join(dir, "extractions", tech, f), "utf8")) as Inc[]) incs.set(i.key, i);
}
// Ingest order, as pipeline.ts sorts it.
const order = [...incs.values()].sort((a, b) => a.date.localeCompare(b.date) || compareVersions(a.version, b.version) || a.key.localeCompare(b.key, "en", { numeric: true }));
const at = new Map(order.map((x, i) => [x.key, i]));
const kindOf = (i: Inc) => i.kind ?? "release_notes";

export interface Pair {
  n: number;
  kind: "merge" | "near" | "blocked";
  cross: boolean;
  outcome: string;
  p: number;
  incoming: Inc & { breaking?: boolean };
  candidate: { id: string; items: Inc[] };
  quoteNear: boolean;
  advisory: boolean;
  reference?: "same" | "different";
}

const pairs: Pair[] = [];
for (const r of Object.values(store.records)) {
  for (const h of r.history) {
    if (!h.judged?.length || !h.detail) continue;
    const key = h.detail.split(" ")[0]!;
    const inc = incs.get(key);
    if (!inc) continue;
    const t = at.get(key)!;
    for (const j of h.judged) {
      const c = store.records[j.id];
      if (!c) continue;
      const items = c.sources.filter((k) => (at.get(k) ?? Infinity) < t).map((k) => incs.get(k)!).filter(Boolean);
      const cross = !items.some((x) => kindOf(x) === kindOf(inc));
      const thr = cross ? CROSS_SAME_P : SAME_P;
      let kind: Pair["kind"] | undefined;
      if (j.outcome === "same") kind = "merge";
      else if (j.outcome.startsWith("guard:") && j.p >= SAME_P) kind = "blocked";
      else if (j.outcome === "below" && j.p >= 0.5 && j.p < thr) kind = "near";
      if (!kind) continue;
      const text = (x: Inc) => `${x.quote} ${x.summary}`;
      pairs.push({
        n: 0,
        kind,
        cross,
        outcome: j.outcome,
        p: j.p,
        incoming: inc,
        candidate: { id: c.id, items },
        quoteNear: items.some((x) => kindOf(x) === kindOf(inc) && nearIdenticalQuote(inc.quote, x.quote)),
        advisory: /security|vulnerab|advisor|cve|ghsa|xss|bypass|injection|dos\b|denial of service|rce|ssrf/i.test(`${text(inc)} ${items.map(text).join(" ")}`) || advisoryIds(`${text(inc)} ${items.map(text).join(" ")}`).size > 0,
      });
    }
  }
}
pairs.sort((a, b) => (at.get(a.incoming.key)! - at.get(b.incoming.key)!) || b.p - a.p);
pairs.forEach((p, i) => (p.n = i + 1));

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
const src = (x: Inc) => (kindOf(x) === "upgrade_guide" ? "upgrade guide" : `release notes ${x.version}`);
const show = (p: Pair) =>
  `${p.n}.\n  A (${src(p.incoming)}${p.incoming.section ? `, section "${p.incoming.section}"` : ""}): subject ${p.incoming.subject}${p.incoming.facet ? ` [${p.incoming.facet}]` : ""}. ${p.incoming.summary}\n     Evidence: "${p.incoming.quote}"\n` +
  `  B (${p.candidate.id}):\n` +
  p.candidate.items.slice(0, 3).map((x) => `     - ${src(x)}: subject ${x.subject}${x.facet ? ` [${x.facet}]` : ""}. ${x.summary} Evidence: "${x.quote}"`).join("\n");
const batches: Pair[][] = [];
for (let i = 0; i < pairs.length; i += 12) batches.push(pairs.slice(i, i + 12));
await pool(batches, 4, async (b) => {
  const prompt = REF.replace("%TECH%", tech).replace("%PAIRS%", b.map(show).join("\n\n"));
  const ans = await codex(prompt, (text: string) => {
    const v = parseJson(text, "object") as Record<string, unknown> | undefined;
    if (!v || !b.every((p) => v[String(p.n)] === "same" || v[String(p.n)] === "different")) return undefined;
    return v as Record<string, "same" | "different">;
  });
  for (const p of b) if (ans) p.reference = ans[String(p.n)];
});
writeAtomic(join(out, "pairs.json"), JSON.stringify(pairs, null, 1) + "\n");
const count = (f: (p: Pair) => boolean) => pairs.filter(f).length;
console.log(
  JSON.stringify({
    pairs: pairs.length,
    merges: count((p) => p.kind === "merge"),
    merges_cross: count((p) => p.kind === "merge" && p.cross),
    near: count((p) => p.kind === "near"),
    blocked: count((p) => p.kind === "blocked"),
    merge_reference_different: count((p) => p.kind === "merge" && p.reference === "different"),
    nonmerge_reference_same: count((p) => p.kind !== "merge" && p.reference === "same"),
    unjudged: count((p) => !p.reference),
    codex: codexStats,
  }),
);
