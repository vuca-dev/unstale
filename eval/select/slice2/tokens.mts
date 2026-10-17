// Prompt-only token estimate per arm (characters / 4 of the rendered prompts and of the answers), from the arm's
// Codex cache: every prompt the arm sent is re-rendered exactly as extractRelease renders it and looked up by its key.
// Usage: UNSTALE_CENTRAL_DIR=<side store> npx tsx ../eval/select/slice2/tokens.mts two-call|one-call
import { join } from "node:path";
const { fetchGuides, fetchReleases } = await import("../../../central/src/pipeline/fetch.ts");
const X = await import("../../../central/src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../../../central/src/pipeline/technologies.ts");
const { centralDir } = await import("../../../central/src/pipeline/paths.ts");
const { readJson, sha256 } = await import("../../../central/src/pipeline/util.ts");
const { CODEX_MODEL, parseJson } = await import("../../lib/codex.ts");
const { DEFAULT_HTTP, HttpClient } = await import("../../../central/src/collector/http.ts");
const structure = process.argv[2] as "two-call" | "one-call";
const answer = (p: string) => { const k = sha256(`${CODEX_MODEL}\n${p}`); return readJson<{ text: string; usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number } }>(join(centralDir(), "cache", "codex", k.slice(0, 2), `${k}.json`)); };
const s = { chunks: 0, calls: 0, missing: 0, in_chars: 0, out_chars: 0, notes_chars: 0, records: 0, harness_in: 0, harness_cached: 0, harness_out: 0, label_in_chars: 0, label_out_chars: 0, max_chunk_in_chars: 0 };
const take = (p: string) => { const a = answer(p); s.calls++; s.in_chars += p.length; if (!a) { s.missing++; return undefined; } s.out_chars += a.text.length; if (a.usage) { s.harness_in += a.usage.input_tokens; s.harness_cached += a.usage.cached_input_tokens; s.harness_out += a.usage.output_tokens; } return a.text; };
for (const id of ["next", "prisma", "nestjs"]) {
  const t = TECHNOLOGIES[id]!;
  const f = await fetchReleases(t, { refresh: false, offline: true });
  const g = await fetchGuides(t, f.notes, { refresh: false, offline: true, http: new HttpClient(DEFAULT_HTTP) });
  for (const rel of [...f.notes, ...g]) {
    const parts = X.chunk(rel.notes);
    for (const [ci, notes] of parts.entries()) {
      if (!notes.trim()) continue;
      s.chunks++; s.notes_chars += notes.length;
      const before = s.in_chars + s.out_chars;
      const part = parts.length > 1 ? `\nPart ${ci + 1} of ${parts.length} of these release notes.` : "";
      const v = { TECH: t.name, VERSION: rel.version, DATE: rel.date, PART: part, NOTES: notes };
      if (structure === "one-call") {
        const a = take(X.fill(X.ONE_CALL_PROMPT, v));
        s.records += (a && X.parseOneCall(a)?.length) || 0;
      } else {
        const a = take(X.fill(X.EXTRACT_PROMPT, v));
        const arr = a ? parseJson(a, "array") : undefined;
        const recs = Array.isArray(arr) ? arr.flatMap((r) => { const p = X.Extracted.safeParse(r); return p.success ? [p.data] : []; }) : [];
        s.records += recs.length;
        if (!recs.length) continue;
        const brief = recs.map((r, i) => ({ id: `r${i + 1}`, subject: r.subject, facet: r.facet ?? null, change_type: r.change_type ?? null, summary: r.summary, introduces: X.strings(r.introduces, 20), evidence: r.evidence ?? "" }));
        const lp = X.fill(X.LABEL_PROMPT, { TECH: t.name, VERSION: rel.version, RECORDS: JSON.stringify(brief, null, 1), NOTES: notes });
        const o0 = s.out_chars;
        take(lp);
        s.label_in_chars += lp.length; s.label_out_chars += s.out_chars - o0;
      }
      s.max_chunk_in_chars = Math.max(s.max_chunk_in_chars, s.in_chars + s.out_chars - before);
    }
  }
}
const tok = (c: number) => Math.round(c / 4);
console.log(JSON.stringify({ store: centralDir(), structure, ...s, est_in_tokens: tok(s.in_chars), est_out_tokens: tok(s.out_chars),
  est_in_per_chunk: tok(s.in_chars / s.chunks), est_out_per_chunk: tok(s.out_chars / s.chunks), P_extract: tok(X.EXTRACT_PROMPT.length), P_label: tok(X.LABEL_PROMPT.length), P_one: tok(X.ONE_CALL_PROMPT.length) }));
