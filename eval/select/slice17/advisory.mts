// Slice 17 (PREREG.md): the advisory judge's requests (advisories.ts attachAdvisories, `judgeFix`), rebuilt from the
// current catalog. Every advisory in a technology's window that production judged (no holder named it by id in the
// release notes) gives one request per fixed line: the records released in that version, retrieval-ranked then
// security first, K = 8, never a record made from an advisory, exactly as judgeFix builds it. The advisory's own trace
// is taken off its holders first (its evidence and its entry in `advisories`), so the request reads as before the
// match. Jev 1.14 is asked fresh, with no cache.
//
//   cd central && UNSTALE_STORE=<restored production store> npx tsx ../eval/select/slice17/advisory.mts <tech>...
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { advisoryIncoming, basisOf, fetchAdvisories, fixesInWindow, isSecurity } from "../../../central/src/pipeline/advisories.ts";
import { Jev, type Classification } from "../../../central/src/pipeline/classify/adapter.ts";
import { pipelineTechnology, type PublicTechnology } from "../../../central/src/onboarding/discovery.ts";
import { fetchReleases } from "../../../central/src/pipeline/fetch.ts";
import { lineFn } from "../../../central/src/pipeline/lines.ts";
import { K, matchRequest, retrieve } from "../../../central/src/pipeline/match.ts";
import { centralDir } from "../../../central/src/pipeline/paths.ts";
import type { StoredRecord, TechStore } from "../../../central/src/pipeline/store.ts";
import { techLocal } from "../../../central/src/state/client.ts";
import { pool } from "../../../central/src/pipeline/util.ts";

const OUT = join(import.meta.dirname, "..", "out", "slice17");
mkdirSync(OUT, { recursive: true });
const C = centralDir();
const jobs = join(C, "onboarding", "jobs");
const descriptors = new Map<string, PublicTechnology>();
for (const f of readdirSync(jobs)) { const j = JSON.parse(readFileSync(join(jobs, f), "utf8")) as { descriptor?: PublicTechnology }; if (j.descriptor) descriptors.set(j.descriptor.id, j.descriptor); }
const advisoryOnly = (r: StoredRecord) => r.evidence.length > 0 && r.evidence.every((e) => e.kind === "advisory");
const jev = new Jev();
const usage = { calls: 0, input: 0 };
const out: Record<string, unknown> = {};
const dry = process.argv.includes("--dry");
for (const id of process.argv.slice(2).filter((x) => !x.startsWith("--"))) {
  const t = pipelineTechnology(descriptors.get(id)!);
  const s = JSON.parse(readFileSync(join(C, "records", `${techLocal(id)}.json`), "utf8")) as TechStore;
  const releases = (await fetchReleases(t, { offline: true })).notes;
  const lineOf = lineFn(s);
  const advisories = await fetchAdvisories(t, { offline: true });
  const work: Array<{ key: string; state: Record<string, unknown>; questions: Record<string, unknown>; rec: Record<string, unknown> }> = [];
  let named = 0, inWindow = 0;
  for (const a of advisories) {
    const fixes = fixesInWindow(a, releases, lineOf);
    if (!fixes.length) continue;
    inWindow++;
    const holders = Object.values(s.records).filter((r) => (r.advisories ?? []).some((x) => x.id === a.id));
    if (holders.some((r) => basisOf(r, a.id) === "id")) { named++; continue; }
    // The records without this advisory's trace.
    const view = (r: StoredRecord): StoredRecord => (holders.includes(r) ? { ...r, evidence: r.evidence.filter((e) => !(e.kind === "advisory" && e.url === a.url)), advisories: (r.advisories ?? []).filter((x) => x.id !== a.id) } : r);
    const active = Object.values(s.records).filter((r) => r.status === "active").map(view);
    for (const fix of fixes) {
      const inc = advisoryIncoming(t, a, fix);
      const poolRecs = active.filter((r) => !advisoryOnly(r) && r.releases.some((x) => x.version === fix.version));
      const byId = new Map(poolRecs.map((r) => [r.id, r]));
      const scored = retrieve(inc, poolRecs).map((c) => byId.get(c.id)!);
      const rest = poolRecs.filter((r) => !scored.includes(r)).sort((x, y) => Number(isSecurity(y)) - Number(isSecurity(x)) || x.id.localeCompare(y.id));
      const cands = [...scored, ...rest].slice(0, K);
      if (!cands.length) continue;
      const req = matchRequest(t.name, inc, false, cands);
      work.push({ key: inc.key, state: req.state, questions: req.questions, rec: { key: inc.key, tech: id, kind: "advisory", advisory: a.id, fix, cands, incoming: inc, guardInc: { breaking: false, quote: inc.quote, summary: inc.summary, kind: "advisory" }, holders: holders.map((r) => ({ id: r.id, basis: basisOf(r, a.id) })) } });
    }
  }
  if (!dry) await pool(work, 4, async (w) => {
    let ans: Classification | undefined;
    for (let i = 0; i < 3 && !ans; i++) ans = await jev.classify(w.state, w.questions as never).catch((e) => (console.error(`${w.key}: ${e}`), undefined));
    usage.calls++;
    usage.input += Math.ceil(JSON.stringify({ state: w.state, questions: w.questions }).length / 4);
    out[w.key] = { ...w.rec, state: w.state, questions: w.questions, answer: ans ?? null };
  });
  console.log(`${id}: ${advisories.length} advisories, ${inWindow} in window, ${named} named by id (not judged), ${work.length} judge requests`);
}
if (!dry) writeFileSync(join(OUT, "advisory-requests.json"), JSON.stringify(out) + "\n");
console.log(JSON.stringify({ requests: Object.keys(out), usage }).slice(0, 300));
