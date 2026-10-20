// Slice 6 shared helpers: the shared-guide units (one upgrade guide URL + snapshot ingested by two or more
// technologies) read from a production state copy, and each technology as the onboarding service builds it
// (discovery.ts pipelineTechnology over the job's descriptor; a catalog technology from technologies.ts).
//
// The state copy is a directory with `guides/<tech>/index.json` + `<major>.<snap8>.md` (fetch.ts fetchGuides) and
// `onboarding/jobs/*.json` (descriptors). Nothing here calls a model.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GuideNote } from "../../../central/src/pipeline/fetch.ts";
import type { Technology } from "../../../central/src/pipeline/technologies.ts";
import { TECHNOLOGIES } from "../../../central/src/pipeline/technologies.ts";
import { pipelineTechnology } from "../../../central/src/onboarding/discovery.ts";

export interface Unit {
  /** `<url> @ <snap8>` */
  id: string;
  url: string;
  snapshot: string;
  /** One guide note per technology that ingested it (its own version and date as fetchGuides recorded them). */
  members: Array<{ tech: Technology; note: GuideNote }>;
}

export function loadTechnologies(jobsDir: string): Map<string, Technology> {
  const out = new Map<string, Technology>();
  for (const t of Object.values(TECHNOLOGIES)) out.set(t.id, t);
  for (const f of readdirSync(jobsDir)) {
    if (!f.endsWith(".json")) continue;
    const j = JSON.parse(readFileSync(join(jobsDir, f), "utf8")) as { descriptor?: Parameters<typeof pipelineTechnology>[0] };
    if (j.descriptor?.id && !out.has(j.descriptor.id)) out.set(j.descriptor.id, pipelineTechnology(j.descriptor));
  }
  return out;
}

export function sharedUnits(guidesDir: string, techs: Map<string, Technology>): Unit[] {
  const by = new Map<string, Unit>();
  for (const id of readdirSync(guidesDir).sort()) {
    const ip = join(guidesDir, id, "index.json");
    if (!existsSync(ip)) continue;
    const t = techs.get(id);
    if (!t) continue;
    const index = JSON.parse(readFileSync(ip, "utf8")) as { guides: Array<Omit<GuideNote, "notes"> & { repo?: string }> };
    for (const g of index.guides) {
      if ("repo" in g) continue;
      const p = join(guidesDir, id, `${g.version.split(".")[0]}.${g.snapshot.slice(7, 15)}.md`);
      if (!existsSync(p)) continue;
      const key = `${g.url} @ ${g.snapshot.slice(7, 15)}`;
      const u = by.get(key) ?? { id: key, url: g.url, snapshot: g.snapshot, members: [] };
      u.members.push({ tech: t, note: { ...g, notes: readFileSync(p, "utf8") } as GuideNote });
      by.set(key, u);
    }
  }
  return [...by.values()].filter((u) => u.members.length > 1).sort((a, b) => a.id.localeCompare(b.id));
}

/** Refuses every network call: a run that must be answered from the cache alone fails loudly instead of spending. */
export function noNetwork(): void {
  globalThis.fetch = (async () => {
    throw new Error("slice 6: network call refused in a cache-only step");
  }) as typeof fetch;
}
