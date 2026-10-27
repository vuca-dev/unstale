// Prunes a weekly agent's log (.github/agents/common.md, "The log") by date and size, with no model:
//   entries  `### YYYY-MM-DD · title` + bullets: whole up to FULL_DAYS old, then only the heading and the `Outcome`
//            line up to KEEP_DAYS, then dropped;
//   revisit  `- YYYY-MM-DD: idea` bullets under `## Revisit`: dropped after KEEP_DAYS;
//   size     past MAX_CHARS (about 6k tokens), the oldest entries are shortened, then dropped, until it fits.
// An undated entry or bullet is kept (it is dated by the agent; a malformed one is visible, not lost).
//
//   node prune.mjs <file> [today YYYY-MM-DD]
import { readFileSync, writeFileSync } from "node:fs";

const FULL_DAYS = 30;
const KEEP_DAYS = 90;
const MAX_CHARS = 24_000;

const [file, todayArg] = process.argv.slice(2);
if (!file) throw new Error("usage: prune.mjs <file> [today]");
const today = Date.parse(todayArg ?? new Date().toISOString().slice(0, 10));
const age = (line) => {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(line);
  return m ? (today - Date.parse(m[1])) / 86_400_000 : 0;
};

// Sections by `## ` heading; entries by `### ` heading inside `## Entries`.
const text = readFileSync(file, "utf8");
const sections = [];
for (const line of text.split("\n")) {
  if (line.startsWith("## ") || sections.length === 0) sections.push({ head: line, body: [] });
  else sections.at(-1).body.push(line);
}
const named = (name) => sections.find((s) => s.head.trim().toLowerCase() === `## ${name}`);

const revisit = named("revisit");
if (revisit) revisit.body = revisit.body.filter((l) => !/^- \d{4}-\d{2}-\d{2}/.test(l) || age(l) <= KEEP_DAYS);

const entriesSection = named("entries");
let entries = [];
let lead = [];
if (entriesSection) {
  for (const line of entriesSection.body) {
    if (line.startsWith("### ")) entries.push({ head: line, body: [] });
    else if (entries.length) entries.at(-1).body.push(line);
    else lead.push(line);
  }
  const short = (e) => ({ ...e, body: e.body.filter((l) => /^- Outcome:/i.test(l)), short: true });
  entries = entries
    .filter((e) => age(e.head) <= KEEP_DAYS)
    .map((e) => (age(e.head) > FULL_DAYS ? short(e) : e))
    .sort((a, b) => age(a.head) - age(b.head));

  const render = () => {
    entriesSection.body = [
      ...lead,
      ...entries.flatMap((e) => [e.head, ...e.body.filter((l) => l.trim()), ""]),
    ];
    return sections.map((s) => [s.head, ...s.body].join("\n")).join("\n").replace(/\n{3,}/g, "\n\n");
  };
  // Over the size limit: shorten the oldest full entry, else drop the oldest entry; the newest is always kept.
  while (render().length > MAX_CHARS && entries.length > 1) {
    const i = entries.findLastIndex((e) => !e.short);
    if (i > 0) entries[i] = short(entries[i]);
    else entries.pop();
  }
  writeFileSync(file, render().trimEnd() + "\n");
} else {
  writeFileSync(file, sections.map((s) => [s.head, ...s.body].join("\n")).join("\n").trimEnd() + "\n");
}
