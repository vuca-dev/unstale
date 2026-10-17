// Normalization applied to extracted text before hashing and storing.
import { createHash } from "node:crypto";
import type { NormalizeRules } from "./schema.ts";

export function normalize(text: string, rules: NormalizeRules): string {
  // Invisible to readers: variation selectors, zero-width characters, soft hyphens, BOM.
  let s = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\uFE0E\uFE0F\u200B-\u200D\u2060\u00AD\uFEFF]/g, "");
  if (rules.dropFrontMatter) s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  if (rules.canonicalMarkdown) s = canonicalMarkdown(s);
  const drop = rules.dropLines.map((p) => new RegExp(p));
  const replace = rules.replace.map((r) => ({ re: new RegExp(r.pattern, "g"), with: r.with }));
  let lines = s.split("\n").map((l) => {
    let line = l.replace(/[ \t]+$/, "");
    for (const r of replace) line = line.replace(r.re, r.with);
    return line;
  });
  lines = lines.filter((l) => !drop.some((re) => re.test(l)));
  lines = dropEmptyFences(lines);
  if (rules.sortLines) lines = lines.filter((l) => l.trim()).sort();
  // Generated copies move blank lines around on renderer changes; their placement carries no content.
  if (rules.canonicalMarkdown) lines = lines.filter((l) => l.trim());
  // Collapse runs of blank lines; trim the ends.
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && (out.length === 0 || out.at(-1) === "")) continue;
    out.push(l);
  }
  while (out.at(-1) === "") out.pop();
  return out.join("\n") + "\n";
}

/** Remove fenced code blocks left empty (e.g. after a drop rule removed their only line). */
function dropEmptyFences(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(```|~~~)[\w-]*\s*$/.exec(lines[i] as string);
    let j = i + 1;
    while (open && j < lines.length && !(lines[j] as string).trim()) j++;
    if (open && j < lines.length && (lines[j] as string).trim() === open[1]) {
      i = j;
      continue;
    }
    out.push(lines[i] as string);
  }
  return out;
}

const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;

/** Canonical Markdown formatting, outside code fences. Content is untouched. */
export function canonicalMarkdown(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return line.replace(/^(\s*)(```|~~~).*$/, "$1```"); // fence style and language tag are formatting
      }
      if (fence) return line;
      let l = line.replace(/^(\s*)[*+]\s+/, "$1- "); // bullet markers
      l = l.replace(/^(\s*)(\d+)[.)]\s+/, "$1$2. "); // ordered markers
      l = l.replace(/\\([!-/:-@[-`{-~])/g, (_m, c: string) => (c === "|" ? "\\|" : c)); // escapes, except table pipes
      if (/^\s*\|.*\|\s*$/.test(l)) {
        const cells = l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
        // Renderers differ on empty corner and trailing cells; drop empty cells at the row edges.
        while (cells.length > 1 && cells[0] === "") cells.shift();
        while (cells.length > 1 && cells.at(-1) === "") cells.pop();
        l = cells.every((c) => TABLE_SEPARATOR_CELL.test(c)) ? `|${cells.map(() => " --- ").join("|")}|` : `| ${cells.join(" | ")} |`;
      }
      return l.replace(/[ \t]+/g, " ").replace(/^ (?=\S)/, "");
    })
    .join("\n");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted at every level, for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
