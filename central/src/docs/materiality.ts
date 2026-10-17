// What kind of edit a changed section is, from an exact word diff of its removed and added lines (vault: Docs
// Monitoring - Handoff, compressed-timeline test: about 38 % of section changes are not substantive). Deterministic,
// so trivial edits are dropped before any model call:
//   format       only whitespace, prose punctuation or case changed, or only MDX/HTML component tags added or removed
//   link         only link targets changed
//   renumber     only digits changed and no version did (generated "Defined in: file.ts:91" source links)
//   typo         at most four words changed, none of them technical or a word that can flip meaning
//   reword       prose changed with no technical token and no meaning-flipping word added or removed
//   substantive  anything else, including any change to code punctuation, every every pure addition or removal of more than a few words, and any word change
//                outside the Latin script (the meaning-flipping list is English)
import { wordDiff, type SectionChange } from "../collector/sections.ts";

export type EditKind = "format" | "link" | "renumber" | "typo" | "reword" | "substantive";

/** Words that can reverse or condition a statement: changing one is never a typo or a rewording. */
export const FLIPS: ReadonlySet<string> = new Set(
  ("not no never now longer default defaults enabled disabled enable disable required requires require optional deprecated removed remove must should only always instead unless except cannot can't won't will breaking renamed replaced minimum maximum supported unsupported before after earlier later stable experimental " +
    // Release status: "the current release" becoming "a release candidate" is four words that reverse the meaning (Prisma).
    "current latest candidate beta alpha preview canary nightly legacy recommended discouraged retired sunset").split(" "),
);

/** Tokens that name behaviour: inline code, flags, calls, dotted, camel or snake identifiers, versions. */
export function technical(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/`([^`]+)`/g)) out.add(m[1]!.trim());
  const bare = s.replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "]");
  for (const m of bare.matchAll(/(?<![\w-])--?[a-z][\w-]+|\b\w+\(\)|\b[a-z]+[A-Z]\w*|\b[A-Za-z]+_\w+|\b[A-Za-z_]\w*\.[A-Za-z_][\w.]*\b|\bv?\d+\.\d+(?:\.\d+)?\b/g)) out.add(m[0]);
  return out;
}

const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const unlink = (s: string) => s.replace(/\]\([^)]*\)/g, "]").replace(/<?https?:\/\/[^\s>)]+>?/g, "");
const versions = (s: string) => [...s.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)].map((m) => m[0]).sort().join(" ");

/** A line that is only an MDX or HTML component tag (`<AppOnly>`, `</Tabs>`): page markup, not content. */
const TAG_ONLY = /^\s*<\/?[A-Za-z][\w.-]*(\s[^<>]*)?\/?>\s*$/;
/** Punctuation that carries meaning in code: a change to it is never formatting (`{" "}` in a JSX example, Astro). */
const codePunct = (s: string) => unlink(s).replace(/[^{}[\]()<>=/\\|&$@]/g, "");

/**
 * Every changed number is a reference, not a quantity a reader acts on: a source position (`retryer.ts:91`, `#L91`),
 * a table cell, a percentage or a count (`208/208`). "Node 20" to "Node 22" is not a renumbering.
 */
function referencesOnly(rem: string, add: string): boolean {
  const parts = wordDiff(rem, add);
  let r = 0;
  let a = 0;
  for (const p of parts) {
    const side = p.removed ? rem : p.added ? add : undefined;
    const at = p.removed ? r : a;
    if (side !== undefined && /\d/.test(p.value)) {
      const before = side.slice(Math.max(0, at - 2), at);
      const after = side.slice(at + p.value.length, at + p.value.length + 1);
      const line = side.slice(side.lastIndexOf("\n", at) + 1);
      if (!/(:|#L|L)$/.test(before) && !/^[%/]/.test(after) && !/^\s*\|/.test(line)) return false;
    }
    if (!p.added) r += p.value.length;
    if (!p.removed) a += p.value.length;
  }
  return true;
}

export function editKind(c: Pick<SectionChange, "hunks">): EditKind {
  const side = (sign: string) => c.hunks.split("\n").filter((l) => l[0] === sign && !TAG_ONLY.test(l.slice(1))).map((l) => l.slice(1)).join("\n");
  const rem = side("-");
  const add = side("+");
  if (!rem.trim() && !add.trim()) return "format"; // only component tags were added or removed
  if (codePunct(add) !== codePunct(rem)) return "substantive";
  if (flat(add) === flat(rem)) return "format";
  if (flat(unlink(add)) === flat(unlink(rem))) return "link";
  if (flat(add).replace(/\d+/g, "#") === flat(rem).replace(/\d+/g, "#") && versions(add) === versions(rem) && referencesOnly(unlink(rem), unlink(add))) return "renumber";
  // The words that changed, from a word diff (not a bag of words: a moved word is not a change).
  const gone: string[] = [];
  const came: string[] = [];
  for (const p of wordDiff(flat(unlink(rem)), flat(unlink(add)))) {
    if (p.removed) gone.push(...p.value.split(/\s+/).filter(Boolean));
    else if (p.added) came.push(...p.value.split(/\s+/).filter(Boolean));
  }
  const t = { rem: technical(rem), add: technical(add) };
  const techChanged = [...t.add].some((x) => !t.rem.has(x)) || [...t.rem].some((x) => !t.add.has(x));
  const flips = [...gone, ...came].some((w) => FLIPS.has(w));
  if (techChanged || flips) return "substantive";
  // A changed number that is not a reference (those were renumberings above) is a quantity: "Node 20" to "Node 22".
  if ([...gone, ...came].some((w) => /\d/.test(w))) return "substantive";
  // The meaning-flipping words are English: a change in another script is never called a typo or a rewording.
  if ([...gone, ...came].some((w) => /[^\p{Script=Latin}\p{N}_]/u.test(w))) return "substantive";
  if (!rem.trim() || !add.trim()) return gone.length + came.length <= 4 ? "typo" : "substantive"; // pure addition or removal
  if (gone.length + came.length <= 4) return "typo";
  return "reword";
}
