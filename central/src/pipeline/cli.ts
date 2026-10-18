// The central pipeline's command line.
//
//   npm run pipeline -- [--tech next] [--limit 3] [--refresh] [--offline] [--no-guides] [--no-docs] [--no-publish] [--sample] [--no-budget]
// (--sample: draw a rarity sample for a technology that has none, off by default; an existing sample still counts;
// --no-sample is accepted and is the default;
//      --offline: use the stored release lists whatever their age; --no-docs: no docs pass and no docs section notes)
//   npm run catalog -- show <id>
//   npm run catalog -- correct <id> <field>=<value>... [--claim] [--note text] [--no-publish]
//   npm run catalog -- merge <from-id> <into-id> [--note text] [--no-publish]
//   npm run catalog -- retract <id> [--note text] [--no-publish]
//   npm run catalog -- publish [--tech next]
//   npm run catalog -- check-prerequisites [--tech next] [--no-publish]   (npm registry check of a store built before it)
//   npm run catalog -- advisories [--tech next] [--offline] [--no-publish]   (the advisories stage: OSV, resolve, attach)
//   npm run catalog -- prune [--dry-run]   (delete shards unreferenced for more than 7 days; prune.ts)
//   npm run catalog -- export <dir>   (prune, then the static tree for GitHub Pages or any static host; export.ts)
//
// Corrections: revision fields (change_type, breaking, releases, prerequisites, requires, replaces, or --claim for a
// meaningful correction of the claim) bump `revision`; label fields bump `label_version`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { advisoryStage, advisoryStats } from "./advisories.ts";
import { extractModel, llmStats } from "./llm.ts";
import { PipelineBudget } from "./budget.ts";
import { fetchReleases } from "./fetch.ts";
import { usageStats } from "./classify/adapter.ts";
import { withTechLock, withTechLockSync } from "./lock.ts";
import { catalogDir, centralDir } from "./paths.ts";
import { makeClassifier, runTechnology, technologies, type TechReport } from "./pipeline.ts";
import { exportCatalog } from "./export.ts";
import { pruneCatalog } from "./prune.ts";
import { activeTerms, publishTechnology, shardLine } from "./publish.ts";
import { sampleCounts } from "./sample.ts";
import { checkStore } from "./prereqs.ts";
import { registryStats } from "./registry.ts";
import { ShardLine } from "../schema/catalog.ts";
import { applyChange, LABEL_FIELDS, loadStore, mergeInto, retract, REVISION_FIELDS, saveStore, type EditableField, type StoredRecord } from "./store.ts";
import { TECHNOLOGIES } from "./technologies.ts";
import { readJson } from "./util.ts";
import { techLocal } from "../state/client.ts";

const ARRAY_FIELDS = new Set(["releases", "prerequisites", "requires", "replaces", "benefit", "introduces", "terms", "related", "conditions"]);

function parseValue(field: string, raw: string): unknown {
  if (field === "breaking") {
    if (raw !== "true" && raw !== "false") throw new Error("breaking=true|false");
    return raw === "true";
  }
  if (ARRAY_FIELDS.has(field)) {
    if (raw.trim().startsWith("[")) return JSON.parse(raw);
    return raw === "" ? [] : raw.split(",").map((s) => s.trim());
  }
  if ((field === "facet" || field === "supersedes") && raw === "") return undefined;
  return raw;
}

function checkedOf(tech: string): string {
  const idx = readJson<{ checked: string }>(join(centralDir(), "releases", techLocal(tech), "index.json"));
  return idx?.checked ?? new Date(0).toISOString();
}

function republish(tech: string): void {
  const store = loadStore(tech);
  const p = publishTechnology(store, checkedOf(tech), catalogDir(), sampleCounts(tech, activeTerms(store)));
  console.log(`published ${tech}: ${p.index.shards.length} shards, ${p.bytes} bytes`);
}

function techOf(id: string): string {
  const t = id.split(":")[0]!;
  if (!TECHNOLOGIES[t]) throw new Error(`no technology for id ${id}`);
  return t;
}

async function pipeline(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { tech: { type: "string" }, limit: { type: "string" }, refresh: { type: "boolean" }, "no-publish": { type: "boolean" }, "no-sample": { type: "boolean" }, sample: { type: "boolean" }, offline: { type: "boolean" }, "no-guides": { type: "boolean" }, "no-docs": { type: "boolean" }, "no-advisories": { type: "boolean" }, "no-budget": { type: "boolean" } },
  });
  const t0 = Date.now();
  const cls = makeClassifier();
  const opts = {
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    refresh: !!values.refresh,
    offline: !!values.offline,
    guides: !values["no-guides"],
    docs: !values["no-docs"],
    advisories: !values["no-advisories"],
    publish: !values["no-publish"],
    sample: !!values.sample && !values["no-sample"],
    // The coverage budget (budget.ts): notes that reach the extraction model are charged first; --no-budget for a
    // maintainer's deliberate rebuild.
    ...(values["no-budget"] ? {} : { budget: new PipelineBudget() }),
  };
  const list = technologies(values.tech);
  const reports: TechReport[] = await Promise.all(list.map((t) => runTechnology(t, opts, cls)));
  // Technologies past their quarterly cap go last: a second pass with the cap lifted, while the period budget lasts.
  const over = list.filter((_, i) => reports[i]!.deferred?.cap);
  if (over.length && opts.budget && opts.budget.tokensLeft() > 0) {
    console.log(`second pass, quarterly cap lifted: ${over.map((t) => t.id).join(", ")}`);
    const again = await Promise.all(over.map((t) => runTechnology(t, { ...opts, liftCap: true }, cls)));
    for (const r of again) reports[reports.findIndex((x) => x.technology === r.technology)] = r;
  }
  for (const r of reports) console.log(JSON.stringify(r));
  const summary = {
    wall_s: Math.round((Date.now() - t0) / 1000),
    extract_model: extractModel(),
    llm: llmStats,
    classifier_answers: cls.counts,
    classifier_cache_hits: cls.cacheHits(),
    classifier_fallbacks: cls.fallbacks,
    jev_disabled: cls.disabled,
    uncached_calls: usageStats,
    ...(opts.budget ? { budget_tokens_left: opts.budget.tokensLeft(), deferred: reports.reduce((n, r) => n + (r.deferred?.budget ?? 0) + (r.deferred?.cap ?? 0), 0) } : {}),
  };
  console.log(JSON.stringify(summary));
}

function show(id: string): void {
  const r = loadStore(techOf(id)).records[id];
  if (!r) throw new Error(`unknown record ${id}`);
  console.log(JSON.stringify(r, null, 1));
}

function correct(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { claim: { type: "boolean" }, note: { type: "string" }, "no-publish": { type: "boolean" } },
  });
  const [id, ...sets] = positionals;
  if (!id || (!sets.length && !values.claim)) throw new Error("correct <id> <field>=<value>... [--claim]");
  const tech = techOf(id);
  withTechLockSync(tech, "correct", () => {
    const s = loadStore(tech);
    const r = s.records[id];
    if (!r || r.status !== "active") throw new Error(`no active record ${id}`);
    const changes: Partial<Pick<StoredRecord, EditableField>> = {};
    for (const kv of sets) {
      const i = kv.indexOf("=");
      const field = kv.slice(0, i);
      if (i < 0 || ![...REVISION_FIELDS, ...LABEL_FIELDS].includes(field as EditableField)) {
        throw new Error(`not a correctable field: ${kv}; fields: ${[...REVISION_FIELDS, ...LABEL_FIELDS].join(", ")}`);
      }
      (changes as Record<string, unknown>)[field] = parseValue(field, kv.slice(i + 1));
    }
    const before = { revision: r.revision, label_version: r.label_version };
    applyChange(r, changes, "correction", { claim: !!values.claim, detail: values.note ?? "manual correction" });
    // The corrected record must still be a valid published line (generated Zod) before it is saved.
    const check = ShardLine.safeParse(JSON.parse(JSON.stringify(shardLine(r, false))));
    if (!check.success) throw new Error(`correction rejected: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    saveStore(s);
    console.log(`${id}: revision ${before.revision} → ${r.revision}, label_version ${before.label_version} → ${r.label_version}`);
    if (!values["no-publish"]) republish(tech);
  });
}

function merge(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { note: { type: "string" }, "no-publish": { type: "boolean" } } });
  const [from, into] = positionals;
  if (!from || !into) throw new Error("merge <from-id> <into-id>");
  const tech = techOf(from);
  if (techOf(into) !== tech) throw new Error("records of different technologies cannot merge");
  withTechLockSync(tech, "merge", () => {
    const s = loadStore(tech);
    mergeInto(s, from, into, values.note ?? "manual merge");
    saveStore(s);
    const t = s.records[into]!;
    console.log(`${from} merged into ${into} (revision ${t.revision}, label_version ${t.label_version})`);
    if (!values["no-publish"]) republish(tech);
  });
}

function retractCmd(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { note: { type: "string" }, "no-publish": { type: "boolean" } } });
  const [id] = positionals;
  if (!id) throw new Error("retract <id>");
  const tech = techOf(id);
  withTechLockSync(tech, "retract", () => {
    const s = loadStore(tech);
    retract(s, id, values.note ?? "manual retraction");
    saveStore(s);
    console.log(`${id} retracted`);
    if (!values["no-publish"]) republish(tech);
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "pipeline":
      return pipeline(rest);
    case "show":
      return show(rest[0] ?? "");
    case "correct":
      return correct(rest);
    case "merge":
      return merge(rest);
    case "retract":
      return retractCmd(rest);
    case "check-prerequisites": {
      const { values } = parseArgs({ args: rest, options: { tech: { type: "string" }, "no-publish": { type: "boolean" } } });
      for (const t of technologies(values.tech)) await withTechLock(t.id, "check-prerequisites", async () => {
        const s = loadStore(t.id);
        const r = await checkStore(s);
        saveStore(s);
        console.log(JSON.stringify({ technology: t.id, records: r.records, names: r.names.length, missing: r.missing, revisionBumps: r.revisionBumps }));
        if (!values["no-publish"]) republish(t.id);
      });
      console.log(JSON.stringify({ registry: registryStats }));
      return;
    }
    case "advisories": {
      // The advisories stage alone on an existing store (the pipeline and the onboarding service run it after ingest).
      const { values } = parseArgs({ args: rest, options: { tech: { type: "string" }, offline: { type: "boolean" }, refresh: { type: "boolean" }, "no-publish": { type: "boolean" } } });
      const cls = makeClassifier();
      for (const t of technologies(values.tech)) await withTechLock(t.id, "advisories", async () => {
        const fetched = await fetchReleases(t, { offline: true });
        const s = loadStore(t.id);
        const r = await advisoryStage(t, s, fetched.notes, (st, q) => cls.classify(st, q), { offline: !!values.offline, refresh: !!values.refresh });
        saveStore(s);
        console.log(JSON.stringify({ technology: t.id, ...r }));
        if (!values["no-publish"]) republish(t.id);
      });
      console.log(JSON.stringify({ classifier: cls.counts, uncached_calls: usageStats, network: advisoryStats }));
      return;
    }
    case "publish": {
      const { values } = parseArgs({ args: rest, options: { tech: { type: "string" } } });
      for (const t of technologies(values.tech)) withTechLockSync(t.id, "publish", () => republish(t.id));
      return;
    }
    case "prune": {
      const { values } = parseArgs({ args: rest, options: { "dry-run": { type: "boolean" } } });
      const r = pruneCatalog(catalogDir(), { dryRun: !!values["dry-run"] });
      console.log(JSON.stringify({ dry_run: !!values["dry-run"], ...r }, null, 1));
      if (r.unreadable.length) process.exitCode = 1;
      return;
    }
    case "export": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      if (positionals.length !== 1) throw new Error("export <dir>");
      const r = exportCatalog(catalogDir(), positionals[0]!);
      const { deleted, started, kept, unreadable } = r.prune;
      if (!r.signed) console.error("export: UNSTALE_SIGNING_KEY is not set; the catalog is unsigned, and release clients refuse it over HTTP");
      console.log(JSON.stringify({ signed: r.signed, technologies: r.technologies, shards: r.shards, linked: r.linked, bytes: r.bytes, coverage: r.coverage, pruned: deleted, clock_started: started.length, in_grace: kept.length, unreadable }));
      return;
    }
    case "usage": {
      // The current UTC month: the state save moves earlier months to central/archive (state/snapshot.ts).
      const lines = readFileSync(join(centralDir(), "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const by: Record<string, { calls: number; input_tokens: number; output_tokens: number }> = {};
      for (const l of lines) {
        if (typeof l.api !== "string") continue;
        const b = (by[l.api] ??= { calls: 0, input_tokens: 0, output_tokens: 0 });
        b.calls++;
        b.input_tokens += Number(l.input_tokens ?? 0);
        b.output_tokens += Number(l.output_tokens ?? 0);
      }
      console.log(JSON.stringify({ ...by, events: lines.filter((l) => l.event).map((l) => l.event) }, null, 1));
      return;
    }
    default:
      console.error("commands: pipeline, show, correct, merge, retract, publish, check-prerequisites, advisories, prune, export, usage");
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
