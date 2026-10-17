// Section-scoped diffs (vault: Capability Synthesis, "Extraction from documentation diffs"; working default 14 October
// 2026). A Markdown snapshot is split at ATX headings outside code fences; sections are matched by heading path, and
// each changed section is reported under its path as unified hunks with context, removed lines included.
import { diffArrays, structuredPatch } from "diff";

export interface Section {
  /** Heading texts from the top level down; [] for text before the first heading. */
  path: string[];
  level: number;
  /** The section's lines, its heading line first. Subsections are separate sections. */
  lines: string[];
}

export type SectionStatus = "added" | "removed" | "modified";

export interface SectionChange {
  /** The heading path in the new snapshot (the old one for a removed section). */
  path: string[];
  /** The old path, when the section was renamed or moved under another heading. */
  from?: string[];
  status: SectionStatus;
  /** Unified hunks: `@@` headers, then lines prefixed " " (context), "-" (removed) or "+" (added). */
  hunks: string;
  added: number;
  removed: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function sections(text: string): Section[] {
  const out: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let cur: Section = { path: [], level: 0, lines: [] };
  let fence: string | undefined;
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? undefined : f;
    const h = fence || f ? undefined : HEADING.exec(line);
    if (h) {
      if (cur.lines.length) out.push(cur);
      const level = h[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, title: h[2]!.trim() });
      cur = { path: stack.map((s) => s.title), level, lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.length) out.push(cur);
  return out.filter((s) => s.level > 0 || s.lines.some((l) => l.trim()));
}

/** Keys by heading path; a repeated path gets its occurrence number. */
function keyed(secs: Section[]): Map<string, Section> {
  const seen = new Map<string, number>();
  const out = new Map<string, Section>();
  for (const s of secs) {
    const base = JSON.stringify(s.path);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(n ? `${base}#${n}` : base, s);
  }
  return out;
}

const body = (s: Section) => s.lines.slice(s.level ? 1 : 0).filter((l) => l.trim());
const same = (a: Section, b: Section) => a.lines.join("\n") === b.lines.join("\n");

function overlap(a: Section, b: Section): number {
  const x = new Set(body(a));
  const y = new Set(body(b));
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const l of x) if (y.has(l)) hit++;
  return hit / Math.max(x.size, y.size);
}

function hunks(before: string[], after: string[], context: Context): { text: string; added: number; removed: number } {
  if (context === "block") return blockHunks(before, after);
  const patch = structuredPatch("a", "b", before.join("\n") + "\n", after.join("\n") + "\n", "", "", { context });
  let added = 0;
  let removed = 0;
  const text = patch.hunks
    .map((h) => {
      for (const l of h.lines) {
        if (l.startsWith("+")) added++;
        else if (l.startsWith("-")) removed++;
      }
      return [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.filter((l) => !l.startsWith("\\"))].join("\n");
    })
    .join("\n");
  return { text, added, removed };
}

const whole = (s: Section, sign: "+" | "-") => s.lines.map((l) => sign + l).join("\n");

/**
 * How much unchanged text a hunk carries: a fixed number of lines, or "block": the Markdown block the change sits in
 * (its paragraph, list, table or code fence, up to BLOCK_CAP lines), plus the line that leads into a list, table or
 * fence ("Remove these flags:"), so a changed list item says what it is a list of.
 */
export type Context = number | "block";
const BLOCK_CAP = 12;
const LIST_OR_TABLE = /^\s*([-*+]|\d+[.)]|\|)\s?/;

/** For each line, the inclusive range of the block it belongs to, and the lead-in line of that block if any. */
function blocks(lines: string[]): Array<{ from: number; to: number; lead?: number }> {
  const fenceOf: Array<[number, number] | undefined> = new Array(lines.length);
  let open: { at: number; mark: string } | undefined;
  lines.forEach((l, i) => {
    const f = FENCE.exec(l)?.[1];
    if (!f) return;
    if (!open) open = { at: i, mark: f };
    else if (f[0] === open.mark[0] && f.length >= open.mark.length) {
      for (let j = open.at; j <= i; j++) fenceOf[j] = [open.at, i];
      open = undefined;
    }
  });
  const out: Array<{ from: number; to: number; lead?: number }> = new Array(lines.length);
  const blank = (i: number) => !lines[i]!.trim() && !fenceOf[i];
  for (let i = 0; i < lines.length; i++) {
    let [from, to] = fenceOf[i] ?? [i, i];
    if (!fenceOf[i]) {
      while (from > 0 && !blank(from - 1) && !fenceOf[from - 1] && !HEADING.exec(lines[from]!)) from--;
      while (to < lines.length - 1 && !blank(to + 1) && !fenceOf[to + 1] && !HEADING.exec(lines[to + 1]!)) to++;
    }
    const structured = fenceOf[i] || LIST_OR_TABLE.test(lines[from]!);
    let lead: number | undefined;
    if (structured) for (let j = from - 1; j >= 0; j--) if (lines[j]!.trim()) { lead = j; break; }
    out[i] = lead === undefined ? { from, to } : { from, to, lead };
  }
  return out;
}

function blockHunks(before: string[], after: string[]): { text: string; added: number; removed: number } {
  type E = { t: " " | "-" | "+"; line: string; o: number; n: number };
  const es: E[] = [];
  let o = 0;
  let n = 0;
  for (const part of diffArrays(before, after)) {
    for (const line of part.value) {
      if (part.added) es.push({ t: "+", line, o, n: n++ });
      else if (part.removed) es.push({ t: "-", line, o: o++, n });
      else es.push({ t: " ", line, o: o++, n: n++ });
    }
  }
  const keepOld = new Set<number>();
  const keepNew = new Set<number>();
  const ob = blocks(before);
  const nb = blocks(after);
  const window = (b: { from: number; to: number; lead?: number }, at: number, keep: Set<number>) => {
    // A block longer than the cap keeps its lines nearest the change, and its lead-in.
    const half = Math.floor(BLOCK_CAP / 2);
    const from = b.to - b.from + 1 > BLOCK_CAP ? Math.max(b.from, at - half) : b.from;
    const to = b.to - b.from + 1 > BLOCK_CAP ? Math.min(b.to, at + half) : b.to;
    for (let j = from; j <= to; j++) keep.add(j);
    if (b.lead !== undefined) keep.add(b.lead);
  };
  for (const e of es) {
    if (e.t === "-") window(ob[e.o]!, e.o, keepOld);
    if (e.t === "+") window(nb[e.n]!, e.n, keepNew);
  }
  const groups: E[][] = [];
  let last = -2;
  es.forEach((e, i) => {
    if (e.t === " " && !keepOld.has(e.o) && !keepNew.has(e.n)) return;
    if (i !== last + 1) groups.push([]);
    groups.at(-1)!.push(e);
    last = i;
  });
  let added = 0;
  let removed = 0;
  const text = groups
    .map((g) => {
      const ol = g.filter((e) => e.t !== "+").length;
      const nl = g.filter((e) => e.t !== "-").length;
      added += g.filter((e) => e.t === "+").length;
      removed += g.filter((e) => e.t === "-").length;
      return [`@@ -${g[0]!.o + 1},${ol} +${g[0]!.n + 1},${nl} @@`, ...g.map((e) => e.t + e.line)].join("\n");
    })
    .join("\n");
  return { text, added, removed };
}

/**
 * Words for a word diff in any script: runs of letters, digits and underscores; each Han, Hiragana or Katakana
 * character on its own (those scripts have no spaces); each whitespace run and each other character. The diff library's
 * own word split knows only Latin letters and diffs Cyrillic letter by letter.
 */
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_\p{M}]+|\s+|./gsu;
export function wordDiff(a: string, b: string): Array<{ value: string; added?: boolean; removed?: boolean }> {
  return diffArrays(a.match(TOKEN) ?? [], b.match(TOKEN) ?? []).map((p) => ({ value: p.value.join(""), ...(p.added ? { added: true } : {}), ...(p.removed ? { removed: true } : {}) }));
}

/**
 * The hunks with each run of removed lines followed by added lines rewritten as "~" lines that mark the changed words
 * inline, `[-old-]{+new+}`, when the run is mostly the same text (a paragraph is one Markdown line, so one changed word
 * otherwise repeats the whole paragraph twice). A run that is mostly new text keeps its "-" and "+" lines.
 */
export function markWords(hunks: string, minShared = 0.5): string {
  const lines = hunks.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i]!.startsWith("-")) {
      out.push(lines[i++]!);
      continue;
    }
    const rem: string[] = [];
    const add: string[] = [];
    while (i < lines.length && lines[i]!.startsWith("-")) rem.push(lines[i++]!.slice(1));
    while (i < lines.length && lines[i]!.startsWith("+")) add.push(lines[i++]!.slice(1));
    if (!add.length) {
      out.push(...rem.map((l) => "-" + l));
      continue;
    }
    const r = rem.join("\n");
    const a = add.join("\n");
    const parts = wordDiff(r, a);
    const shared = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.replace(/\s+/g, "").length, 0);
    const size = Math.max(1, r.replace(/\s+/g, "").length, a.replace(/\s+/g, "").length);
    if (shared / size < minShared) {
      out.push(...rem.map((l) => "-" + l), ...add.map((l) => "+" + l));
      continue;
    }
    const marked = parts.map((p) => (p.removed ? `[-${p.value}-]` : p.added ? `{+${p.value}+}` : p.value)).join("");
    out.push(...marked.split("\n").map((l) => "~" + l));
  }
  return out.join("\n");
}

/**
 * Changed sections between two snapshots, in the new snapshot's order, removed sections last. A section whose path
 * changed but whose content is (mostly) the same is paired with its old self: identical content under a renamed
 * parent is no change, and a renamed heading is reported as a modification with `from`.
 */
export function sectionDiff(before: string, after: string, context: Context = 3): SectionChange[] {
  const old = keyed(sections(before));
  const now = keyed(sections(after));
  const out: SectionChange[] = [];
  const unmatchedOld = [...old].filter(([k]) => !now.has(k)).map(([, s]) => s);
  const unmatchedNew = [...now].filter(([k]) => !old.has(k)).map(([, s]) => s);

  // Pair renamed or moved sections: identical lines, then most body overlap (>= 0.5), then empty-bodied headings
  // of the same level in document order.
  const pairs = new Map<Section, Section>(); // new -> old
  const take = (n: Section, o: Section) => {
    pairs.set(n, o);
    unmatchedOld.splice(unmatchedOld.indexOf(o), 1);
  };
  for (const n of unmatchedNew) {
    const o = unmatchedOld.find((x) => same(x, n)) ?? unmatchedOld.find((x) => x.lines.slice(1).join("\n") === n.lines.slice(1).join("\n") && body(x).length > 0);
    if (o) take(n, o);
  }
  for (const n of unmatchedNew.filter((x) => !pairs.has(x))) {
    let best: Section | undefined;
    let score = 0.5;
    for (const o of unmatchedOld) {
      const s = overlap(o, n);
      if (s >= score) [best, score] = [o, s];
    }
    if (best) take(n, best);
  }
  for (const n of unmatchedNew.filter((x) => !pairs.has(x) && body(x).length === 0)) {
    const o = unmatchedOld.find((x) => x.level === n.level && body(x).length === 0);
    if (o) take(n, o);
  }

  for (const [k, n] of now) {
    const o = old.get(k) ?? pairs.get(n);
    if (!o) {
      out.push({ path: n.path, status: "added", hunks: whole(n, "+"), added: n.lines.length, removed: 0 });
      continue;
    }
    const moved = JSON.stringify(o.path) !== JSON.stringify(n.path);
    if (same(o, n)) continue; // unchanged, or only its parent heading changed
    const h = hunks(o.lines, n.lines, context);
    if (!h.added && !h.removed) continue;
    out.push({ path: n.path, ...(moved ? { from: o.path } : {}), status: "modified", hunks: h.text, added: h.added, removed: h.removed });
  }
  for (const o of unmatchedOld) out.push({ path: o.path, status: "removed", hunks: whole(o, "-"), added: 0, removed: o.lines.length });
  return out;
}

/** A whole snapshot as added sections: the diff of a page created after its source's baseline. */
export function allAdded(text: string): SectionChange[] {
  return sectionDiff("", text);
}
