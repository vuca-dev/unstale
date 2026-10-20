// Slice 7: the per-(record, package) relevance question asked of Jev over a shared upgrade guide's records
// (PREREG.md). The state names the package, the guide and the record with its heading path in the guide; the question
// is the same for every package (it refers to the package named in the state), so its text is a constant per revision.
// A record is kept for the package when p(yes) >= THRESHOLD[rev].
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { Technology } from "../../../central/src/pipeline/technologies.ts";
import type { Questions } from "../../../central/src/pipeline/classify/adapter.ts";

export const REVISIONS = ["r0"] as const;
export type Rev = (typeof REVISIONS)[number];

const norm = (s: string): string => s.replace(/[`*_\\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The headings above a record in the guide (`H2 > H3 > H4`), found by its quote; the record's own section otherwise. */
export function headingPath(notes: string, r: Incoming): string {
  const lines = notes.split("\n");
  const q = norm(r.quote).slice(0, 60);
  let at = -1;
  if (q) {
    for (let i = 0; i < lines.length && at < 0; i++) {
      // A quote may span lines: test the window from this line on.
      const w = norm(lines.slice(i, i + 4).join(" "));
      if (w.includes(q) && !norm(lines.slice(i + 1, i + 4).join(" ")).includes(q)) at = i;
    }
  }
  if (at < 0 && r.section) at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && norm(l.replace(/^#+\s*/, "")) === norm(r.section!));
  if (at < 0) return r.section ?? "";
  const stack: Array<[number, string]> = [];
  let fenced = false;
  for (let i = 0; i <= at; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const lvl = m[1]!.length;
    while (stack.length && stack.at(-1)![0] >= lvl) stack.pop();
    stack.push([lvl, m[2]!.replace(/[`*]/g, "").trim()]);
  }
  return stack.map((s) => s[1]).join(" > ") || (r.section ?? "");
}

export function relevanceState(t: Technology, url: string, version: string, path: string, r: Incoming): Record<string, unknown> {
  return {
    package: t.name,
    ...(t.repo ? { package_repository: t.directory ? `${t.repo} (${t.directory})` : t.repo } : {}),
    upgrade_guide: url,
    guide_release: version,
    ...(path ? { guide_section: path } : {}),
    change: { subject: r.subject, ...(r.facet ? { facet: r.facet } : {}), summary: r.summary, evidence: r.quote },
  };
}

const R0 =
  "The change comes from an upgrade guide that may cover several packages released together (a core library and its " +
  "providers or adapters, a framework and its plugins or tools). Does this change belong in the upgrade notes of the " +
  "package named in `package`? Yes when the change is to that package itself, or when it is a change to the shared core " +
  "of the family that every project using that package also meets (the core library's API, runtime, module format, " +
  "minimum versions or installation), since such a project uses the core together with the package. No when the change " +
  "concerns another specific package of the family (another provider, plugin, adapter, integration or tool) and not this one.";

export function relevanceQuestions(rev: Rev): Questions {
  const text = { r0: R0 }[rev];
  return { relevant: { instructions: text, options: { yes: "It belongs in this package's upgrade notes.", no: "It concerns other packages only." } } };
}

export const THRESHOLD: Record<Rev, number> = { r0: 0.5 };
