// Slice 12's record matcher (score12.mts), shared by slice 13's analysis scripts: grounded quotes whose spans overlap in
// the folded notes, else the same subject after case folding; one to one.
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
export type Lab = { change_type: string; surface: string; breaking: boolean; benefit: string[] | null } | null;
export type Rec = Incoming & { labels: Lab; e: { outcome: string } | null };
export interface Row { tech: string; name?: string; version: string; stratum: string; failed: number; incoming: Rec[] }
export const norm = (s: string): string => s.replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1").replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
export function match(notes: string, xs: Rec[], ys: Rec[]): Array<[Rec, Rec]> {
  const n = norm(notes);
  const span = (r: Rec): [number, number] | undefined => {
    const q = norm(r.quote);
    const i = q ? n.indexOf(q) : -1;
    return r.grounded && i >= 0 ? [i, i + q.length] : undefined;
  };
  const used = new Set<number>();
  const pairs: Array<[Rec, Rec]> = [];
  const left: Rec[] = [];
  for (const x of xs) {
    const sx = span(x);
    const j = sx ? ys.findIndex((y, k) => !used.has(k) && ((s) => !!s && s[0] < sx[1] && sx[0] < s[1])(span(y))) : -1;
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
    else left.push(x);
  }
  for (const x of left) {
    const j = ys.findIndex((y, k) => !used.has(k) && y.subject.toLowerCase() === x.subject.toLowerCase());
    if (j >= 0) (used.add(j), pairs.push([x, ys[j]!]));
  }
  return pairs;
}
