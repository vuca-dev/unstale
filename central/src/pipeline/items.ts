// Where a record's quote sits in a release body: the whole list item it came from (continuation lines included, links
// kept), the headings above it, and the upstream change the item cites (pull requests and commits). Deterministic,
// no network: read from the stored release body.

/** Text for locating a quote: link targets and markup removed, list markers dropped, case and whitespace folded. */
const flat = (s: string) =>
  s
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[`*_\\[\]]/g, "")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, "")
    .replace(/^[\s:;,.-]+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

const HEADING = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;

export interface Item {
  /** The list item as written (its lines joined with a space), or the line when it is not in a list. */
  text: string;
  /** The headings above it, outermost first (Markdown ATX headings outside code fences). */
  headings: string[];
}

/**
 * The item of `body` a quote comes from: the line holding the quote (else the shortest window of up to 4 lines), grown
 * to its whole list item (from the line with the list marker to the line before the next item, heading or blank
 * line). Undefined when no line holds the quote, or when lines under different headings or in different items hold it
 * equally well (the quote alone cannot say which).
 */
export function itemOf(body: string, quote: string): Item | undefined {
  const lines = body.split(/\r?\n/);
  const q = flat(quote);
  if (q.length < 4) return undefined;
  // Heading path and fence state per line.
  const paths: string[][] = [];
  const isHeading: boolean[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: string | undefined;
  for (const line of lines) {
    const f = FENCE.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? undefined : f;
    const h = fence || f ? undefined : HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.trim() });
    }
    isHeading.push(!!h);
    paths.push(stack.map((s) => s.title));
  }
  let at: number[] = [];
  for (let len = 1; len <= 4 && !at.length; len++) {
    for (let i = 0; i + len <= lines.length; i++) if (!isHeading[i] && flat(lines.slice(i, i + len).join(" ")).includes(q)) at.push(i);
  }
  if (!at.length) return undefined;
  const bounds = (i: number): [number, number] => {
    let start = i;
    while (start > 0 && !LIST_ITEM.test(lines[start]!) && lines[start - 1]!.trim() && !isHeading[start - 1]) start--;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1]!.trim() && !isHeading[end + 1] && !LIST_ITEM.test(lines[end + 1]!)) end++;
    return [start, end];
  };
  const found = [...new Map(at.map((i) => { const b = bounds(i); return [`${b[0]}:${b[1]}`, b] as const; })).values()];
  if (found.length > 1) return undefined;
  const [start, end] = found[0]!;
  return { text: lines.slice(start, end + 1).map((l) => l.trim()).join(" "), headings: paths[start]! };
}

/**
 * The upstream changes an item cites: pull requests (`#123`, `/pull/123`) and commits (`/commit/<sha>`, by its first 7
 * characters). Issues are left out: one issue can be fixed by several different changes.
 */
export function changeRefs(item: string): Set<string> {
  const out = new Set<string>();
  const noIssues = item.replace(/https?:\/\/\S*\/issues\/\d+\S*/g, " ");
  for (const m of noIssues.matchAll(/\/pull\/(\d+)/g)) out.add(`pr:${m[1]}`);
  for (const m of noIssues.replace(/\]\([^)]*\)/g, "]").matchAll(/(?<![\w/&])#(\d+)\b/g)) out.add(`pr:${m[1]}`);
  for (const m of noIssues.matchAll(/\/commit\/([0-9a-f]{7,40})\b/gi)) out.add(`commit:${m[1]!.slice(0, 7).toLowerCase()}`);
  return out;
}
