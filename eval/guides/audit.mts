// Cross-source match audit (upgrade guide item → release-notes record). For every guide item: extract and label it
// exactly as the pipeline does (cached Codex and Jev calls), retrieve its candidates from the current store (release
// notes only; nothing is written to the store), ask the Jev same-or-new judge as ingest does, and keep every pair the
// judge scores p >= 0.5. Each pair is then judged by Codex gpt-5.6-luna under the v3 identity rules
// (~/ati-slice2/harness/dm_match.py, RULES_V3) as the reference. Output: pairs.json (input to the audit table).
//
//   cd central && UNSTALE_CENTRAL_DIR=... npx tsx ../eval/guides/audit.mts <out-dir> [--offline]
import { join } from "node:path";
import { codex, parseJson } from "../lib/codex.ts";
import { interpret, labelQuestions, recordState } from "../../central/src/pipeline/classify/labels.ts";
import { extractRelease, type Incoming } from "../../central/src/pipeline/extract.ts";
import { fetchGuides, fetchReleases } from "../../central/src/pipeline/fetch.ts";
import { advisoryIds, matchRequest, retrieve } from "../../central/src/pipeline/match.ts";
import { makeClassifier } from "../../central/src/pipeline/pipeline.ts";
import { loadStore, type StoredRecord } from "../../central/src/pipeline/store.ts";
import { TECHNOLOGIES } from "../../central/src/pipeline/technologies.ts";
import { pool, writeAtomic } from "../../central/src/pipeline/util.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: audit.mts <out-dir> [--offline]");
const offline = process.argv.includes("--offline");

// dm_match.py RULES_V3, verbatim, plus the pipeline's "answer no when unsure".
const RULES_V3 = `Identity rules:
- Same change: the same thing changed in the same way. The change_type label does NOT matter: extractors label the
  same change as a fix in one run and a behaviour change in another.
- Not the same, even if related: a record about one specific function, option, flag or channel and a broader record
  about the feature it belongs to; the deprecation or removal of an old API and the addition of its replacement; a
  rename and the addition of the new name; two different options of one API; two separate fixes to one API; a change
  that breaks existing code and one that does not.`;

const REF = `You maintain a catalog of change records for %TECH%. Each numbered pair below holds an item extracted from
the official upgrade guide (A) and a record built from the official release notes (B). For each pair, decide whether A
and B describe the same change. The same change may be worded differently and at a different level of detail in a
guide and in release notes.

${RULES_V3}
If you are unsure, answer "different": a duplicate costs little, a wrong match hides a change.

Output only a JSON object mapping each pair number to "same" or "different".

%PAIRS%
`;

export interface Pair {
  n: number;
  technology: string;
  incoming: { key: string; subject: string; facet?: string; summary: string; quote: string; breaking: boolean; section?: string };
  candidate: { id: string; subject: string; facet?: string; summary: string; quotes: string[]; breaking: boolean; releases: string[] };
  p: number;
  rank: number;
  best: boolean;
  guards: { breaking: boolean; advisory: boolean };
  reference?: "same" | "different";
}

const cls = makeClassifier();
const pairs: Pair[] = [];
for (const t of Object.values(TECHNOLOGIES)) {
  const fetched = await fetchReleases(t, { offline });
  const guides = await fetchGuides(t, fetched.notes, { offline });
  const store = loadStore(t.id);
  const records = Object.values(store.records);
  const incoming: Incoming[] = (await pool(guides, 2, (g) => extractRelease(t, g))).flatMap((e) => e.incoming);
  const labels = await pool(incoming, 4, async (inc) => interpret(await cls.classify(recordState(t.name, inc), labelQuestions())));
  console.log(`${t.id}: ${incoming.length} guide items`);
  await pool(incoming, 4, async (inc, i) => {
    const lab = labels[i]!;
    const cands = retrieve(inc, records).map((c) => store.records[c.id]!);
    if (!cands.length) return;
    const req = matchRequest(t.name, inc, lab.breaking, cands);
    const res = await cls.classify(req.state, req.questions);
    const ps = cands.map((_, j) => res.answers[`same_c${j + 1}`]?.probabilities.yes ?? 0);
    const top = Math.max(...ps);
    cands.forEach((c: StoredRecord, j) => {
      const p = ps[j]!;
      if (p < 0.5) return;
      const ia = advisoryIds(`${inc.quote} ${inc.summary}`);
      const ca = advisoryIds(`${c.evidence.map((e) => e.quote).join(" ")} ${c.summary}`);
      pairs.push({
        n: 0,
        technology: t.id,
        incoming: { key: inc.key, subject: inc.subject, ...(inc.facet ? { facet: inc.facet } : {}), summary: inc.summary, quote: inc.quote, breaking: lab.breaking, ...(inc.section ? { section: inc.section } : {}) },
        candidate: {
          id: c.id,
          subject: c.subject,
          ...(c.facet ? { facet: c.facet } : {}),
          summary: c.summary,
          quotes: c.evidence.map((e) => e.quote),
          breaking: c.breaking,
          releases: [...new Set(c.releases.map((r) => r.version))],
        },
        p,
        rank: j + 1,
        best: p === top,
        guards: { breaking: lab.breaking && !c.breaking, advisory: !!(ia.size && ca.size && ![...ia].some((x) => ca.has(x))) },
      });
    });
  });
}
pairs.sort((a, b) => a.technology.localeCompare(b.technology) || a.incoming.key.localeCompare(b.incoming.key, "en", { numeric: true }) || b.p - a.p);
pairs.forEach((p, i) => (p.n = i + 1));

// Reference judgements, 12 pairs per Codex call, per technology.
const show = (p: Pair) =>
  `${p.n}.\n  A (upgrade guide${p.incoming.section ? `, section "${p.incoming.section}"` : ""}): subject ${p.incoming.subject}${p.incoming.facet ? ` [${p.incoming.facet}]` : ""}; ` +
  `breaking ${p.incoming.breaking}. ${p.incoming.summary}\n     Evidence: "${p.incoming.quote}"\n` +
  `  B (release notes ${p.candidate.releases.join(", ")}): subject ${p.candidate.subject}${p.candidate.facet ? ` [${p.candidate.facet}]` : ""}; ` +
  `breaking ${p.candidate.breaking}. ${p.candidate.summary}\n     Evidence: ${p.candidate.quotes.slice(0, 3).map((q) => `"${q}"`).join(" | ")}`;
const batches: Pair[][] = [];
for (const t of Object.keys(TECHNOLOGIES)) {
  const mine = pairs.filter((p) => p.technology === t);
  for (let i = 0; i < mine.length; i += 12) batches.push(mine.slice(i, i + 12));
}
await pool(batches, 4, async (b) => {
  const prompt = REF.replace("%TECH%", TECHNOLOGIES[b[0]!.technology]!.name).replace("%PAIRS%", b.map(show).join("\n\n"));
  const ans = await codex(prompt, (text) => {
    const v = parseJson(text, "object") as Record<string, unknown> | undefined;
    if (!v || !b.every((p) => v[String(p.n)] === "same" || v[String(p.n)] === "different")) return undefined;
    return v as Record<string, "same" | "different">;
  });
  for (const p of b) if (ans) p.reference = ans[String(p.n)];
});
writeAtomic(join(out, "pairs.json"), JSON.stringify(pairs, null, 1) + "\n");
const by = (f: (p: Pair) => boolean) => pairs.filter(f).length;
console.log(JSON.stringify({ pairs: pairs.length, reference_same: by((p) => p.reference === "same"), unjudged: by((p) => !p.reference), classifier: cls.counts }));
