// Label-call prompt variants (#5b) and the input diet (#6). Variants are built from the pipeline's LABEL_PROMPT by
// replacing marked passages, so a change upstream flows in; a marker that is no longer found throws.
import { LABEL_PROMPT, locate } from "../../../central/src/pipeline/extract.ts";
import type { Chunk } from "./items.mts";

function swap(s: string, from: string, to: string): string {
  if (!s.includes(from)) throw new Error(`prompts.mts: marker not found: ${from.slice(0, 60)}`);
  return s.replace(from, to);
}

const REPLACES_FROM = `"replaces" (0 to 4 terms): upstream literals that existing code contains and that this change makes obsolete, such as
an older API, option, file name or a package used for the same job. Same literal rules.`;
// v1: replaces covers the ways existing code writes the obsolete literal, as "terms" already asks for terms.
const REPLACES_TO = `"replaces" (0 to 4 terms): upstream literals that existing code contains and that this change makes obsolete, such as
an older API, option, file name or a package used for the same job. Same literal rules. When existing code writes the
obsolete literal in more than one way, give the ways a project's code would contain it (qualified and unqualified
name, import specifier, nested and dotted configuration key, attribute with its value), most common first.`;
const REQUIRES_FROM = "[] unless\nthe notes limit the change to such projects.";
// v2: requires names the scoping integrations the notes mention (a transport, adapter, driver, plugin or platform).
const REQUIRES_TO = `[] unless
the notes limit the change to such projects. The notes often limit a change in passing: "on the Kafka transport",
"when using the Express adapter", "for the SWC builder", "on Cloudflare Workers", "with the pg driver". Then list the
literal such projects already contain (the integration's package or the import they use), not the technology itself
and not a package the change introduces.`;
export const PROMPTS: Record<string, string> = {
  base: LABEL_PROMPT,
  v1: swap(LABEL_PROMPT, REPLACES_FROM, REPLACES_TO),
  v2: swap(LABEL_PROMPT, REQUIRES_FROM, REQUIRES_TO),
  v3: swap(swap(LABEL_PROMPT, REPLACES_FROM, REPLACES_TO), REQUIRES_FROM, REQUIRES_TO),
};

/**
 * #6: only the sections (heading-bounded, with their ancestor heading lines) that hold a record's evidence, in document
 * order; a gap between kept sections is marked "[…]". Any record whose evidence is not found within one section brings
 * the whole chunk, so the worst case is today's input.
 */
export function dietNotes(c: Chunk): string {
  const lines = c.notes.split("\n");
  const secs: Array<{ level: number; start: number; end: number }> = [{ level: 0, start: 0, end: lines.length }];
  lines.forEach((l, i) => {
    const h = /^(#{1,6})\s+\S/.exec(l);
    if (!h) return;
    secs.at(-1)!.end = i;
    secs.push({ level: h[1]!.length, start: i, end: lines.length });
  });
  const text = (s: { start: number; end: number }) => lines.slice(s.start, s.end).join("\n");
  const keep = new Set<number>();
  for (const r of c.records) {
    const q = r.evidence.trim();
    const hit = q ? secs.findIndex((s) => locate(text(s), q).grounded) : -1;
    if (hit < 0) return c.notes;
    keep.add(hit);
  }
  const out: string[] = [];
  const emitted = new Set<number>();
  let last = -1;
  [...keep].sort((x, y) => x - y).forEach((i) => {
    const anc: number[] = [];
    let lvl = secs[i]!.level;
    for (let j = i - 1; j >= 0 && lvl > 1; j--) if (secs[j]!.level > 0 && secs[j]!.level < lvl) { anc.unshift(j); lvl = secs[j]!.level; }
    if (last >= 0 && i !== last + 1) out.push("[…]");
    for (const j of anc) if (!emitted.has(j) && !keep.has(j)) { out.push(lines[secs[j]!.start]!); emitted.add(j); }
    out.push(text(secs[i]!));
    emitted.add(i);
    last = i;
  });
  return out.join("\n");
}

/** #6b: the label prompt with no notes; each record's brief gains its located section heading. */
export function evidenceOnly(c: Chunk): { records: Array<Record<string, unknown>>; notes: string } {
  return { records: c.records.map((r) => { const w = locate(c.notes, r.evidence.trim()); return w.section ? { ...r, section: w.section } : { ...r }; }), notes: "(not provided: use each record's evidence and section)" };
}
