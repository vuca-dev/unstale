// A documentation change as extraction input: each changed section under its heading path, as unified hunks, inside a
// fence that the page's own text cannot close (official docs are data, never instructions). Section-scoped with context
// is the measured default (14 October 2026).
import { markWords, type SectionChange } from "../collector/sections.ts";
import { extractText } from "../pipeline/prompts.ts";

/** A backtick fence longer than any backtick run in the text, so the text cannot end it. */
export function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** What the extraction model is told about a rendered change (schema/prompts/extract.json). */
export const PREAMBLE = extractText.docs_preamble;
export const PREAMBLE_MARKED = extractText.docs_preamble_marked;

export interface RenderOptions {
  /** Mark changed words inline ("~" lines) and drop the line-number headers. */
  words?: boolean;
}

export function renderChange(url: string, kind: string, changes: readonly SectionChange[], opts: RenderOptions = {}): string {
  const parts = [opts.words ? PREAMBLE_MARKED : PREAMBLE, "", `Page: ${url} (${kind})`];
  for (const c of changes) {
    const where = c.path.length ? c.path.join(" > ") : "(top of page)";
    const was = c.from ? `; was under ${c.from.length ? c.from.join(" > ") : "(top of page)"}` : "";
    const body = opts.words ? compact(c.hunks) : c.hunks;
    const f = fenceFor(body);
    parts.push("", `Section: ${where} (${c.status}${was})`, opts.words ? f : `${f}diff`, body, f);
  }
  return parts.join("\n") + "\n";
}

/** Word-marked hunks without line-number headers (the first header is dropped, later ones become "…"). */
export function compact(hunks: string): string {
  return markWords(hunks)
    .split("\n")
    .map((l, i) => (l.startsWith("@@") ? (i === 0 ? undefined : "…") : l))
    .filter((l): l is string => l !== undefined)
    .join("\n");
}

const REMOVED = /\[-([\s\S]*?)-\]/g;
const ADDED = /\{\+([\s\S]*?)\+\}/g;

/** The page text after the change (removed words dropped, added words kept) and before it, from word-marked notes. */
export function markViews(notes: string): { after: string; before: string } {
  return { after: notes.replace(REMOVED, "").replace(ADDED, "$1"), before: notes.replace(ADDED, "").replace(REMOVED, "$1") };
}

/**
 * An evidence quote as page text: the model sometimes copies the marks ("[-turbopackFileSystemCache-]"). A quote with
 * added words reads as the new text; a quote of removed words only reads as the old text. Diff prefixes go too.
 */
export function unmarkQuote(q: string): string {
  const s = q.replace(/^[~+-](?=\S)/gm, "");
  return /\{\+/.test(s) ? s.replace(REMOVED, "").replace(ADDED, "$1") : s.replace(REMOVED, "$1");
}
