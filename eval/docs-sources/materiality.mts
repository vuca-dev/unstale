// What kind of edit a changed section is, for the materiality measurement (eval only; the module has no gate yet):
//   format       only whitespace, punctuation or case changed
//   link         only link targets changed
//   renumber     only numbers changed and no version did (generated "Defined in: file.ts:91" source links)
//   typo         at most four words changed
//   reword       prose changed with no code, flag, identifier or version added or removed (editorial)
//   substantive  anything else

export type Noise = "format" | "link" | "renumber" | "typo" | "reword" | "substantive";
export function noiseOf(hunks: string): Noise {
  const side = (c: string) => hunks.split("\n").filter((l) => l[0] === c).map((l) => l.slice(1)).join(" ");
  const add = side("+");
  const rem = side("-");
  const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (flat(add) === flat(rem)) return "format";
  const unlink = (s: string) => s.replace(/\]\([^)]*\)/g, "]").replace(/<?https?:\/\/[^\s>)]+>?/g, "");
  if (flat(unlink(add)) === flat(unlink(rem))) return "link";
  const versions = (x: string) => [...x.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)].map((m) => m[0]).sort().join(" ");
  if (flat(add).replace(/\d+/g, "#") === flat(rem).replace(/\d+/g, "#") && versions(add) === versions(rem)) return "renumber";
  const words = (s: string) => flat(unlink(s)).split(" ").filter(Boolean);
  const count = new Map<string, number>();
  for (const w of words(add)) count.set(w, (count.get(w) ?? 0) + 1);
  for (const w of words(rem)) count.set(w, (count.get(w) ?? 0) - 1);
  const changed = [...count.values()].reduce((s, n) => s + Math.abs(n), 0);
  if (rem.trim() && add.trim() && changed <= 4) return "typo";
  // Prose reworded with no code, flag, identifier or version added or removed: editorial, not a behaviour change.
  const a = technical(add), r = technical(rem);
  return [...a].some((x) => !r.has(x)) || [...r].some((x) => !a.has(x)) ? "substantive" : "reword";
}

/** Tokens that name behaviour: inline code, flags, calls, dotted or camel/snake identifiers, version numbers. */
export function technical(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/`([^`]+)`/g)) out.add(m[1]!.trim());
  const bare = s.replace(/`[^`]*`/g, " ").replace(/\]\([^)]*\)/g, "]");
  for (const m of bare.matchAll(/(?<![\w-])--?[a-z][\w-]+|\b\w+\(\)|\b[a-z]+[A-Z]\w*|\b[A-Za-z]+_\w+|\b[A-Za-z_]\w*\.[A-Za-z_][\w.]*\b|\bv?\d+\.\d+(?:\.\d+)?\b/g)) out.add(m[0]);
  return out;
}
