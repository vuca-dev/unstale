// The upgrade guides of a technology, found by the docs module for any technology: the pages its listing names as
// guides (`upgrading/version-16`, `upgrade-prisma-orm/v7`, or an unnumbered `migration-guide` read from its text), for
// the current and the previous major, as the site's own copy. Replaces the hand-kept per-technology table of guide
// paths. A guide in another variant's, language's or product's section of a shared site (Android's on Sentry's site for
// the Python SDK, Vue's on TanStack's for React Query, Go's on connectrpc.com for the npm package, Hocuspocus's on
// tiptap.dev for a Tiptap extension), for another named thing's version (`migrate-to-config-v2`), or on a docs
// generator's own site (docusaurus.io for a package built with it) is not the technology's (`ownGuide`).
import { join } from "node:path";
import type { HttpClient } from "../collector/http.ts";
import { readJson } from "../pipeline/util.ts";
import { guideCandidate } from "./attribute.ts";
import { docsDir, docsStore, latestVersion, refresh, type Source } from "./monitor.ts";

export interface CurrentGuide {
  url: string;
  major: string;
  text: string;
  /** `sha256:<hex>` of the text as stored. */
  snapshot: string;
}

interface StoredState {
  sites?: Array<{ site: string }>;
  pages: Record<string, { guideMajor?: string; watch: { id: string } }>;
}

/** The languages a package ecosystem's docs name it by: a site's `/python/` section is the PyPI package's. */
const ECOSYSTEM: Record<string, string[]> = { npm: ["javascript", "js", "node", "nodejs", "typescript", "ts"], pypi: ["python", "py"], cargo: ["rust"] };
/**
 * Every ecosystem's languages and the server frameworks that belong to one language: on a site that splits its docs
 * by language (`/docs/go/`, `/docs/node/`; `/framework-integration/django/`, `/laravel/`) a section named by another
 * ecosystem's is not the package's. Platforms (`android`, `ios`) are not here: a React Native package's docs have them.
 */
const LANGUAGES: Record<string, string[]> = {
  npm: [...ECOSYSTEM.npm!, "deno", "bun"],
  pypi: [...ECOSYSTEM.pypi!, "django", "flask", "fastapi"],
  cargo: ECOSYSTEM.cargo!,
  golang: ["go", "golang"],
  maven: ["java", "kotlin", "scala", "spring"],
  gem: ["ruby", "rails"],
  composer: ["php", "laravel", "symfony"],
  nuget: ["dotnet", "csharp"],
  hex: ["elixir", "erlang"],
  pub: ["dart", "flutter"],
  swift: ["swift", "objc"],
};
const JOINERS = new Set(["for", "and", "the", "with", "of", "in", "to", "on"]);
/** Words that say a page or section is about upgrading, not what it upgrades. */
const GUIDE_WORDS = new Set(["upgrade", "upgrades", "upgrading", "migrate", "migrating", "migration", "migrations", "guide", "guides", "path", "from", "version", "versions", "update", "updating", "package", "sdk", "client", "library", "integration"]);
/** The site generators whose own site documents the generator: a package whose docs entry is docusaurus.io is built with it, not it. */
const GENERATORS = new Set(["docusaurus", "vitepress", "vuepress", "mkdocs", "sphinx", "mintlify", "mdbook", "nextra", "fumadocs", "antora", "docsify", "typedoc", "gitbook", "jekyll", "hugo"]);
/** A docs root's own first pages: a section holding them is a product's documentation, not a topic of one. */
const LANDING = /^(getting-started|get-started|introduction|intro|overview|installation|install|quickstart|quick-start)$/;
/** Segments that only name a release of the docs (`latest`, `2.12`, `v6.x`): two such are the same section. */
const RELEASE = /^(v?\d+(\.\d+)*(\.x)?|latest|stable|current|next|main|master|dev|nightly|canary|beta)$/;
/** A catalogue of integrations (one section per destination, source or service) has at least this many sections. */
const CATALOGUE = 20;

/** The words of a path segment, host or package name; numbers and version labels (`v2`, `v6x`) are not words. */
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !/^\d+$/.test(w) && !/^v\d+x?$/.test(w));
const segments = (u: string): string[] => new URL(u).pathname.toLowerCase().split("/").filter(Boolean);

/**
 * Whether a listed upgrade guide is the technology's own. Deterministic: the listing, the docs entries and the package
 * URLs only. A guide is another thing's when
 * 1. it sits in another variant's section of a shared site. A site gives each variant (platform, language,
 *    framework, product) a section of its own: `/platforms/<python|android|…>/`, `/framework/<react|vue|…>/`,
 *    `/drivers/<node|java|…>/`. When a section beside the guide's is named by the technology (all of its words are the
 *    technology's package words, its ecosystem's language or the site's own name, and one is the package's or the
 *    language's) and is known to be the technology's (it holds upgrade guides, or the technology's docs entry lies in
 *    it), a guide under a sibling section that the technology does not name is that other variant's. The package's own
 *    words are tried before its ecosystem's (`/react/` over `/node/` for a React package);
 * 2. its title names its target as another thing's version (`migrate-to-config-v2`, `upgrade-to-grid-v2`,
 *    `material-ui-v5-to-v6`, `js-v4-to-v5` for the Python SDK) that shares no word with the technology;
 * 3. a section on its path names another ecosystem's language (`/docs/go/` for an npm package, `/django/` for the
 *    JavaScript client) on a site that splits its docs by language (another section beside it names one too);
 * 4. it is on a docs generator's own site (docusaurus.io) and the technology is not that generator: the package's docs
 *    were built with it or link to it;
 * 5. it is in another product's docs on a multi-product site: the technology's listed docs entries lie in other
 *    sections, and the section where the guide's path parts from theirs (release segments such as `latest` and `2.12`
 *    count as the same) is not named by the technology and is a product's docs (it has its own getting-started,
 *    overview or installation pages, or holds upgrade guides while the entry's section holds its own):
 *    `/hocuspocus/` for a Tiptap extension, `/react-native-gesture-handler/` for Reanimated, `/docs/ai/` for Pydantic,
 *    `/tools/bolt-js/` for `@slack/types`. A section holding the same series of guides as the entry's (`pages/` and
 *    `app/` on the Next.js site, `guides/upgrading/version-N` in both) is the same product's docs in two halves;
 * 6. it is in one entry of a catalogue of integrations (`/destinations/streaming-destinations/<service>/`, one of at
 *    least CATALOGUE sections) that the technology does not name and its docs entries do not lie in.
 */
export function ownGuide(url: string, ctx: GuideContext): boolean {
  return !otherThing(url, ctx);
}

export interface GuideContext {
  purls: readonly string[];
  pages: readonly string[];
  guides: ReadonlySet<string>;
  entries: readonly string[];
}

/** Which of `ownGuide`'s rules finds the guide another thing's, if any. */
export function otherThing(url: string, ctx: GuideContext): "version" | "generator" | "language" | "variant" | "product" | "catalogue" | undefined {
  const host = new URL(url).hostname;
  const site = new Set(words(host));
  const name = new Set<string>();
  const lang = new Set<string>();
  const own = new Set<string>();
  for (const purl of ctx.purls) {
    const [, type, rest] = /^pkg:(\w+)\/(.+)$/.exec(purl) ?? [];
    for (const w of words(decodeURIComponent(rest ?? ""))) name.add(w);
    for (const w of ECOSYSTEM[type ?? ""] ?? []) lang.add(w);
    for (const w of LANGUAGES[type ?? ""] ?? []) own.add(w);
  }
  for (const w of name) lang.delete(w);
  const known = (w: string) => name.has(w) || lang.has(w) || site.has(w) || JOINERS.has(w);
  /** A segment the technology names: every word its own, one of them from `by` and not the site's name. */
  const names = (v: string, by: ReadonlySet<string>) => {
    const ws = words(v);
    return ws.length > 0 && ws.every(known) && ws.some((x) => by.has(x) && !site.has(x));
  };
  const g = segments(url);
  const leaf = g.at(-1) ?? "";
  // 2. Another thing's version: `…-to-<words>-vN`, or `<words>[-vN]-to-vM`.
  const target = /(?:^|-)to-([a-z][a-z-]*?)-v?\d+(?:[.-]\d+)*(?:\.x)?$/.exec(leaf)?.[1] ?? /^([a-z][a-z-]*?)(?:-v?\d+(?:[.-]\d+)*)?-to-v?\d+(?:[.-]\d+)*(?:\.x)?$/.exec(leaf)?.[1];
  const targetWords = words(target ?? "").filter((w) => !GUIDE_WORDS.has(w) && !JOINERS.has(w));
  if (targetWords.length && !targetWords.some((w) => name.has(w) || lang.has(w) || site.has(w))) return "version";
  // 4. A docs generator's own site.
  const label = host.replace(/^(www|docs)\./, "").split(".");
  if (label.length === 2 && words(label[0]!).some((w) => GENERATORS.has(w) && !name.has(w))) return "generator";
  const sameHost = (u: string) => {
    try {
      return new URL(u).hostname === host;
    } catch {
      return false;
    }
  };
  const listed = ctx.pages.filter(sameHost).map((u) => ({ s: segments(u), guide: ctx.guides.has(u) || guideCandidate(u) }));
  const entries = ctx.entries.filter(sameHost).map(segments);
  const under = (s: string[], i: number) => g.slice(0, i).every((x, k) => s[k] === x);
  /** The segments beside the guide's at position i: those of the listed pages under the same parent. */
  const beside = (i: number) => new Set([g[i]!, ...listed.filter((p) => p.s.length > i && under(p.s, i)).map((p) => p.s[i]!)]);
  // 3. Another ecosystem's language, on a site split by language.
  const languages = new Set(Object.values(LANGUAGES).flat());
  const foreign = (v: string) => {
    const ws = words(v).filter((w) => !GUIDE_WORDS.has(w) && !JOINERS.has(w));
    return ws.length > 0 && ws.every((w) => languages.has(w) && !own.has(w) && !name.has(w));
  };
  const language = (v: string) => words(v).some((w) => languages.has(w));
  for (let i = 0; i < g.length; i++) if (foreign(g[i]!) && [...beside(i)].some((v) => v !== g[i] && language(v))) return "language";
  // 1. Another variant's section.
  for (let i = 0; i < g.length - 1; i++) {
    const w = g[i]!;
    const inside = listed.filter((p) => p.s.length > i + 1 && under(p.s, i));
    const sections = new Set([w, ...inside.map((p) => p.s[i]!), ...entries.filter((e) => e.length > i && under(e, i)).map((e) => e[i]!)]);
    if (sections.size < 2) continue;
    // The package's words first, then its ecosystem's. A docs entry marks a section the package names only when it lies
    // below it (`/sdk-for-javascript/v3/…`, not the single page `/material-icons/`); the language's, at it (`/python/`).
    for (const [by, depth] of [[name, i + 2], [lang, i + 1]] as const) {
      const ours = new Set([...sections].filter((v) => names(v, by)));
      if (!ours.size) continue;
      if (ours.has(w) || names(w, name)) break;
      if (inside.some((p) => ours.has(p.s[i]!) && p.guide) || entries.some((e) => e.length >= depth && under(e, i) && ours.has(e[i]!))) return "variant";
      break;
    }
  }
  // 5. Another product's docs root beside the entry's section.
  const inTree = (s: string[], t: string[]) => s.length > t.length && t.every((x, k) => s[k] === x);
  const children = (t: string[]) => new Set(listed.filter((p) => inTree(p.s, t)).map((p) => p.s[t.length]!));
  const product = (i: number, e: string[]): boolean | undefined => {
    const t = g.slice(0, i + 1);
    const theirs = e.slice(0, i + 1);
    const at = e.join("/");
    if (!listed.some((p) => inTree(p.s, theirs) && p.s.join("/") !== at)) return undefined; // no listed docs there (a stylesheet under `/dist/`): no evidence
    // The entry's section holding the same series of guides (the same path but for its numbers) is the same product's
    // docs in two halves (Next.js's `pages/` and `app/` routers), not two products.
    const series = (s: string[]) => s.slice(i + 1).join("/").replace(/\d+/g, "#");
    const rest = series(g);
    if (listed.some((p) => inTree(p.s, theirs) && series(p.s) === rest)) return false;
    // A product's own docs: its own first pages, or its own upgrade guides beside the entry section's own.
    return listed.some((p) => inTree(p.s, t) && p.s.slice(i + 1, i + 4).some((x) => LANDING.test(x))) || listed.some((p) => p.guide && inTree(p.s, theirs));
  };
  const elsewhere = entries.map((e): boolean | undefined => {
    let i = 0;
    while (i < e.length && i < g.length && (e[i] === g[i] || (RELEASE.test(e[i]!) && RELEASE.test(g[i]!)))) i++;
    if (i >= e.length || i >= g.length - 1) return false; // the guide lies in the entry's tree, or parts from it only at its own page
    if (names(g[i]!, name) || names(g[i]!, lang) || words(g[i]!).every((w) => site.has(w))) return false;
    return product(i, e);
  });
  const votes = elsewhere.filter((v) => v !== undefined);
  if (votes.length && votes.every(Boolean)) return "product";
  // 6. One entry of a catalogue of integrations.
  const p = g.slice(0, -1).findLastIndex((x) => words(x).some((w) => !GUIDE_WORDS.has(w) && !JOINERS.has(w)));
  if (p >= 1 && !words(g[p]!).some((w) => name.has(w) || lang.has(w)) && !entries.some((e) => e.length > p && under(e, p + 1)) && children(g.slice(0, p)).size >= CATALOGUE) return "catalogue";
  return undefined;
}

/** The technology's guide filter over its stored docs state (`ownGuide`); the stored state is read when not given. */
export function guideFilter(src: Source, state: StoredState | undefined = readJson<StoredState>(join(docsDir(src.technology), "state.json"))): (url: string) => boolean {
  const pages = Object.keys(state?.pages ?? {});
  const guides = new Set(Object.entries(state?.pages ?? {}).filter(([, p]) => p.guideMajor).map(([u]) => u));
  const entries = (state?.sites ?? []).map((s) => s.site);
  return (url) => ownGuide(url, { purls: src.purls, pages, guides, entries });
}

/**
 * Checks the technology's guide pages (a limited refresh: guides and guide-like pages only, so nothing else is
 * fetched) unless offline, then returns those for the current and the previous major from the stored state.
 */
export async function currentGuides(src: Source, opts: { http: HttpClient; offline?: boolean; checked?: boolean; log?: (s: string) => void }): Promise<CurrentGuide[]> {
  // `checked`: the daily pass has just checked every guide page, so the stored state is current.
  if (!opts.offline && !opts.checked) await refresh(src, { http: opts.http, limit: 0, ...(opts.log ? { log: opts.log } : {}) });
  const state = readJson<StoredState>(join(docsDir(src.technology), "state.json"));
  if (!state) return [];
  const own = guideFilter(src, state);
  const pages = Object.entries(state.pages).filter(([url, p]) => p.guideMajor && own(url));
  const latest = opts.offline ? undefined : (await Promise.all(src.purls.map((p) => latestVersion(opts.http, p)))).find(Boolean);
  const majors = pages.map(([, p]) => Number(p.guideMajor)).filter((n) => Number.isFinite(n));
  const max = latest ? Number(latest.split(".")[0]) : Math.max(...majors);
  const store = docsStore(src.technology);
  const out: CurrentGuide[] = [];
  for (const [url, p] of pages) {
    const major = Number(p.guideMajor);
    if (!p.guideMajor || major > max || major < max - 1) continue; // the attribution rule: current or previous major
    const snap = (await store.getState(p.watch.id))?.snapshot;
    if (!snap) continue;
    out.push({ url, major: p.guideMajor, text: await store.getBlob(snap), snapshot: `sha256:${snap}` });
  }
  return out.sort((a, b) => Number(b.major) - Number(a.major) || a.url.localeCompare(b.url));
}
