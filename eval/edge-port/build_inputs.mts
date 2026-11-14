// Port parity inputs (PREREGISTRATION.md): central's own evaluation inputs, written in the shape the client's
// `unstale internal run-step` reads, plus what central would send for each item, so the client's requests can be
// compared with central's byte for byte. No model call.
//
//   cd central && npx tsx ../eval/edge-port/build_inputs.mts
//
// Reads (never writes): eval/select/holdout*, eval/select/out/slice4 and slice5 (central's stored evaluation outputs,
// gitignored) and .store (central's stored extractions). Writes eval/edge-port/out/inputs/ (gitignored) and
// eval/edge-port/inputs-manifest.json (counts and sha256 of every input file).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HERE = import.meta.dirname;
const SELECT = join(HERE, "..", "select");
const OUT = join(HERE, "out", "inputs");
const CENTRAL_OUT = process.env.EDGE_PORT_CENTRAL_OUT ?? join(SELECT, "out");
process.env.UNSTALE_CENTRAL_DIR = join(HERE, "out", "central-scratch");
const { eventOf } = await import("../../central/src/pipeline/events.ts");
const { chunk, contentFree, EXTRACT_PROMPT, fill } = await import("../../central/src/pipeline/extract.ts");
const { ChatClassifier, ClassifierCache, Jev } = await import("../../central/src/pipeline/classify/adapter.ts");
const { labelQuestions, recordState } = await import("../../central/src/pipeline/classify/labels.ts");
const { matchRequest, retrieve } = await import("../../central/src/pipeline/match.ts");
const { shardLine } = await import("../../central/src/pipeline/publish.ts");
const S = await import("../select/states.ts");
import type { Questions } from "../../central/src/pipeline/classify/adapter.ts";
import type { Incoming } from "../../central/src/pipeline/extract.ts";
import type { StoredRecord } from "../../central/src/pipeline/store.ts";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
mkdirSync(OUT, { recursive: true });
const manifest: Record<string, unknown> = {};
function write(name: string, lines: unknown[], extra: Record<string, unknown> = {}) {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(OUT, name), text);
  manifest[name] = { items: lines.length, sha256: sha(text), bytes: Buffer.byteLength(text), ...extra };
}
const jev = new Jev({ apiKey: () => "unused" });
const chat = new ChatClassifier({ model: "openai/gpt-6-luna", run: async () => undefined });
/** What central sends for a closed-choice request: the labelling service's bodies (one per batch of questions) and the
 * chat prompt. */
function centralRequests(state: Record<string, unknown>, questions: Questions) {
  const bodies = jev.batches(state, questions).map((qs) => JSON.stringify((jev as unknown as { body(s: unknown, q: unknown): unknown }).body(state, qs)));
  return { state_sha256: sha(JSON.stringify(state)), jev_bodies_sha256: bodies.map(sha), chat_prompt_sha256: sha(chat.prompt(state, questions)), jev_bodies: bodies };
}

// ---- Extraction: the two held-out sets of notes as change events (slice 3's run3.mts heldoutDocs / heldout2Docs) ----
const FRESH = { first_seen: "2026-11-11T00:00:00.000Z", first_published: "2026-11-11T00:00:00.000Z" };
function extractSet(name: string, dir: string, guideTag: boolean) {
  const H = join(SELECT, dir, "extraction");
  const m = readJson<{ notes: Array<{ note_file: string; technology: string; name: string; kind?: string; version: string; date: string; url: string; snapshot?: string }> }>(join(H, "notes.json"));
  const events: unknown[] = [];
  const expected: Array<{ note: string; event: string; chunk: string; chars: number; content_free: boolean; extract_prompt_sha256: string }> = [];
  for (const n of m.notes) {
    const notes = readFileSync(join(H, "notes", n.note_file), "utf8");
    const guide = guideTag && n.kind === "guide";
    const note = { technology: n.technology, version: n.version, date: n.date, url: n.url, snapshot: n.snapshot ?? "", notes, ...(guide ? { kind: "upgrade_guide" as const, keyTag: "+guide.h2" } : {}) };
    const ev = eventOf({ id: n.technology, name: n.name }, note as never);
    events.push({ ...ev, freshness: FRESH });
    // The harness's own cut (`chunk`) must be the event's.
    const parts = chunk(notes);
    if (parts.length !== ev.chunks.length || parts.some((p, i) => p !== ev.chunks[i]!.text)) throw new Error(`${n.note_file}: event chunks differ from chunk()`);
    parts.forEach((p, ci) => {
      const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      expected.push({ note: n.note_file, event: ev.id, chunk: ev.chunks[ci]!.id, chars: p.length, content_free: !p.trim() || contentFree(p),
        extract_prompt_sha256: sha(fill(EXTRACT_PROMPT, { TECH: n.name, VERSION: n.version, DATE: n.date, PART: part, NOTES: p })) });
    });
  }
  write(`extract-${name}.jsonl`, events, { chunks: expected.length });
  writeFileSync(join(OUT, `extract-${name}.expected.json`), JSON.stringify(expected, null, 1) + "\n");
}
extractSet("h1", "holdout", false);
extractSet("h2", "holdout-majors", true);

// ---- Labels: slice 4's two held-out sets ----
const Q = labelQuestions();
const KIND: Record<string, string | undefined> = { "release notes": undefined, "upgrade guide": "upgrade_guide", "documentation": "docs" };
{
  // H1 stores each record's state, not its extraction: the record is rebuilt from the state, and central's own
  // recordState must give the state back, byte for byte.
  const recs = readJson<{ records: Array<{ id: string; technology: string; state: Record<string, unknown> }> }>(join(SELECT, "holdout", "classify", "records.json")).records;
  const lines: unknown[] = [];
  const expected: Record<string, unknown> = {};
  for (const r of recs) {
    const s = r.state as { technology: string; source: string; release: string; subject: string; facet?: string; summary: string; evidence: string; section?: string; introduces: string[]; replaces: string[] };
    const sources = Object.keys(KIND);
    const kindName = sources.find((k) => s.source === k || s.source.startsWith(k));
    if (kindName === undefined) throw new Error(`${r.id}: unknown source ${s.source}`);
    const kind = KIND[kindName];
    const incoming = { key: r.id, ...(kind ? { kind } : {}), technology: r.technology, version: s.release, date: "", line: "", url: "", snapshot: "", subject: s.subject, subject_kind: "concept",
      ...(s.facet !== undefined ? { facet: s.facet } : {}), summary: s.summary, introduces: s.introduces, quote: s.evidence, ...(s.section !== undefined ? { section: s.section } : {}),
      grounded: true, terms: [], replaces: s.replaces, requires: [], prerequisites: [], conditions: [] };
    const back = recordState(s.technology, incoming as unknown as Incoming);
    if (JSON.stringify(back) !== JSON.stringify(r.state)) throw new Error(`${r.id}: recordState does not give the stored state back`);
    lines.push({ uid: `heldout:${r.id}`, name: s.technology, incoming });
    expected[`heldout:${r.id}`] = centralRequests(r.state, Q);
  }
  write("labels-h1.jsonl", lines);
  writeFileSync(join(OUT, "labels-h1.expected.json"), JSON.stringify(expected) + "\n");
}
{
  const units = readJson<{ units: Array<{ id: string; name: string; incoming: Incoming }> }>(join(CENTRAL_OUT, "slice4", "h2-units.json")).units;
  const expected: Record<string, unknown> = {};
  for (const u of units) expected[u.id] = centralRequests(recordState(u.name, u.incoming), Q);
  write("labels-h2.jsonl", units.map((u) => ({ uid: u.id, name: u.name, incoming: u.incoming })));
  writeFileSync(join(OUT, "labels-h2.expected.json"), JSON.stringify(expected) + "\n");
}

// ---- Matching: slice 5's held-out requests (Nuxt, and the Next.js guide), as production asks them today ----
{
  const OUT5 = join(CENTRAL_OUT, "slice5");
  const D = readJson<{ units: Array<{ set: string; tech: string; key: string; split: string; req: string; cands: StoredRecord[]; guardInc: { breaking: boolean } }> }>(join(OUT5, "units.json"));
  const exts = new Map<string, Map<string, Incoming>>();
  const incOf = (set: string, tech: string, key: string): Incoming | undefined => {
    const id = `${set}:${tech}`;
    if (!exts.has(id)) {
      const dirs = set === "within" ? ["central-v1"] : set === "nuxt" ? ["central-trust-nuxt"] : ["central", "central-pre-rematch"];
      exts.set(id, new Map(dirs.flatMap((d) => [...S.extractions(join(S.STORE, d), tech)])));
    }
    return exts.get(id)!.get(key);
  };
  const cache = new ClassifierCache(join(OUT5, "cache", "j2-Q8-heldout", "cls"));
  const q8 = readJson<Record<string, { model: string; answers: Record<string, unknown> } | null>>(join(OUT5, "runs", "j2-Q8-heldout", "answers.json"));
  const lines: unknown[] = [];
  const expected: Record<string, unknown> = {};
  const seen = new Set<string>();
  let hits = 0, asked = 0, sameQuestions = 0;
  for (const u of D.units.filter((x) => x.split === "heldout")) {
    const id = `${u.set}|${u.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const inc = incOf(u.set, u.tech, u.key);
    if (!inc) throw new Error(`${id}: no stored extraction`);
    const got = retrieve(inc, u.cands);
    if (got.map((c) => c.id).join() !== u.cands.map((c) => c.id).join()) throw new Error(`${id}: retrieve does not reproduce the candidate order`);
    const name = S.techName(u.tech);
    const req = matchRequest(name, inc, u.guardInc.breaking, u.cands, got.map((c) => c.score));
    const n = Object.keys(req.questions).length;
    // Central's Q8 run (production's wording and question floor) asked exactly this request if its cache holds it.
    const hit = n > 0 && cache.get(jev, req.state, req.questions) !== undefined;
    if (n) asked++;
    if (hit) hits++;
    const q8ids = Object.keys(q8[u.req]?.answers ?? {}).sort().join();
    if (q8ids === Object.keys(req.questions).sort().join()) sameQuestions++;
    // The candidates as the catalog publishes a record (central's own shardLine), which is what the client reads.
    lines.push({ uid: id, req: u.req, name, incoming: inc, breaking: u.guardInc.breaking, candidates: u.cands.map((c) => shardLine(c, false)) });
    expected[id] = { req: u.req, questions: Object.keys(req.questions), in_central_q8_cache: hit, ...(n ? centralRequests(req.state, req.questions) : {}) };
  }
  write("match-heldout.jsonl", lines, { requests_with_questions: asked, in_central_q8_cache: hits, same_questions_as_central_q8_run: sameQuestions });
  writeFileSync(join(OUT, "match-heldout.expected.json"), JSON.stringify(expected) + "\n");
}

writeFileSync(join(HERE, "inputs-manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify(manifest, null, 1));
