// Step 11 of the advisories stage (advisories.ts): a release-notes item under a heading that names other packages of
// the repository is a change of those packages, so the record's releases name them instead of the technology's
// components. The edge then applies it only where the repository uses one of them.
//
// React's release notes list Server Components items under "## React Server Components"; they change
// react-server-dom-webpack and its siblings, not `react`, and a client-only app installs none of them. Rule, every
// run, deterministic, no model call:
//   - the record is active, holds release-notes evidence only and none of this technology's advisories;
//   - for every item it comes from (`items.itemOf`), the nearest heading above it that names any package decides
//     (innermost first): a heading names a package when its words are the package's name (`React DOM`, `react-dom`;
//     `@scope/name@1.2.3` read as the name), or, at two or more words, when the package's registry description starts
//     with them (`React Server Components bindings for DOM using Webpack`). The candidates are the packages published
//     from the technology's repository (ecosystems.ts `repositoryPackages`, read once a week per technology);
//   - a heading naming one of the technology's components says the item is this technology's: nothing changes. Every
//     item must be under a heading naming other packages, the same ones;
//   - then each release of the record is given once per named package (same version and line) in place of the
//     components (history `other-package-section`); a record that stops qualifying gets the components back
//     (`other-package-section-restored`).
// Unknown keeps the record as it is: a body not stored, an item that cannot be located, an ecosystem without the hook,
// a registry that cannot be read (offline with nothing cached).
import { join } from "node:path";
import { canonicalPurl, ecosystemOf, type RegistryPackage } from "./ecosystems.ts";
import { itemOf } from "./items.ts";
import { centralDir } from "./paths.ts";
import { applyChange, type Release, type StoredRecord, type TechStore } from "./store.ts";
import type { Technology } from "./technologies.ts";
import { readJson, writeAtomic } from "./util.ts";

export const OTHER_SECTION = "other-package-section";
export const OTHER_SECTION_RESTORED = "other-package-section-restored";

/** A heading as plain words: links and markup removed, a trailing version or date dropped. */
export function headingWords(h: string): string {
  return h
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\(([^)]*)\)\s*$/, "")
    .replace(/(@|\s+v?)\d+(?:\.\d+)+(?:[-+][\w.]+)?\s*$/i, "")
    .replace(/[^\p{L}\p{N}@/._ -]+/gu, " ")
    .replace(/[:\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Whether a heading (`headingWords`) names a package: its words are the package's name, or (two or more words) its
 * registry description starts with them and goes on with a word that does not continue a capitalised name. "React
 * Server Components" names `React Server Components bindings for DOM using Webpack`; "React Server" does not (the
 * name goes on: "Components").
 */
export function headingNames(heading: string, p: Pick<RegistryPackage, "name" | "description">): boolean {
  const h = slug(heading);
  if (!h) return false;
  if (h === slug(p.name) || h === slug(p.name.replace(/^@[^/]+\//, ""))) return true;
  const words = heading.toLowerCase().split(" ");
  if (words.length < 2) return false;
  const d = p.description.replace(/\s+/g, " ").trim();
  const head = words.join(" ");
  if (!d.toLowerCase().startsWith(head)) return false;
  const rest = d.slice(head.length);
  return !/^[\p{L}\p{N}]/u.test(rest) && !/^ \p{Lu}/u.test(rest);
}

const FRESH_MS = 7 * 24 * 3600 * 1000;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/**
 * The packages published from the technology's repository (`repositoryPackages`), cached per technology for 7 days
 * (offline: the cache only). Undefined when they cannot be known (no hook, nothing cached offline, a registry that
 * cannot be read).
 */
export async function repositoryPackages(t: Technology, opts: { offline?: boolean; refresh?: boolean } = {}): Promise<RegistryPackage[] | undefined> {
  const hook = ecosystemOf(t.components[0] ?? "").repositoryPackages;
  if (!hook) return undefined;
  const file = join(centralDir(), "advisories", t.id, "repository-packages.json");
  const cached = readJson<{ checked: string; packages: RegistryPackage[] }>(file);
  const fresh = cached && Date.now() - Date.parse(cached.checked) < FRESH_MS;
  if (cached && (opts.offline || (fresh && !opts.refresh))) return cached.packages;
  if (opts.offline) return undefined;
  try {
    const packages = await hook(t);
    if (!packages) return undefined;
    writeAtomic(file, JSON.stringify({ checked: stamp(), packages }, null, 1) + "\n");
    return packages;
  } catch (e) {
    console.error(`advisories: ${t.id}: the repository's packages are unavailable (${e instanceof Error ? e.message : e}); sections not attributed this run`);
    return undefined;
  }
}

/** The packages a heading (`headingWords`) names among `packages` (canonical package URLs, sorted). */
export function headingPackages(heading: string, packages: readonly RegistryPackage[]): string[] {
  return packages.filter((p) => headingNames(heading, p)).map((p) => canonicalPurl(p.purl)).sort();
}

/** The releases of `r` given once per package in `purls` (each version and line kept). */
function releasesFor(r: StoredRecord, purls: readonly string[]): Release[] {
  const byVersion = new Map<string, Release>();
  for (const x of r.releases) if (!byVersion.has(x.version)) byVersion.set(x.version, x);
  return [...purls].sort().flatMap((component) => [...byVersion.values()].map((x) => ({ ...x, component })));
}

/** A package URL's name as written in code (`react-day-picker`, `@scope/name`). */
const npmLikeName = (purl: string): string => decodeURIComponent(canonicalPurl(purl).replace(/^pkg:[^/]+\//, ""));

/** Whether text writes `name` as code: in backticks or quotes, alone or with a subpath (`name/x`). */
export function namesInCode(text: string, name: string): boolean {
  const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[\`'"]${n}(?:/[^\`'"\\s]*)?[\`'"]`, "i").test(text);
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Step 11, given the packages published from the technology's repository (`repositoryPackages`). Returns the records
 * given other packages, and those given the components back.
 */
export async function attributeSections(
  t: Technology,
  s: TechStore,
  releases: ReadonlyArray<{ version: string; url: string }>,
  body: (version: string) => string | undefined,
  packages: readonly RegistryPackage[],
  shipped: (r: StoredRecord) => Promise<Set<string> | undefined>,
): Promise<{ moved: Array<{ record: string; packages: string[]; heading: string }>; restored: string[] }> {
  const components = t.components.map(canonicalPurl);
  const names = components.map(npmLikeName).filter((n) => n.length >= 2);
  const byUrl = new Map(releases.map((r) => [r.url, r]));
  const memo = new Map<string, string[]>();
  const ask = (h: string) => {
    if (!memo.has(h)) memo.set(h, headingPackages(h, packages));
    return memo.get(h)!;
  };
  const out = { moved: [] as Array<{ record: string; packages: string[]; heading: string }>, restored: [] as string[] };
  for (const r of Object.values(s.records).sort((a, b) => a.id.localeCompare(b.id))) {
    if (r.status !== "active" || !r.releases.length) continue;
    // The packages the record is about: false (this technology's), the packages and the deciding heading, or undefined.
    const verdict = async (): Promise<{ packages: string[]; heading: string } | false | undefined> => {
      if (r.advisories?.length || !r.evidence.length) return false;
      let found: { packages: string[]; heading: string } | undefined;
      for (const e of r.evidence) {
        if ((e.kind ?? "release_notes") !== "release_notes") return false;
        const rel = byUrl.get(e.url);
        const b = rel && body(rel.version);
        if (b === undefined) return undefined;
        const item = itemOf(b, e.quote);
        if (!item) return undefined;
        // An item that writes one of the technology's packages as code (`react-day-picker/hijri`) is its change.
        if (names.some((n) => namesInCode(item.text, n))) return false;
        let here: { packages: string[]; heading: string } | false = false;
        for (const raw of [...item.headings].reverse()) {
          const h = headingWords(raw);
          if (!h) continue;
          const p = ask(h);
          if (!p.length) continue;
          here = p.some((x) => components.includes(x)) ? false : { packages: p, heading: h };
          break;
        }
        if (!here) return false;
        if (found && !sameSet(found.packages, here.packages)) return false;
        found = here;
      }
      if (!found) return false;
      // A package the release installs for its users (a dependency of a component) reaches them with the bump.
      const deps = await shipped(r);
      if (!deps) return undefined;
      return found.packages.some((p) => deps.has(p)) ? false : found;
    };
    const v = await verdict();
    if (v === undefined) continue;
    const current = [...new Set(r.releases.map((x) => canonicalPurl(x.component)))].sort();
    if (v) {
      if (sameSet(current, v.packages)) continue;
      const detail = `under the release-notes heading "${v.heading}", which names ${v.packages.join(", ")} of this repository and none of this technology's packages: their change (was ${current.join(", ")})`;
      applyChange(r, { releases: releasesFor(r, v.packages) }, OTHER_SECTION, { detail });
      out.moved.push({ record: r.id, packages: v.packages, heading: v.heading });
    } else if (!sameSet(current, components) && r.history.some((x) => x.action === OTHER_SECTION)) {
      applyChange(r, { releases: releasesFor(r, components) }, OTHER_SECTION_RESTORED, { detail: "no longer under a heading naming other packages: this technology's packages again" });
      out.restored.push(r.id);
    }
  }
  return out;
}
