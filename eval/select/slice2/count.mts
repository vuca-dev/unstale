// Dry count for slice 2: documents, chunks and Codex calls per arm (no model calls). Reads the side store named by
// UNSTALE_CENTRAL_DIR offline, exactly as `runTechnology` does with --offline --no-docs.
import { existsSync } from "node:fs";
import { join } from "node:path";
const { fetchGuides, fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
const { chunk, EXTRACT_PROMPT, ONE_CALL_PROMPT, fill } = await import("../../../central/src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { centralDir } = await import("../../../central/src/pipeline/paths.ts");
const { sha256 } = await import("../../../central/src/pipeline/util.ts");
const { CODEX_MODEL } = await import("../../../central/src/pipeline/codex.ts");
const { DEFAULT_HTTP, HttpClient } = await import("../../../central/src/collector/http.ts");
let docs = 0, chunks = 0, hitsA = 0, hits1 = 0, chars = 0;
for (const id of ["next", "prisma", "nestjs"]) {
  const t = TECHNOLOGIES[id]!;
  const f = await fetchReleases(t, { refresh: false, offline: true });
  const g = await fetchGuides(t, f.notes, { refresh: false, offline: true, http: new HttpClient(DEFAULT_HTTP) });
  let c = 0;
  for (const rel of [...f.notes, ...g]) {
    docs++;
    const parts = chunk(rel.notes);
    parts.forEach((notes, ci) => {
      if (!notes.trim()) return;
      c++;
      chars += notes.length;
      const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      const v = { TECH: t.name, VERSION: rel.version, DATE: rel.date, PART: part, NOTES: notes };
      const hit = (p: string) => { const k = sha256(`${CODEX_MODEL}\n${p}`); return existsSync(join(centralDir(), "cache", "codex", k.slice(0, 2), `${k}.json`)); };
      if (hit(fill(EXTRACT_PROMPT, v))) hitsA++;
      if (hit(fill(ONE_CALL_PROMPT, v))) hits1++;
    });
  }
  console.log(`${id}: ${f.notes.length} releases, ${g.length} guides, ${c} chunks`);
  chunks += c;
}
console.log(JSON.stringify({ store: centralDir(), docs, chunks, notes_chars: chars, extract_cache_hits: hitsA, one_call_cache_hits: hits1,
  calls_two_call_max: 2 * chunks, calls_one_call_max: chunks, P_A_chars: EXTRACT_PROMPT.length, P_1_chars: ONE_CALL_PROMPT.length }));
