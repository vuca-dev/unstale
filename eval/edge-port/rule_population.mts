// "Same-or-new by rule" (RESULTS.md): how often the rule decides on ordinary records. Every record of a stored
// technology is ingested again from empty, in ingest order, following the store's own decisions (as
// eval/select/slice5/floor.mts does), and at each record the rule is applied to the candidates production would ask
// about (question floor 0.6). No model call. The rule here is the client's (`local/cli/src/pipeline/matching.rs`
// `by_rule`): central's own guards at probability 0, and the quote naming both subjects. Labels are the stored
// record's (the stored label answers are keyed on older question wording).
//
//   cd central && npx tsx ../eval/edge-port/rule_population.mts OUT/rule-population-differences.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const S = await import("../select/states.ts");
const M = await import("../../central/src/pipeline/match.ts");
const { compareVersions } = await import("../../central/src/pipeline/util.ts");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const FLOOR = 0.6;
const words = (s: string) => new Set((s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? []));
export function named(subject: string, facet: string | undefined, quote: string): boolean {
  const q = words(quote);
  for (const w of words(`${subject} ${facet ?? ""}`)) {
    if (q.has(w)) return true;
    if (w.length >= 4) for (const x of q) if (x.length >= 4 && (x.startsWith(w) || w.startsWith(x))) return true;
  }
  return false;
}
const out: any[] = [];
for (const [store, techs] of [["central-trust-nuxt", ["nuxt"]], ["central-v1", ["next", "prisma", "nestjs"]]] as const) {
  const central = join(S.STORE, store);
  for (const tech of techs) {
    let real: any;
    try { real = readJson(join(central, "records", `${tech}.json`)); } catch { console.log(`${store}/${tech}: no store`); continue; }
    const order: any[] = [];
    for (const inc of S.extractions(central, tech).values()) {
      const want = real.ingested[inc.key]; if (!want) continue;
      const r = real.records[want]; if (!r) continue;
      // The stored label answers no longer match this tree's question wording, so the labels are the final record's.
      order.push({ inc, lab: { change_type: r.change_type, surface: r.surface, breaking: r.breaking, benefit: r.benefit, classifier: r.classifier } });
    }
    order.sort((x, y) => x.inc.date.localeCompare(y.inc.date) || compareVersions(x.inc.version, y.inc.version) || x.inc.key.localeCompare(y.inc.key, "en", { numeric: true }));
    const s: any = { technology: tech, records: {}, ingested: {}, ...(real.releaseIndex ? { releaseIndex: real.releaseIndex } : {}) };
    const c = { records: 0, withCands: 0, asked: 0, storeMerged: 0, fires: 0, firesNamed: 0, agree: 0, agreeNamed: 0, elsewhere: 0, elsewhereNamed: 0, storeNew: 0, storeNewNamed: 0, agreeRepro: 0, snapFires: 0 };
    for (const { inc, lab } of order) {
      c.records++;
      const cands = M.retrieve(inc, Object.values(s.records));
      const want = real.ingested[inc.key]!;
      const recs = cands.map((x: any) => s.records[x.id]!);
      const merged = recs.some((r: any) => r.id === want);
      if (cands.length) {
        c.withCands++;
        const short = M.shortRulesApply(inc, recs);
        const askedIdx = cands.map((x: any, i: number) => (!short || x.score >= FLOOR ? i : -1)).filter((i: number) => i >= 0);
        if (askedIdx.length) c.asked++;
        if (merged) c.storeMerged++;
        const g = { breaking: lab.breaking, quote: inc.quote, summary: inc.summary, kind: M.kindOf(inc), url: inc.url, snapshot: inc.snapshot, version: inc.version };
        const pass = askedIdx.filter((i: number) => M.guard(g, recs[i], 0) === undefined);
        const kind = M.kindOf(inc);
        const passNamed = pass.filter((i: number) => named(inc.subject, inc.facet, inc.quote) && recs[i].evidence.some((e: any) => (e.kind ?? "release_notes") === kind && M.nearIdenticalQuote(inc.quote, e.quote) && named(recs[i].subject, recs[i].facet, e.quote)));
        const row = (i: number, isNamed: boolean) => ({ store, tech, key: inc.key, named: isNamed, storeDecision: merged ? `merged into ${want}` : "new record", rule: recs[i].id,
          inc: { subject: inc.subject, facet: inc.facet, summary: inc.summary, quote: inc.quote, version: inc.version, breaking: lab.breaking },
          cand: { subject: recs[i].subject, facet: recs[i].facet, summary: recs[i].summary, quotes: recs[i].evidence.map((e: any) => e.quote), releases: recs[i].releases.map((r: any) => r.version), breaking: recs[i].breaking } });
        if (pass.length) {
          c.fires++;
          const i = pass[0]!;
          if (recs[i].id === want) c.agree++;
          else if (merged) { c.elsewhere++; out.push({ kind: "elsewhere", ...row(i, passNamed.includes(i)) }); }
          else { c.storeNew++; out.push({ kind: "store-new", ...row(i, passNamed.includes(i)) }); }
        }
        const snapPass = recs.slice(0, 4).some((r: any) => M.guard(g, r, 0) === undefined && named(inc.subject, inc.facet, inc.quote) && r.evidence.some((e: any) => (e.kind ?? "release_notes") === kind && M.nearIdenticalQuote(inc.quote, e.quote) && named(r.subject, r.facet, e.quote)));
        if (snapPass) c.snapFires++;
        if (passNamed.length) {
          c.firesNamed++;
          const i = passNamed[0]!;
          if (recs[i].id === want) c.agreeNamed++; else if (merged) c.elsewhereNamed++; else c.storeNewNamed++;
        }
      }
      const o = await M.ingest(s, S.techName(tech), S.components(tech), inc, lab, async (_st: any, qs: any) => ({
        classifier: "jev", model: "follow",
        answers: Object.fromEntries(Object.keys(qs).map((k) => { const y = cands[Number(k.slice("same_c".length)) - 1]?.id === want ? 1 : 0; return [k, { choice: y ? "yes" : "no", confidence: 1, probabilities: { yes: y, no: 1 - y } }]; })),
      }), { questionFloor: false });
      if (o.id === want) c.agreeRepro++;
    }
    console.log(store, tech, JSON.stringify(c));
  }
}
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));
