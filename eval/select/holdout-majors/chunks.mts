// Fills `chunks` (and `chunk_chars`) in extraction/notes.json with the pipeline's own chunk() (MAX_CHUNK) over each saved
// document. Run from central/: npx tsx ../eval/select/holdout-majors/chunks.mts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunk, MAX_CHUNK } from "../../../central/src/pipeline/extract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const path = join(here, "extraction", "notes.json");
const m = JSON.parse(readFileSync(path, "utf8"));
for (const n of m.notes) {
  const parts = chunk(readFileSync(join(here, "extraction", "notes", n.note_file), "utf8"));
  n.chunks = parts.length;
  n.chunk_chars = parts.map((p) => p.length);
  console.log(`${n.note_file.padEnd(46)} ${String(n.chars).padStart(6)} chars  ${parts.length} chunk(s)  [${n.chunk_chars.join(", ")}]`);
}
m.max_chunk = MAX_CHUNK;
writeFileSync(path, JSON.stringify(m, null, 1) + "\n");
