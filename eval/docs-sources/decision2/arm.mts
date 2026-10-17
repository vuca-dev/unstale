// One arm of the decision 2 test: the versioned Next.js sections of a replay (replay.mts) as extraction notes,
// synthesized into the store that UNSTALE_CENTRAL_DIR names (a clone; arms.sh makes one per arm). Dry run unless --run.
//   cd central && npx tsx ../eval/docs-sources/decision2/arm.mts <replay.json> --context=3|block [--words] [--kind=docs|guide] [--run]
// --kind=guide labels guide sections as upgrade-guide evidence (option E); markers stay docs notes.
import { readFileSync } from "node:fs";
import { compact, renderChange } from "../../../central/src/docs/render.ts";
import { TECHNOLOGIES } from "../../../central/src/pipeline/technologies.ts";
import { sha256 } from "../../../central/src/pipeline/util.ts";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const context = arg("context") ?? "3";
const words = process.argv.includes("--words");
const kind = arg("kind") ?? "docs";
const d = JSON.parse(readFileSync(file!, "utf8"));
const secs = d.sections.filter((s: any) => s.target.startsWith("vercel/next.js") && (s.attribution.by === "marker" || s.attribution.by === "guide") && s.noise === "substantive");
const page = (f: string) => "https://nextjs.org/" + f.replace(/\.mdx?$/, "").split("/").map((x: string) => x.replace(/^\d+[-_.](?=\D)/, "")).join("/").replace(/\/index$/, "");
const groups = new Map<string, any[]>();
for (const s of secs) {
  const k = `${s.date} ${s.file} ${s.attribution.version}`;
  groups.set(k, [...(groups.get(k) ?? []), s]);
}
const body = (s: any) => (context === "block" ? s.blockw : words ? compact(s.hunks) : s.hunks);
const notes = [...groups].map(([k, g]) => {
  const url = page(g[0].file);
  const key = sha256(k).slice(0, 8);
  const guide = kind === "guide" && g[0].attribution.by === "guide";
  const text = renderChange(url, g[0].kind, g.map((s: any) => ({ path: s.path, status: s.status, hunks: body(s), added: 0, removed: 0 })), { words: words || context === "block" });
  const base = { technology: "next", version: g[0].attribution.version, date: g[0].date, url, snapshot: `sha256:${sha256(text)}`, notes: text };
  return guide
    ? { ...base, kind: "upgrade_guide" as const, tag: `guide-${g[0].attribution.version.split(".")[0]}`, keyTag: `+guide.sec.${key}` }
    : { ...base, kind: "docs" as const, tag: `docs-${key}`, keyTag: `+docs.${key}` };
});
console.error(`context ${context}, words ${words || context === "block"}, kind ${kind}: ${secs.length} sections, ${notes.length} notes, ${notes.reduce((n, x) => n + x.notes.length, 0)} chars`);
if (process.argv.includes("--run")) {
  const { synthesize } = await import("../../../central/src/onboarding/synthesis.ts");
  for (const n of notes) {
    try {
      await synthesize(TECHNOLOGIES.next!, n);
    } catch (e) {
      console.error(`${n.url}: ${(e as Error).message}`);
    }
  }
  console.error("done");
}
