// Measures, read-only, how much of a published catalog's change events central has marked as processed (`extracted`),
// and the share of in-window releases a client would still derive on its own tokens: a release with an event that is
// neither marked nor named by any record's releases. Reads a catalog directory or its public address; writes nothing.
//
//   npx tsx scripts/extracted-share.ts <catalog dir or https://…> [--sample N] [--since YYYY-MM-DD] [tech …]
//
// Without technologies it reads the catalog's list (`v1/technologies.json`), the first N by id with `--sample`.
// Prints one JSON line.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const base = args.shift();
if (!base) throw new Error("usage: extracted-share.ts <catalog dir or https://…> [--sample N] [--since YYYY-MM-DD] [tech …]");
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const sample = Number(opt("--sample") ?? 0);
const since = opt("--since") ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

async function read(rel: string): Promise<Buffer | undefined> {
  if (/^https?:\/\//.test(base!)) {
    const res = await fetch(new URL(rel, base!.endsWith("/") ? base : `${base}/`), { headers: { "user-agent": "unstale-measure" } });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : undefined;
  }
  const p = join(base!, rel);
  return existsSync(p) ? readFileSync(p) : undefined;
}
const lines = (gz: Buffer | undefined): Array<Record<string, unknown>> =>
  gz ? gunzipSync(gz).toString().split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

interface Ref { path: string }
let techs = args;
if (!techs.length) {
  const list = JSON.parse((await read("v1/technologies.json"))?.toString() ?? "{}") as { technologies?: Record<string, string> };
  techs = Object.keys(list.technologies ?? {}).sort();
  if (sample > 0) techs = techs.slice(0, sample);
}
const out = { technologies: 0, with_events: 0, events: 0, extracted: 0, releases: 0, client_releases: 0, since };
for (const t of techs) {
  const raw = await read(`v1/tech/${t}.json`);
  if (!raw) continue;
  const index = JSON.parse(raw.toString()) as { shards?: Ref[]; events?: Ref[] };
  out.technologies++;
  if (!index.events?.length) continue;
  out.with_events++;
  const named = new Set<string>();
  for (const s of index.shards ?? [])
    for (const r of lines(await read(s.path)))
      for (const x of (r.releases as Array<{ version: string }> | undefined) ?? []) named.add(x.version);
  const byRelease = new Map<string, boolean>();
  for (const s of index.events)
    for (const e of lines(await read(s.path))) {
      if (String(e.date) < since) continue;
      out.events++;
      if (e.extracted) out.extracted++;
      const v = String(e.version);
      const derive = !e.extracted && !named.has(v);
      byRelease.set(v, (byRelease.get(v) ?? false) || derive);
    }
  out.releases += byRelease.size;
  out.client_releases += [...byRelease.values()].filter(Boolean).length;
}
console.log(JSON.stringify({ ...out, extracted_share: out.events ? out.extracted / out.events : null, client_share: out.releases ? out.client_releases / out.releases : null }));
