// Per-advisory affected APIs (known bugs 3.3): what code must use to reach an advisory's vulnerability, read once per
// advisory from its text (summary and details) by the extraction model, and published in the technology's index
// (`TechIndex::advisory_apis`). The edge looks for them where no record locates the advisory: a lockfile advisory whose
// fix is outside the catalog window or not released at all (zod's CVE-2023-54404 names `z.array()` only in its
// details, so the edge, reading the one-line summary, said "affected path not checked"), and a record made from the
// advisory alone, which has no terms.
//
// Cost: one call per advisory, cached by request, so an advisory is read once until its text changes. The request is
// the prompt below (about 250 tokens) and the advisory's text cut at MAX_TEXT characters (median 893 characters on
// the full store, 4,775 advisories); the answer is a short JSON array. eval/advisory-apis/RESULTS.md has the measured
// tokens and dollars.
import type { Advisory } from "./advisories.ts";
import { extractLlm, parseJson } from "./llm.ts";
import type { StoredRecord, TechStore } from "./store.ts";
import { applyChange, union } from "./store.ts";
import { pool } from "./util.ts";

/** Advisory text read, in characters (summary first, then details): enough for the description, not the PoC. */
export const MAX_TEXT = 4_000;
/** At most this many APIs per advisory: more is a description of the package, not an affected path. */
export const MAX_APIS = 6;

export const APIS_PROMPT = `You read a security advisory for the package %PACKAGE% and name the package's own APIs that code must use to be affected.
Output only a JSON array of strings, no prose.

Name each as code writes it and as the advisory writes it: a function or method (\`serveStatic\`, \`z.array\`), a class, an
option or configuration key (\`followRedirects\`), a command-line flag (\`--inspect\`), an environment variable, or a file
name the package reads. Copy each name exactly from the advisory text.

Leave out:
- the package's name itself, and anything that just imports or installs it;
- APIs the advisory names as the fix, a workaround or a mitigation (an option that limits size, a patched function);
- internal functions users never call, language or runtime built-ins (\`JSON.parse\`, \`require\`), and names that
  appear only in proof-of-concept code;
- general descriptions ("the parser", "user input").
At most ${MAX_APIS}. If the advisory names no such API (any use of the package is affected, or it names none), output [].

Advisory:
%TEXT%`;

/** The text an advisory is read from: its summary, its details, then the details other databases' entries of the same
 * advisory give (`others`, advisories.ts `osvTexts`), cut at MAX_TEXT. */
export function advisoryText(a: Pick<Advisory, "summary" | "details">, others: readonly string[] = []): string {
  const parts = [a.summary, a.details ?? ""].map((x) => x.trim()).filter(Boolean);
  for (const o of others) if (o.trim() && !parts.includes(o.trim())) parts.push(o.trim());
  return parts.join("\n\n").slice(0, MAX_TEXT);
}

/** The details of advisory `a`'s entries in `texts` (by upper-cased entry id: its own and its aliases'). */
const othersOf = (a: Pick<Advisory, "id" | "aliases">, texts?: ReadonlyMap<string, readonly string[]>): string[] =>
  [...new Set([a.id, ...a.aliases].flatMap((id) => texts?.get(id.toUpperCase()) ?? []))];

const bare = (s: string) => s.trim().replace(/^`+|`+$/g, "").replace(/\(\s*\)$/, "").trim();

/**
 * The answer's names that the advisory's text writes (case-sensitive, with or without a trailing `()` or backticks),
 * that are not the package's name, at most MAX_APIS: a name the model made up locates nothing real.
 */
export function groundedApis(answer: unknown, text: string, packageNames: readonly string[]): string[] {
  if (!Array.isArray(answer)) return [];
  const pkg = new Set(packageNames.map((p) => p.toLowerCase()));
  const out: string[] = [];
  for (const x of answer) {
    if (typeof x !== "string") continue;
    const name = bare(x);
    if (name.length < 2 || name.length > 80 || /\s/.test(name)) continue;
    if (pkg.has(name.toLowerCase()) || !text.includes(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_APIS) break;
  }
  return out;
}

/** One advisory's affected APIs: one cached extraction-model call; [] when the advisory names none or the call fails. */
export async function advisoryApis(a: Advisory, packageNames: readonly string[], ask: typeof extractLlm = extractLlm, others: readonly string[] = []): Promise<string[]> {
  const text = advisoryText(a, others);
  if (!text.trim()) return [];
  const prompt = APIS_PROMPT.replace("%PACKAGE%", packageNames[0] ?? "").replace("%TEXT%", text);
  const answer = await ask(prompt, (t) => {
    const v = parseJson(t, "array");
    return Array.isArray(v) ? v : undefined;
  });
  return groundedApis(answer, text, packageNames);
}

/** The npm/PyPI-style names of package URLs (`pkg:npm/%40hono/node-server` → `@hono/node-server`). */
export function packageNamesOf(purls: readonly string[]): string[] {
  return [...new Set(purls.map((p) => decodeURIComponent(p.replace(/^pkg:[^/]+\//, "").replace(/@[^@/]*$/, ""))).filter(Boolean))];
}

/** A record made from an advisory alone: every evidence is the advisory (no release-notes item describes it). */
const advisoryOnly = (r: StoredRecord) => r.evidence.length > 0 && r.evidence.every((e) => e.kind === "advisory");

/**
 * The store's affected APIs per advisory (`TechStore.advisoryApis`, published in the index), for every advisory given
 * that names one; a record made from an advisory alone with no terms gets them as terms (a label change), so the edge
 * can look for its affected path. Returns how many advisories name an API and how many records got terms.
 */
export async function attachAdvisoryApis(
  s: TechStore,
  advisories: readonly Advisory[],
  packageNames: readonly string[],
  texts?: ReadonlyMap<string, readonly string[]>,
  alias?: (id: string) => Promise<string | undefined>,
  ask: typeof extractLlm = extractLlm,
): Promise<{ advisories: number; named: number; records: number }> {
  const found = await pool([...advisories], 6, async (a) => {
    const others = othersOf(a, texts);
    const first = await advisoryApis(a, packageNames, ask, others);
    if (first.length || !alias) return first;
    // Naming none, it is read once more with its aliases' own entries (the CVE record OSV converted from the CVE list
    // can name the API its GHSA entry leaves out), when the package query did not return them.
    const unseen = a.aliases.filter((id) => !texts?.has(id.toUpperCase()));
    const more = (await Promise.all(unseen.map(alias))).filter((x): x is string => !!x && !others.includes(x));
    return more.length ? advisoryApis(a, packageNames, ask, [...others, ...more]) : first;
  });
  const entries: NonNullable<TechStore["advisoryApis"]> = advisories
    .map((a, i) => ({ ids: [a.id, ...a.aliases.filter((x) => x !== a.id)], apis: found[i]! }))
    .filter((e) => e.apis.length);
  s.advisoryApis = entries.sort((x, y) => x.ids[0]!.localeCompare(y.ids[0]!));
  const by = new Map(entries.flatMap((e) => e.ids.map((id) => [id.toUpperCase(), e.apis] as const)));
  let records = 0;
  for (const r of Object.values(s.records)) {
    if (r.status !== "active" || r.terms.length || !advisoryOnly(r)) continue;
    const apis = (r.advisories ?? []).flatMap((x) => [x.id, ...x.aliases]).map((id) => by.get(id.toUpperCase()) ?? []).reduce<string[]>((acc, x) => union(acc, x), []);
    if (apis.length && applyChange(r, { terms: apis }, "advisory-apis", { detail: "affected APIs named in the advisory" }).label) records++;
  }
  return { advisories: advisories.length, named: entries.length, records };
}
