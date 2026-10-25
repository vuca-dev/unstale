// Release notes that are not in a GitHub release body (fetch.ts uses both):
//   - a changelog file read as one section per version: the project ships no GitHub release for the package (qs,
//     markdown-it), so its repository's changelog is its release notes. The package's own directory first (a monorepo
//     package), else the repository root;
//   - the document a pointer release links: a body that is only a link ("See the changelog for release notes: …"
//     react-router; "Please refer to CHANGELOG.md" vite; "check out the release announcement blog post" TypeScript)
//     is read through that link: the version's section of a changelog file in the same repository, or a page on the
//     publisher's own domain (the repository's or its owner's declared site, as the docs resolver's rule).
// Per format, never per technology: Markdown headings (ATX and setext) that name the version.
import { articleToMarkdown } from "../collector/extract.ts";

/** Changelog file names, in order of preference. */
const CHANGELOG_NAMES = /^(?:change[-_ ]?log|changes|history|releases?|news)(?:\.(?:md|markdown|mdx|txt))?$/i;
export const isChangelogName = (name: string): boolean => CHANGELOG_NAMES.test(name);
const RANK = ["changelog", "changes", "history", "releases", "release", "news"];
const rank = (name: string) => {
  const base = name.toLowerCase().replace(/\.[a-z]+$/, "").replace(/[-_ ]/g, "");
  const i = RANK.indexOf(base);
  return (i < 0 ? RANK.length : i) * 2 + (/\.(md|markdown|mdx)$/i.test(name) ? 0 : 1);
};
/** The changelog among a directory's file names, if any. */
export function pickChangelog(names: readonly string[]): string | undefined {
  return names.filter(isChangelogName).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

interface Heading {
  line: number;
  level: number;
  text: string;
}

/** ATX headings, and setext ones (`5.1.0 / 2025-03-31` over `===`), outside fenced code. */
function headings(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (atx) {
      out.push({ line: i, level: atx[1]!.length, text: atx[2]! });
      continue;
    }
    const next = lines[i + 1];
    if (l.trim() && next !== undefined && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(l)) {
      out.push({ line: i, level: next.trim().startsWith("=") ? 1 : 2, text: l.trim() });
      i++;
    }
  }
  return out;
}

/** The version a heading names: the first `x.y.z` in it (link targets dropped), `v` allowed; a prerelease
 * (`9.0.0-beta.1`) or a longer number is not that version. */
export function headingVersion(text: string): string | undefined {
  const plain = text.replace(/\]\([^)]*\)/g, "]").replace(/<[^>]+>/g, " ");
  const m = /(?:^|[^\w.])v?(\d+\.\d+\.\d+)(?![\w.]*\d|-|\+)/.exec(plain);
  return m?.[1];
}

export interface Section {
  version: string;
  heading: string;
  /** The heading line and everything under it until the next heading at its level or above. */
  text: string;
}

/** One section per version a heading names (the first heading for a version wins). Sections nest: the version's
 * heading level decides where it ends. */
export function versionSections(markdown: string, minorHeadings = false): Section[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const hs = headings(lines);
  const out: Section[] = [];
  const seen = new Set<string>();
  hs.forEach((h, i) => {
    const plain = h.text.replace(/\]\([^)]*\)/g, "]").replace(/<[^>]+>/g, " ");
    const minor = minorHeadings ? /(?:^|[^\w.])v?(\d+\.\d+)(?![\w.+-])/.exec(plain)?.[1] : undefined;
    const version = headingVersion(h.text) ?? minor;
    if (!version || seen.has(version)) return;
    const end = hs.slice(i + 1).find((x) => x.level <= h.level)?.line ?? lines.length;
    seen.add(version);
    out.push({ version, heading: h.text, text: lines.slice(h.line, end).join("\n").trim() });
  });
  return out;
}

export function sectionFor(markdown: string, version: string): Section | undefined {
  return versionSections(markdown).find((s) => s.version === version);
}

// ---- Pointer release bodies ----

/** A release body's links, Markdown and bare, in order. */
function links(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s<>)\]]+)/g)) out.push((m[1] ?? m[2]!).replace(/[.,;:]+$/, ""));
  return out;
}

/** Links that never lead to release notes: issue and pull queries, comparisons, commits, registries, downloads. */
const NOT_NOTES =
  /^https?:\/\/(?:[^/]*\.)?(?:npmjs\.com|npmjs\.org|pypi\.org|crates\.io|yarnpkg\.com|shields\.io|twitter\.com|x\.com|discord\.gg|discord\.com)\/|^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pulls?|compare|commits?|milestones?|releases|tree|actions|discussions|security)(?:[/?#]|$)|^https?:\/\/github\.com\/[^/]+\/?$/i;

/**
 * The links a pointer body points to, or none when the body is release notes itself. A pointer: once its links,
 * Markdown syntax and list markers are removed, fewer than 40 words remain (TypeScript's "For release notes, check
 * out the release announcement blog post … fixed issues query … Downloads are available on: npm" is 30), and at
 * least one link may lead to notes.
 */
export function pointerLinks(body: string): string[] {
  const prose = body
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>|-]+/g, " ");
  const words = prose.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words >= 40) return [];
  return [...new Set(links(body).filter((u) => !NOT_NOTES.test(u)))];
}

/** A link to a Markdown file in a GitHub repository (`/blob/<ref>/<path>`), as its raw URL and path. */
export function repoFileLink(url: string): { repo: string; ref: string; path: string; raw: string } | undefined {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([^/]+)\/([^?#]+\.(?:md|markdown|mdx))(?:[?#].*)?$/i.exec(url);
  if (!m) return undefined;
  const [, repo, ref, path] = m;
  return { repo: repo!, ref: ref!, path: decodeURIComponent(path!), raw: `https://raw.githubusercontent.com/${repo}/${ref}/${path}` };
}

/** The registrable part of a host, as the docs resolver compares publisher domains (`devblogs.microsoft.com` →
 * `microsoft.com`). */
export const siteOf = (host: string): string => host.replace(/^www\./, "").split(".").slice(-2).join(".");

/** A linked page as text: its article as Markdown (collector/extract.ts `articleToMarkdown`). */
export const pageText = (html: string): string => articleToMarkdown(html);

/** Longest linked document taken (characters, about 40,000 tokens): a page beyond it is cut at a heading. */
export const LINKED_MAX = 160_000;
export function capped(text: string): string {
  if (text.length <= LINKED_MAX) return text;
  const cut = text.lastIndexOf("\n#", LINKED_MAX);
  return text.slice(0, cut > LINKED_MAX / 2 ? cut : LINKED_MAX);
}

/** A rolling release page must contribute only its matching version section, including headings like `v9.3`.
 * Minor headings also describe patch releases on that line; exact patch headings take precedence. */
export function linkedReleaseText(page: string, version: string): string {
  const sections = versionSections(page, true);
  const own = sections.find((s) => s.version === version)
    ?? sections.find((s) => s.version === version.split(".").slice(0, 2).join("."));
  return own ? own.text : sections.length >= 2 ? "" : capped(page);
}
