// Builds the held-out packets (PREREG.md sections 2 and 3). Reads .store (never writes it); bulky outputs go to
// eval/select/out/holdout/, packet data to eval/select/holdout/.
//
//   cd central && npx tsx ../eval/select/holdout/build.mts notes          # PyPI bodies to out/holdout/notes, all notes listed
//   cd central && npx tsx ../eval/select/holdout/build.mts feasibility    # npm: does the store's Codex cache rebuild every chunk?
//   cd central && npx tsx ../eval/select/holdout/build.mts extraction     # the 40-note sample
//   cd central && npx tsx ../eval/select/holdout/build.mts extract-pypi   # Luna via Codex over all in-window PyPI notes (calls)
//   cd central && npx tsx ../eval/select/holdout/build.mts classify       # the 240-record sample and records.json
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.env.UNSTALE_CENTRAL_DIR = join(import.meta.dirname, "..", "out", "central");
const { OUT_DIR, dollars, loadPrices, logUsageLine, priceOf } = await import("../client.ts");
const { runCodex, parseJson, CODEX_MODEL } = await import("../../lib/codex.ts");
const { chunk, EXTRACT_PROMPT, Extracted, fill, LABEL_PROMPT, strings, toIncoming } = await import("../../../central/src/pipeline/extract.ts");
const { recordState } = await import("../../../central/src/pipeline/classify/labels.ts");
const { pipelineTechnology, technologyId } = await import("../../../central/src/onboarding/discovery.ts");
const { pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
const S = await import("../states.ts");
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { Technology } from "../../../central/src/pipeline/technologies.ts";

const SEED = "unstale-holdout-v1";
const H = (kind: string, id: string): string => sha256(`${SEED}:${kind}:${id}`);
const HERE = import.meta.dirname;
const OUT = join(OUT_DIR, "holdout");
const CENTRAL = join(S.STORE, "central");
const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const writeJson = (p: string, v: unknown): void => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
};

// ---- Technologies (select_tech.py's picks) ----

interface Tech {
  t: Technology;
  ecosystem: "npm" | "pypi";
  style: string;
  purl: string;
}
interface Note {
  tech: string;
  version: string;
  date: string;
  url: string;
  snapshot: string;
  notes: string;
}

function techs(): Tech[] {
  const npm = readJson<{ order: Record<string, string[]> }>(join(OUT, "selection-npm.json")).order;
  const fixed = readJson<{ npm: Record<string, string> }>(join(HERE, "technologies.json"));
  const jobs = readdirSync(join(CENTRAL, "onboarding", "jobs")).map((f) => readJson<{ technology: string; purl: string; descriptor: Parameters<typeof pipelineTechnology>[0] }>(join(CENTRAL, "onboarding", "jobs", f)));
  const out: Tech[] = [];
  for (const [style, id] of Object.entries(fixed.npm)) {
    if (!npm[style]?.includes(id)) throw new Error(`${id} is not in the ${style} order`);
    const j = jobs.find((x) => x.technology === id)!;
    out.push({ t: pipelineTechnology(j.descriptor), ecosystem: "npm", style, purl: j.purl });
  }
  const pypi = readJson<{ picks: string[]; rows: Array<{ repo: string; style: string }> }>(join(OUT, "selection-pypi.json"));
  for (const repo of pypi.picks) {
    const name = repo.split("/")[1]!.toLowerCase();
    const purl = `pkg:pypi/${name}`;
    out.push({
      t: { id: technologyId(purl), name, repo, components: [purl], tag: /^v?(\d+(?:\.\d+){1,3})$/, clean: (b) => b.replace(/\n#+\s*Credits[\s\S]*$/, "") },
      ecosystem: "pypi",
      style: pypi.rows.find((r) => r.repo === repo)!.style,
      purl,
    });
  }
  return out;
}

function notesOf(x: Tech): Note[] {
  if (x.ecosystem === "npm") {
    const idx = readJson<{ releases: Array<Omit<Note, "notes" | "tech">> }>(join(CENTRAL, "releases", x.t.id, "index.json")).releases;
    return idx.map((r) => {
      const raw = readFileSync(join(CENTRAL, "releases", x.t.id, `${r.version}.md`), "utf8");
      if (`sha256:${sha256(raw)}` !== r.snapshot) throw new Error(`changed on disk: ${x.t.id} ${r.version}`);
      return { tech: x.t.id, version: r.version, date: r.date, url: r.url, snapshot: r.snapshot, notes: x.t.clean(raw) };
    });
  }
  const rels = readJson<Array<{ version: string; date: string; url: string; body: string }>>(join(OUT, "notes-raw", x.t.repo.replace("/", "__"), "releases.json"));
  return rels
    .map((r) => {
      const p = join(OUT, "notes", x.t.id, `${r.version}.md`);
      if (!existsSync(p)) {
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, r.body);
      }
      const raw = readFileSync(p, "utf8");
      return { tech: x.t.id, version: r.version, date: r.date, url: r.url, snapshot: `sha256:${sha256(raw)}`, notes: x.t.clean(raw) };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.version.localeCompare(b.version, "en", { numeric: true }));
}

// ---- Strata (PREREG section 2) ----

const CONV = new Set(["major changes", "minor changes", "patch changes", "features", "new features", "bug fixes", "fixes", "performance improvements",
  "performance", "reverts", "breaking changes", "breaking", "deprecations", "deprecated", "documentation", "docs", "refactor", "refactoring", "chores",
  "miscellaneous", "tests", "build system", "continuous integration", "dependencies", "added", "changed", "removed", "fixed", "security",
  "improvements", "enhancements", "internal"]);
const normHeading = (h: string): string => h.replace(/[^\p{L}\p{N}_\s'’]/gu, " ").replace(/^\s*\d+[\s.]*/, "").replace(/\s+/g, " ").trim().toLowerCase();
export const structured = (text: string): boolean => text.split("\n").some((l) => {
  const m = /^#{1,6}\s+(.*)$/.exec(l.replace(/\r$/, ""));
  return !!m && CONV.has(normHeading(m[1]!));
});
const cellOf = (n: string): string => `${n.length < 1500 ? "short" : "long"}-${structured(n) ? "structured" : "prose"}`;
const CELLS = ["long-structured", "long-prose", "short-structured", "short-prose"];

// ---- Codex (cache first: the store's, then ours; calls only when allowed) ----

const prices = loadPrices();
const price = priceOf(prices, "codex", CODEX_MODEL);
const calls = { cached: 0, made: 0, failed: 0 };
async function codex<T>(prompt: string, parse: (t: string) => T | undefined, step: string, allowCall: boolean): Promise<T | undefined> {
  const key = sha256(`${CODEX_MODEL}\n${prompt}`);
  for (const dir of [join(CENTRAL, "cache", "codex"), join(OUT_DIR, "central", "cache", "codex")]) {
    const p = join(dir, key.slice(0, 2), `${key}.json`);
    if (existsSync(p)) {
      const v = parse(readJson<{ text: string }>(p).text);
      if (v !== undefined) {
        calls.cached++;
        return v;
      }
    }
  }
  if (!allowCall) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    calls.made++;
    const r = await runCodex(prompt, CODEX_MODEL);
    if (r.usage) {
      const u = { input_tokens: r.usage.input_tokens, cached_input_tokens: r.usage.cached_input_tokens, output_tokens: r.usage.output_tokens, reasoning_tokens: null };
      logUsageLine(join(OUT_DIR, "usage.jsonl"), { step: `holdout:${step}`, provider: "codex", model: CODEX_MODEL, ...u, dollars: dollars(price, u), prompt_chars: prompt.length, cost_source: "list price (harness included); the plan is billed, not this" });
    }
    const v = r.code === 0 ? parse(r.text) : undefined;
    if (v !== undefined) {
      const p = join(OUT_DIR, "central", "cache", "codex", key.slice(0, 2), `${key}.json`);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, JSON.stringify({ model: CODEX_MODEL, text: r.text, usage: r.usage }) + "\n");
      return v;
    }
  }
  calls.failed++;
  return undefined;
}
const records = (text: string) => {
  const v = parseJson(text, "array");
  return Array.isArray(v) ? v.flatMap((r) => { const p = Extracted.safeParse(r); return p.success ? [p.data] : []; }) : undefined;
};
const labelObject = (text: string) => {
  const v = parseJson(text, "object");
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
};

/** extract.ts extractRelease, call for call; `complete` is false when any chunk's call had no answer. */
async function extractNote(t: Technology, rel: Note, allowCall: boolean): Promise<{ incoming: Incoming[]; complete: boolean; failed: number; extracted: boolean; labelMissing: number }> {
  const parts = chunk(rel.notes);
  const out: Incoming[] = [];
  let complete = true;
  let extracted = true;
  let labelMissing = 0;
  let failed = 0;
  await Promise.all(
    parts.map(async (notes, ci) => {
      if (!notes.trim()) return;
      const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      const recs = await codex(fill(EXTRACT_PROMPT, { TECH: t.name, VERSION: rel.version, DATE: rel.date, PART: part, NOTES: notes }), records, "extract", allowCall);
      if (!recs) return void ((complete = false), (extracted = false), failed++);
      if (!recs.length) return;
      const brief = recs.map((r, i) => ({ id: `r${i + 1}`, subject: r.subject, facet: r.facet ?? null, change_type: r.change_type ?? null, summary: r.summary, introduces: strings(r.introduces, 20), evidence: r.evidence ?? "" }));
      const labels = await codex(fill(LABEL_PROMPT, { TECH: t.name, VERSION: rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes }), labelObject, "label", allowCall);
      // As the pipeline: a failed label call still yields the records, with empty labels.
      if (!labels) ((complete = false), labelMissing++, failed++);
      const relNote = { technology: t.id, tag: rel.version, version: rel.version, date: rel.date, url: rel.url, snapshot: rel.snapshot, notes: rel.notes };
      recs.forEach((r, i) => out.push(toIncoming(t, relNote, ci, i, r, labels?.[`r${i + 1}`], notes)));
    }),
  );
  out.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return { incoming: out, complete, failed, extracted, labelMissing };
}

// ---- Phases ----

const phase = process.argv[2];
const T = techs();

if (phase === "notes") {
  const rows = T.flatMap((x) => notesOf(x).map((n) => ({ tech: x.t.id, name: x.t.name, ecosystem: x.ecosystem, version: n.version, date: n.date, chars: n.notes.length, cell: cellOf(n.notes) })));
  writeJson(join(OUT, "all-notes.json"), rows);
  for (const x of T) {
    const mine = rows.filter((r) => r.tech === x.t.id);
    const c = Object.fromEntries(CELLS.map((k) => [k, mine.filter((r) => r.cell === k).length]));
    console.log(x.t.id, x.t.name, x.ecosystem, x.style, mine.length, "notes", JSON.stringify(c));
  }
}

if (phase === "feasibility") {
  for (const x of T.filter((x) => x.ecosystem === "npm")) {
    const ns = notesOf(x);
    const store = readJson<{ records: Record<string, { status: string; sources: string[] }> }>(join(CENTRAL, "records", `${x.t.id}.json`));
    const ingested = new Set(Object.values(store.records).flatMap((r) => r.sources).filter((k) => !k.includes("+")).map((k) => k.slice(k.indexOf("@") + 1, k.indexOf("#"))));
    let ok = 0, extracted = 0, labelMissing = 0, n = 0;
    for (const note of ns.filter((m) => ingested.has(m.version))) {
      const r = await extractNote(x.t, note, false);
      n++;
      if (r.complete) ok++;
      if (r.extracted) extracted++;
      labelMissing += r.labelMissing;
    }
    console.log(x.t.id, `${ns.length} release files, ${n} ingested by the store; extraction answered for ${extracted}/${n}, both calls for ${ok}/${n}; ${labelMissing} label calls unanswered`);
  }
}

if (phase === "extraction") {
  const manifest: unknown[] = [];
  const natural: Record<string, Record<string, number>> = {};
  for (const x of T) {
    const ns = notesOf(x).filter((n) => n.notes.replace(/\s/g, "").length >= 50);
    const by = new Map<string, Note[]>(CELLS.map((c) => [c, []]));
    for (const n of ns) by.get(cellOf(n.notes))!.push(n);
    for (const c of CELLS) by.get(c)!.sort((a, b) => H("note", `${a.tech}@${a.version}`).localeCompare(H("note", `${b.tech}@${b.version}`)));
    natural[x.t.id] = Object.fromEntries(CELLS.map((c) => [c, by.get(c)!.length]));
    const picked: Array<{ n: Note; cell: string }> = [];
    while (picked.length < 10 && CELLS.some((c) => by.get(c)!.length)) {
      for (const c of CELLS) {
        if (picked.length >= 10) break;
        const n = by.get(c)!.shift();
        if (n) picked.push({ n, cell: c });
      }
    }
    for (const { n, cell } of picked) {
      const file = `${x.t.id}@${n.version}.md`;
      writeFileSync(join(HERE, "extraction", "notes", file), n.notes);
      manifest.push({ note_file: file, technology: x.t.id, name: x.t.name, ecosystem: x.ecosystem, tech_style: x.style, version: n.version, date: n.date, url: n.url, snapshot: n.snapshot, chars: n.notes.length, length: cell.split("-")[0], structure: cell.split("-")[1] });
    }
  }
  writeJson(join(HERE, "extraction", "notes.json"), { seed: SEED, natural_cells: natural, notes: manifest });
  console.log(JSON.stringify(natural, null, 1));
  const m = manifest as Array<{ technology: string; length: string; structure: string }>;
  for (const x of T) console.log(x.t.id, JSON.stringify(Object.fromEntries(CELLS.map((c) => [c, m.filter((r) => r.technology === x.t.id && `${r.length}-${r.structure}` === c).length]))));
}

if (phase === "extract-pypi") {
  for (const x of T.filter((x) => x.ecosystem === "pypi")) {
    const ns = notesOf(x);
    const res = await pool(ns, 3, (n) => extractNote(x.t, n, true));
    const incoming = res.flatMap((r) => r.incoming);
    writeJson(join(OUT, "pypi", x.t.id, "incoming.json"), incoming);
    writeJson(join(OUT, "pypi", x.t.id, "status.json"), ns.map((n, i) => ({ version: n.version, complete: res[i]!.complete, failed: res[i]!.failed, records: res[i]!.incoming.length })));
    console.log(x.t.id, `${ns.length} notes, ${incoming.length} incoming records, ${res.filter((r) => !r.complete).length} notes with a failed call`);
  }
  console.log("codex", JSON.stringify(calls));
}

if (phase === "classify") {
  const O = new Set(["removal", "deprecation", "behavior_change", "default_change"]);
  const out: unknown[] = [];
  const report: Record<string, unknown> = {};
  const classifierCache = join(CENTRAL, "cache", "classifier");
  const q = (await import("../../../central/src/pipeline/classify/labels.ts")).labelQuestions();
  for (const x of T) {
    let units: Array<{ id: string; key: string; inc: Incoming }> = [];
    let missing = 0;
    if (x.ecosystem === "npm") {
      const byKey = new Map<string, Incoming>();
      for (const n of notesOf(x)) for (const i of (await extractNote(x.t, n, false)).incoming) byKey.set(i.key, i);
      const store = readJson<{ records: Record<string, { id: string; status: string; sources: string[]; history?: Array<{ action: string; detail?: string }> }> }>(join(CENTRAL, "records", `${x.t.id}.json`));
      for (const r of Object.values(store.records)) {
        if (r.status !== "active") continue;
        const created = r.history?.find((h) => h.action === "created")?.detail ?? r.sources[0]!;
        if (!created || created.includes("+") || !created.includes("@")) continue;
        const inc = byKey.get(created);
        if (!inc) {
          missing++;
          continue;
        }
        units.push({ id: r.id, key: created, inc });
      }
    } else {
      if (!existsSync(join(OUT, "pypi", x.t.id, "incoming.json"))) {
        console.log(x.t.id, "no PyPI extraction yet; skipped");
        continue;
      }
      units = readJson<Incoming[]>(join(OUT, "pypi", x.t.id, "incoming.json")).map((inc) => ({ id: inc.key, key: inc.key, inc }));
    }
    const n = x.ecosystem === "npm" ? 80 : 40;
    const isO = (u: (typeof units)[number]) => O.has(u.inc.hint_change_type ?? "");
    const order = (us: typeof units) => [...us].sort((a, b) => H("rec", a.id).localeCompare(H("rec", b.id)));
    const oAll = order(units.filter(isO));
    const rAll = order(units.filter((u) => !isO(u)));
    const natural = oAll.length / units.length;
    const nO = Math.min(oAll.length, Math.max(Math.round(0.4 * n), Math.round(natural * n)));
    const seen = new Set<string>();
    const take = (us: typeof units, k: number) => {
      const got: typeof units = [];
      for (const u of us) {
        if (got.length >= k) break;
        const s = JSON.stringify(recordState(x.t.name, u.inc));
        if (seen.has(s)) continue;
        seen.add(s);
        got.push(u);
      }
      return got;
    };
    const pickO = take(oAll, nO);
    const pickR = take(rAll, n - pickO.length);
    const hints: Record<string, number> = {};
    for (const u of units) hints[u.inc.hint_change_type ?? "(none)"] = (hints[u.inc.hint_change_type ?? "(none)"] ?? 0) + 1;
    let faithful = 0;
    for (const [stratum, us] of [["O", pickO], ["R", pickR]] as const)
      for (const u of us) {
        const state = recordState(x.t.name, u.inc);
        const f = x.ecosystem === "npm" ? !!S.cached(classifierCache, state, q) : false;
        if (f) faithful++;
        out.push({ id: u.id, technology: x.t.id, name: x.t.name, ecosystem: x.ecosystem, source_key: u.key, stratum, state, faithful: x.ecosystem === "npm" ? f : null });
      }
    report[x.t.id] = { units: units.length, unreconstructable: missing, natural_O: +natural.toFixed(3), sampled_O: pickO.length, sampled_R: pickR.length, faithful_npm: x.ecosystem === "npm" ? faithful : null, hint_counts: hints };
    console.log(x.t.id, JSON.stringify(report[x.t.id]));
  }
  writeJson(join(HERE, "classify", "records.json"), { seed: SEED, strata: { O: [...O], R: "every other hint, or none" }, report, records: out });
}
