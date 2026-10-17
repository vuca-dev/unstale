// Draws and publishes the rarity-sample variants pre-registered in RESULTS.md, into side stores only.
//
//   UNSTALE_CENTRAL_DIR=<side store> UNSTALE_BIN=<unstale> npx tsx variants.mts draw <variant>...      (GitHub reads, cached in the side store)
//   UNSTALE_CENTRAL_DIR=<side store> UNSTALE_BIN=<unstale> npx tsx variants.mts publish <out-root> <variant>...
//
// `draw` writes samples/<variant>/<tech>.json (repositories, no counts). `publish` counts every active term in each
// sample repository once (per repository, by the edge's matcher; matrix cached in the side store) and publishes a
// catalog per variant to <out-root>/cat-<variant> with publishTechnology; `fallback` publishes with no sample.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import { activeTerms, publishTechnology } from "../../central/src/pipeline/publish.ts";
import { buildSample, cloneAt, cloneDir, edgeCounter, type SampleFile, type SampleRule } from "../../central/src/pipeline/sample.ts";
import { loadStore } from "../../central/src/pipeline/store.ts";
import { TECHNOLOGIES } from "../../central/src/pipeline/technologies.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TECHS = ["next", "prisma", "nestjs"];
const DRAWN = new Date("2026-10-15T17:00:00Z");

export const VARIANTS: Record<string, SampleRule> = {
  R0: { pool: "code-search", major: "current", n: 5 },
  R1: { pool: "code-search", major: "previous", n: 5 },
  R2: { pool: "adoption", major: "current", n: 5 },
  R3: { pool: "adoption", major: "previous", n: 5 },
  R4: { pool: "adoption", major: "mix", n: 5 },
  R5: { pool: "code-search", major: "mix", n: 5 },
};
// Stage 2: <stage-1 id>-n<k>.
function rule(v: string): SampleRule {
  const m = /^(R\d)(?:-n(\d+))?$/.exec(v);
  if (!m || !VARIANTS[m[1]!]) throw new Error(`unknown variant ${v}`);
  return { ...VARIANTS[m[1]!]!, ...(m[2] ? { n: Number(m[2]) } : {}) };
}
const samplePath = (v: string, tech: string) => join(HERE, "samples", v, `${tech}.json`);

async function draw(vs: string[]): Promise<void> {
  for (const v of vs)
    for (const tech of TECHS) {
      const s = await buildSample(TECHNOLOGIES[tech]!, loadStore(tech), rule(v), (x) => console.error(`${v} ${x}`), DRAWN);
      if (!s) throw new Error(`${tech}: no current major`);
      mkdirSync(dirname(samplePath(v, tech)), { recursive: true });
      writeFileSync(samplePath(v, tech), JSON.stringify(s, null, 1) + "\n");
      console.log(`${v} ${tech}: ${s.repos.length} repos (${s.majors?.join("+")}), ${s.candidates} candidates: ${s.repos.map((r) => `${r.repo}(${r.stars})`).join(", ")}`);
    }
}

/** term → 0/1 for one repository at its commit, cached. */
function repoCounts(tech: string, repo: string, commit: string, terms: string[]): Record<string, number> {
  const p = join(centralDir(), "sample", tech, "matrix", `${repo.replace("/", "__")}@${commit}.json`);
  const have: Record<string, number> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const missing = terms.filter((t) => !Object.hasOwn(have, t));
  if (missing.length) {
    cloneAt(tech, repo, commit);
    const got = edgeCounter([cloneDir(tech, repo)], missing);
    for (const t of missing) have[t] = got[t] ? 1 : 0;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(have) + "\n");
  }
  return have;
}

function publish(outRoot: string, vs: string[]): void {
  for (const v of vs) {
    const out = join(outRoot, `cat-${v}`);
    for (const tech of TECHS) {
      const store = loadStore(tech);
      const checked = JSON.parse(readFileSync(join(centralDir(), "releases", tech, "index.json"), "utf8")).checked as string;
      if (v === "fallback") {
        publishTechnology(store, checked, out);
        continue;
      }
      const s = JSON.parse(readFileSync(samplePath(v, tech), "utf8")) as SampleFile;
      const terms = activeTerms(store);
      const counts: Record<string, number> = Object.fromEntries(terms.map((t) => [t, 0]));
      for (const r of s.repos) {
        const c = repoCounts(tech, r.repo, r.commit, terms);
        for (const t of terms) counts[t]! += c[t]!;
      }
      publishTechnology(store, checked, out, { n: s.repos.length, repos: s.repos, counts });
    }
    console.log(`published ${out}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "draw") await draw(rest);
else if (cmd === "publish") publish(rest[0]!, rest.slice(1));
else throw new Error("usage: variants.mts draw|publish ...");
