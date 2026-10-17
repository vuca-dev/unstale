// Site-level change signals: one or two requests that say a whole docs site is unchanged since the last pass, so its
// pages are not checked one by one (user, 16 October 2026; vault: Central Scheduling and Infrastructure, "Scale
// probe"). Two signals, both from the site itself, with no per-site table:
//   - the site's `llms-full.txt` (the whole docs in one file; not `llms.txt`, which is only an index) is byte for byte
//     what it was at the last pass;
//   - the site is built from a repository (a validated site/repository pair from source resolution) and no commit has
//     touched its docs directories since the last pass.
// Anything that cannot be read is no signal: the site's pages are checked as before (fails open).
import { sha256 } from "../pipeline/util.ts";
import type { Fetcher, Resolution } from "./resolve.ts";

export interface SiteSignal {
  /** sha256 of the site's llms-full.txt, when it publishes one. */
  llmsFull?: string;
  /** Why the site counts as unchanged, if it does. */
  quiet?: "llms-full" | "repo";
}

/** The validated repositories a site is built from, with their docs directories. */
export function repoSources(resolutions: readonly Resolution[], site: string): Array<{ repo: string; dirs: string[] }> {
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  const out = new Map<string, string[]>();
  for (const r of resolutions)
    for (const p of r.pairs as Array<{ site: string; repo: string; validated: boolean; docDirs?: string[] }>)
      if (p.validated && host(p.site) === host(site) && p.docDirs?.length) out.set(p.repo, [...new Set([...(out.get(p.repo) ?? []), ...p.docDirs])]);
  return [...out].map(([repo, dirs]) => ({ repo, dirs }));
}

/** The site's llms-full.txt hash, from the docs prefix or the origin; undefined when there is none. */
async function llmsFullHash(f: Fetcher, site: string, prefix: string): Promise<string | undefined> {
  const root = new URL(site);
  for (const at of [...new Set([new URL((prefix || "") + "/llms-full.txt", root).href, new URL("/llms-full.txt", root).href])]) {
    const r = await f.get(at, "text/plain, text/markdown;q=0.9");
    // An HTML fallback page or a tiny body is not the docs in one file.
    if (r.status === 200 && r.text.length > 200 && !/^\s*</.test(r.text)) return sha256(r.text);
  }
  return undefined;
}

/** Whether no commit touched any of the directories since `since`; undefined when GitHub cannot say. */
async function repoQuiet(f: Fetcher, sources: Array<{ repo: string; dirs: string[] }>, since: string): Promise<boolean | undefined> {
  for (const { repo, dirs } of sources)
    for (const dir of dirs) {
      const r = await f.get(`https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(dir)}&since=${encodeURIComponent(since)}&per_page=1`, "application/vnd.github+json", true);
      if (r.status !== 200) return undefined;
      let commits: unknown;
      try {
        commits = JSON.parse(r.text);
      } catch {
        return undefined;
      }
      if (!Array.isArray(commits)) return undefined;
      if (commits.length) return false;
    }
  return true;
}

/**
 * The site's signal for this pass. `last.since` is the oldest check of any of its pages and `last.llmsFull` the
 * llms-full.txt hash when every page was last checked, so a pass cut short by the page budget is never taken for an
 * unchanged site. A site whose pages are not all checked yet, or with pages new to its listing, is never quiet.
 */
export async function siteSignal(
  f: Fetcher,
  site: { site: string; prefix: string },
  resolutions: readonly Resolution[],
  last: { since: string; llmsFull?: string | undefined; newPages: boolean } | undefined,
): Promise<SiteSignal> {
  const llmsFull = await llmsFullHash(f, site.site, site.prefix);
  const out: SiteSignal = llmsFull ? { llmsFull } : {};
  if (!last || last.newPages) return out;
  // The docs in one file: its bytes decide, either way.
  if (llmsFull) return last.llmsFull === llmsFull ? { ...out, quiet: "llms-full" } : out;
  const sources = repoSources(resolutions, site.site);
  if (sources.length && (await repoQuiet(f, sources, last.since))) return { ...out, quiet: "repo" };
  return out;
}
