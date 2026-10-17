// The upgrade guides of a technology, found by the docs module for any technology (vault: Docs Monitoring - Handoff,
// "Decision 2"): the pages its listing names as guides (`upgrading/version-16`, `upgrade-prisma-orm/v7`, or an
// unnumbered `migration-guide` read from its text), for the current and the previous major, as the site's own copy.
// Replaces the hand-kept per-technology table of guide paths.
import { join } from "node:path";
import type { HttpClient } from "../collector/http.ts";
import { FsStore } from "../collector/store.ts";
import { readJson } from "../pipeline/util.ts";
import { docsDir, latestVersion, refresh, type Source } from "./monitor.ts";

export interface CurrentGuide {
  url: string;
  major: string;
  text: string;
  /** `sha256:<hex>` of the text as stored. */
  snapshot: string;
}

/**
 * Checks the technology's guide pages (a limited refresh: guides and guide-like pages only, so nothing else is
 * fetched) unless offline, then returns those for the current and the previous major from the stored state.
 */
export async function currentGuides(src: Source, opts: { http: HttpClient; offline?: boolean; checked?: boolean; log?: (s: string) => void }): Promise<CurrentGuide[]> {
  // `checked`: the daily pass has just checked every guide page, so the stored state is current.
  if (!opts.offline && !opts.checked) await refresh(src, { http: opts.http, limit: 0, ...(opts.log ? { log: opts.log } : {}) });
  const state = readJson<{ pages: Record<string, { guideMajor?: string; watch: { id: string } }> }>(join(docsDir(src.technology), "state.json"));
  if (!state) return [];
  const latest = opts.offline ? undefined : (await Promise.all(src.purls.map((p) => latestVersion(opts.http, p)))).find(Boolean);
  const majors = Object.values(state.pages).map((p) => Number(p.guideMajor)).filter((n) => Number.isFinite(n));
  const max = latest ? Number(latest.split(".")[0]) : Math.max(...majors);
  const store = new FsStore(join(docsDir(src.technology), "store"));
  const out: CurrentGuide[] = [];
  for (const [url, p] of Object.entries(state.pages)) {
    const major = Number(p.guideMajor);
    if (!p.guideMajor || major > max || major < max - 1) continue; // the attribution rule: current or previous major
    const snap = (await store.getState(p.watch.id))?.snapshot;
    if (!snap) continue;
    out.push({ url, major: p.guideMajor, text: await store.getBlob(snap), snapshot: `sha256:${snap}` });
  }
  return out.sort((a, b) => Number(b.major) - Number(a.major) || a.url.localeCompare(b.url));
}
