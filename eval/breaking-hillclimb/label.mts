// Labels the held-out or dev set with one breaking-question variant, through the central classifier adapter (Jev, no
// fallback, cached by request hash, usage logged to $UNSTALE_CENTRAL_DIR/usage.jsonl). The `luna` mode (OpenAI
// Decisions) was removed with that adapter (user rule: Luna only through Codex); its labels stay in the scratch cache,
// and Luna is now labelled through codex_label.py.
// `dump` writes the units (state + question) for the Codex runner; `cached` reads the catalog's own labels for the dev
// extractions from the pipeline's classifier cache (no call).
//
//   cd ~/unstale/central && HC=<scratch>/hillclimb UNSTALE_CENTRAL_DIR=$HC/central \
//     npx tsx ../eval/breaking-hillclimb/label.mts heldout|dev P0|P1|P2|P3|P4 jev|dump|cached
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClassifierCache, ClassifierError, Jev, usageStats, type Classifier, type Questions } from "../../central/src/pipeline/classify/adapter.ts";
import { interpret, labelQuestions, recordState } from "../../central/src/pipeline/classify/labels.ts";
import type { Incoming } from "../../central/src/pipeline/extract.ts";
import { TECHNOLOGIES } from "../../central/src/pipeline/technologies.ts";
import { BREAKING_P } from "../../central/src/pipeline/thresholds.ts";
import { pool } from "../../central/src/pipeline/util.ts";
import { question, type Variant } from "./prompts.ts";

const HC = process.env.HC;
if (!HC) throw new Error("set HC to the scratch hill-climb dir");
const STORE = process.env.HC_STORE ?? join(HC, "store-base");
const HELDOUT = join(homedir(), "ati-slice2", "results", "datamodel", "breaking", "items.json");
const NAMES: Record<string, string> = { laravel: "Laravel", next: "Next.js", prisma: "Prisma", nestjs: "NestJS" };

export interface Unit {
  id: string;
  tech: string;
  state: Record<string, unknown>;
}

function heldoutUnits(v: Variant): Unit[] {
  const items = JSON.parse(readFileSync(HELDOUT, "utf8")) as Array<Record<string, string | boolean | null>>;
  return items.map((i) => {
    const state: Record<string, unknown> = {
      technology: NAMES[i.tech as string],
      source: i.kind === "guide" ? "upgrade guide" : "release notes",
      release: i.release,
      subject: i.key,
      summary: i.summary,
      evidence: i.evidence,
    };
    if (v === "P3" || v === "P4") {
      state.change_type = i.change_type;
      if (i.context) state.guide_section = i.context;
    }
    return { id: i.rid as string, tech: i.tech as string, state };
  });
}

type Manifest = Record<string, { tech: string; records: Record<string, { rid: string; breaking: boolean; sources: string[] }> }>;

function incomingOf(tech: string, key: string): Incoming {
  const version = key.slice(key.indexOf("@") + 1, key.indexOf("#"));
  const all = JSON.parse(readFileSync(join(STORE, "central", "extractions", tech, `${version}.json`), "utf8")) as Incoming[];
  const inc = all.find((x) => x.key === key);
  if (!inc) throw new Error(`no extraction ${key}`);
  return inc;
}

function devUnits(v: Variant): Unit[] {
  const man = JSON.parse(readFileSync(join(HC!, "dev_manifest.json"), "utf8")) as Manifest;
  const out: Unit[] = [];
  for (const ev of Object.values(man)) {
    const name = TECHNOLOGIES[ev.tech]!.name;
    if (v === "P3" || v === "P4") {
      const store = JSON.parse(readFileSync(join(STORE, "central", "records", `${ev.tech}.json`), "utf8")) as {
        records: Record<string, Record<string, any>>;
      };
      for (const rec of Object.values(ev.records)) {
        const r = store.records[rec.rid]!;
        out.push({
          id: rec.rid,
          tech: ev.tech,
          state: {
            technology: name,
            source: "release notes",
            releases: (r.releases as Array<{ version: string; date?: string }>).map((x) => ({ version: x.version, date: x.date })),
            subject: r.subject,
            ...(r.facet ? { facet: r.facet } : {}),
            summary: r.summary,
            change_type: r.change_type,
            surface: r.surface,
            evidence: (r.evidence as Array<{ kind: string; quote: string }>).map((e) => ({ kind: e.kind, quote: e.quote })),
            introduces: r.introduces,
            replaces: r.replaces,
            terms: r.terms,
            requires: r.requires,
            prerequisites: r.prerequisites,
            conditions: r.conditions,
          },
        });
      }
    } else {
      for (const rec of Object.values(ev.records))
        for (const s of rec.sources) out.push({ id: s, tech: ev.tech, state: recordState(name, incomingOf(ev.tech, s)) });
    }
  }
  return out;
}

const [set, variant, mode] = process.argv.slice(2) as ["heldout" | "dev", Variant, string];
const units = set === "heldout" ? heldoutUnits(variant) : devUnits(variant);
const outFile = join(HC, "labels", `${set}_${variant}_${mode}.json`);

if (mode === "dump") {
  writeFileSync(join(HC, "codex", `units_${set}_${variant}.json`), JSON.stringify({ question: question(variant), units }, null, 1) + "\n");
  console.log(`dumped ${units.length} units`);
} else if (mode === "cached") {
  if (set !== "dev" || variant !== "P0") throw new Error("cached: dev P0 only");
  const cache = new ClassifierCache(join(homedir(), "unstale", ".store", "central", "cache", "classifier"));
  const qs = labelQuestions();
  const jev = new Jev();
  const out: Record<string, { choice: string; p: number; classifier: string }> = {};
  for (const u of units) {
    const c = cache.get(jev, u.state, qs);
    if (!c) throw new Error(`no cached catalog label for ${u.id}`);
    const lab = interpret(c);
    out[u.id] = { choice: lab.breaking ? "yes" : "no", p: lab.classifier.breaking, classifier: c.classifier };
  }
  writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
  console.log(`cached labels for ${units.length} units`);
} else {
  const cls: Classifier = mode === "jev" ? new Jev() : (() => { throw new Error(mode); })();
  const cache = new ClassifierCache(join(HC, "cache", "classifier"));
  const qs: Questions = { breaking: question(variant) };
  const out: Record<string, { choice: string; p: number }> = {};
  let hits = 0;
  const errors: string[] = [];
  await pool(units, mode === "jev" ? 6 : 4, async (u) => {
    let c = cache.get(cls, u.state, qs);
    if (c) hits++;
    else {
      try {
        c = await cls.classify(u.state, qs);
        cache.put(cls, u.state, qs, c);
      } catch (e) {
        if (!(e instanceof ClassifierError)) throw e;
        errors.push(`${u.id}: ${e.kind}: ${e.message}`);
        return;
      }
    }
    const p = c.answers.breaking!.probabilities.yes!;
    out[u.id] = { choice: p >= BREAKING_P ? "yes" : "no", p };
  });
  writeFileSync(outFile, JSON.stringify(Object.fromEntries(units.filter((u) => out[u.id]).map((u) => [u.id, out[u.id]])), null, 1) + "\n");
  console.log(JSON.stringify({ set, variant, mode, units: units.length, labelled: Object.keys(out).length, cache_hits: hits, uncached_calls: usageStats, errors: errors.slice(0, 5), n_errors: errors.length }));
}
