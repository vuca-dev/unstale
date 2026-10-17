// What per-ecosystem admission thresholds would admit from the D1 sample (central/src/pipeline/admission.ts), beside
// what each package's docs produced in the 90-day replay, so a floor can be set from data. HTTP only, no model calls.
//   cd central && npx tsx ../eval/docs-sources/admission.mts <out.json> [<replay.json>]
import { readFileSync, writeFileSync } from "node:fs";
import { admit, npmDownloads, signals, THRESHOLDS, type Signals, type Thresholds } from "../../central/src/pipeline/admission.ts";
import { pool } from "../../central/src/pipeline/util.ts";

const [out, replayPath] = process.argv.slice(2);
const rows: any[] = [];
for (const f of ["stage1-results.json", "stage2-results.json", "stage3-results.json"]) rows.push(...JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")));
const replay = replayPath ? JSON.parse(readFileSync(replayPath, "utf8")) : undefined;
const versioned = new Map<string, number>();
for (const s of replay?.sections ?? []) {
  if (s.attribution.by !== "marker" && s.attribution.by !== "guide") continue;
  const r = replay.results.find((x: any) => x.id === s.target);
  for (const p of r?.purls ?? []) versioned.set(p, (versioned.get(p) ?? 0) + 1);
}
const npmName = (p: string) => decodeURIComponent(p.replace(/^pkg:npm\//, ""));
const dl = await npmDownloads(rows.filter((r) => r.purl.startsWith("pkg:npm/")).map((r) => npmName(r.purl)));
const sigs: Signals[] = await pool(rows, 3, (r) => signals(r.purl, r.evidence?.pkgRepo?.full ?? (String(r.answer?.repo ?? "").split(" ")[0] || undefined), { downloads: r.purl.startsWith("pkg:npm/") ? dl.get(npmName(r.purl)) : undefined }));
const eco = (p: string) => /^pkg:(\w+)\//.exec(p)?.[1] ?? "";
const variants: Record<string, (e: string) => Thresholds> = {
  default: (e) => THRESHOLDS[e]!,
  strict: (e) => ({ ...THRESHOLDS[e]!, minDownloads: THRESHOLDS[e]!.minDownloads * 10, minStars: 1000 }),
  lenient: (e) => ({ ...THRESHOLDS[e]!, freshDays: 730, minDownloads: THRESHOLDS[e]!.minDownloads / 10, minStars: 20 }),
};
const result = sigs.map((s, i) => ({ ...s, answer: rows[i].answer?.kind, versioned: versioned.get(s.purl) ?? 0, verdicts: Object.fromEntries(Object.entries(variants).map(([k, f]) => [k, admit(s, f(eco(s.purl)))])) }));
for (const k of Object.keys(variants)) {
  const a = result.filter((r) => r.verdicts[k].admit);
  const lost = result.filter((r) => !r.verdicts[k].admit && r.versioned);
  console.error(`${k}: admits ${a.length} of ${result.length}; rejects ${result.length - a.length}; packages with versioned docs changes rejected: ${lost.length}${lost.length ? ` (${lost.map((r) => r.purl).join(", ")})` : ""}`);
}
for (const r of result.filter((r) => !r.verdicts.default.admit)) console.error(`  rejected by default: ${r.purl} — ${r.verdicts.default.why} (downloads ${r.downloads ?? "?"}, stars ${r.stars ?? "?"}, release ${r.lastRelease?.slice(0, 10) ?? "?"}, commit ${r.lastCommit?.slice(0, 10) ?? "?"})`);
const unread = result.filter((r) => r.downloads === undefined).length;
console.error(`downloads unreadable for ${unread}; stars unreadable for ${result.filter((r) => r.stars === undefined).length}; no release date for ${result.filter((r) => !r.lastRelease).length}`);
writeFileSync(out ?? "admission-results.json", JSON.stringify({ at: new Date().toISOString(), thresholds: THRESHOLDS, result }, null, 1) + "\n");
