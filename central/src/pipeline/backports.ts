// Step 10 of the advisories stage (advisories.ts): one change shipped on several release lines is one record.
//
// A maintained older line gets the same fix as the current one, published the same day or later, with the same item in
// its notes ("Add more DoS mitigations to Server Actions (#35632)" in react 19.0.4, 19.1.5 and 19.2.4). Ingest judges
// each release's items against at most 8 retrieved candidates, so the twin on another line can be missed, and each
// line then has a record of its own: the bump digest counts the change once per line. Records are backport twins when
//   - each is active, holds release-notes evidence only and no advisory (advisory twins merge in step 7's twin pass),
//     and they agree on `breaking`;
//   - their release-notes quotes are pairwise near-identical (`nearIdenticalQuote`, either direction);
//   - every item they come from (`items.itemOf`) cites an upstream change (a pull request or commit, `changeRefs`),
//     and all of them cite one in common: the same upstream change, not two changes worded alike;
//   - no two of them have a release on the same derived line (two items on one line are two changes, or a re-listing).
// A group merges into its first id in natural order (`mergeInto`, history kept). Deterministic, no model call, no
// network; a release body that is not stored leaves its records out.
import { changeRefs, itemOf } from "./items.ts";
import { lineFn } from "./lines.ts";
import { nearIdenticalQuote } from "./match.ts";
import { mergeInto, type StoredRecord, type TechStore } from "./store.ts";

const naturalId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

export interface BackportMerge {
  from: string;
  into: string;
  refs: string[];
}

/** Each candidate's quotes, derived lines and the refs every one of its items cites (undefined: not a candidate). */
function profile(
  r: StoredRecord,
  byUrl: ReadonlyMap<string, { version: string }>,
  body: (version: string) => string | undefined,
  lineOf: (v: string) => string,
): { quotes: string[]; lines: Set<string>; refs: Set<string> } | undefined {
  if (r.status !== "active" || r.advisories?.length || !r.evidence.length || !r.releases.length) return undefined;
  let refs: Set<string> | undefined;
  for (const e of r.evidence) {
    if ((e.kind ?? "release_notes") !== "release_notes") return undefined;
    const rel = byUrl.get(e.url);
    const b = rel && body(rel.version);
    const item = b === undefined ? undefined : itemOf(b, e.quote);
    if (!item) return undefined;
    const own = changeRefs(item.text);
    refs = refs ? new Set([...refs].filter((x) => own.has(x))) : own;
    if (!refs.size) return undefined;
  }
  return { quotes: r.evidence.map((e) => e.quote), lines: new Set(r.releases.map((x) => lineOf(x.version))), refs: refs! };
}

/** The backport-twin groups of a store (sorted, each sorted by natural id), without merging. */
export function findBackportTwins(
  s: TechStore,
  releases: ReadonlyArray<{ version: string; url: string }>,
  body: (version: string) => string | undefined,
): Array<{ records: string[]; refs: string[] }> {
  const lineOf = lineFn(s);
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const recs = Object.values(s.records).sort((a, b) => naturalId(a.id, b.id));
  const prof = new Map<string, NonNullable<ReturnType<typeof profile>>>();
  for (const r of recs) {
    const p = profile(r, byUrl, body, lineOf);
    if (p) prof.set(r.id, p);
  }
  const near = (a: string[], b: string[]) => a.some((x) => b.some((y) => nearIdenticalQuote(x, y) || nearIdenticalQuote(y, x)));
  const twin = (a: StoredRecord, b: StoredRecord): boolean => {
    const x = prof.get(a.id)!;
    const y = prof.get(b.id)!;
    return (
      a.breaking === b.breaking &&
      [...x.refs].some((r) => y.refs.has(r)) &&
      ![...x.lines].some((l) => y.lines.has(l)) &&
      near(x.quotes, y.quotes)
    );
  };
  const cands = recs.filter((r) => prof.has(r.id));
  // Groups in which every pair is twins (near-identical quotes are not transitive): each record, in natural order,
  // joins the first group all of whose members it is a twin of, else starts one.
  const groups: StoredRecord[][] = [];
  for (const r of cands) {
    const g = groups.find((g) => g.every((o) => twin(o, r)));
    if (g) g.push(r);
    else groups.push([r]);
  }
  const out: Array<{ records: string[]; refs: string[] }> = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const refs = [...group.map((g) => prof.get(g.id)!.refs).reduce((a, b) => new Set([...a].filter((x) => b.has(x))))].sort();
    if (!refs.length) continue;
    out.push({ records: group.map((g) => g.id), refs });
  }
  return out;
}

/** Step 10: merges every backport-twin group into its first record. */
export function mergeBackports(
  s: TechStore,
  releases: ReadonlyArray<{ version: string; url: string }>,
  body: (version: string) => string | undefined,
): BackportMerge[] {
  const out: BackportMerge[] = [];
  for (const g of findBackportTwins(s, releases, body)) {
    const [into, ...rest] = g.records;
    for (const from of rest) {
      mergeInto(s, from, into!, `backport twin of ${into} (${g.refs.join(", ")} on every item; near-identical release-notes quotes on other release lines)`);
      out.push({ from, into: into!, refs: g.refs });
    }
  }
  return out;
}
