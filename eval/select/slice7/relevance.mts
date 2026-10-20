// Slice 7: the per-(record, package) relevance question asked of Jev over a shared upgrade guide's records
// (PREREG.md). The state names the package, the guide and the record with its heading path in the guide; the question
// is the same for every package (it refers to the package named in the state), so its text is a constant per revision.
// A record is kept for the package when p(yes) >= THRESHOLD[rev].
import type { Incoming } from "../../../central/src/pipeline/extract.ts";
import type { Technology } from "../../../central/src/pipeline/technologies.ts";
import type { Classification, Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { chunk } from "../../../central/src/pipeline/extract.ts";

export const REVISIONS = ["r0", "r1", "r2", "r3"] as const;
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

/** r1+: the part of the guide the record was extracted from (the pipeline's chunk, by the record key's chunk index):
 * which part, and its H2/H3 headings. */
export function partContext(notes: string, r: Incoming): Record<string, unknown> {
  const parts = chunk(notes);
  const ci = Number(/#(\d+)\./.exec(r.key)?.[1] ?? 0);
  const text = parts[ci] ?? notes;
  let fenced = false;
  const hs = text.split("\n").filter((l) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return !fenced && /^#{2,3}\s/.test(l);
  });
  const sections = hs.map((h) => h.replace(/^#+\s*/, "").replace(/[`*]/g, "").trim()).join(" | ").slice(0, 2000);
  return { ...(parts.length > 1 ? { guide_part: `${ci + 1} of ${parts.length}` } : {}), part_sections: sections };
}

export function relevanceState(t: Technology, url: string, version: string, path: string, r: Incoming, part?: Record<string, unknown>): Record<string, unknown> {
  return {
    package: t.name,
    ...(t.repo ? { package_repository: t.directory ? `${t.repo} (${t.directory})` : t.repo } : {}),
    upgrade_guide: url,
    guide_release: version,
    ...(path ? { guide_section: path } : {}),
    ...(part ?? {}),
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

// r1 (after dev r0: Jev kept nearly every record for every package, p(yes) near 1, so single-part guides with
// per-package sections lost all precision). Today's per-package extraction reads one part of a guide at a time: on a
// part with sections for specific packages it keeps a package's own section; on a part that is all core changes it
// keeps them for providers; plugins and tools keep only their own changes.
const R1 =
  "The change comes from an upgrade guide that may cover several packages released together (a core library and its " +
  "providers or adapters, a framework and its plugins, integrations or tools). `part_sections` lists the sections of " +
  "the part of the guide the change is in. Does this change belong in the upgrade notes of the package named in " +
  "`package`? Yes when the change is to that package itself (its API, options, behaviour, installation). Yes also for " +
  "a change to the shared core when the package is the core itself, or when it is a provider or adapter of the core and " +
  "no section of this part is about one specific package of the family: such a part reads as core changes every " +
  "provider's users meet. No when the change concerns another specific package of the family. No for a core change " +
  "when this part has sections about specific packages but none about this one, or when the package is a plugin, " +
  "integration, UI binding or tool whose users meet core changes in the core's own notes.";

export function relevanceQuestions(rev: Rev): Questions {
  const text = { r0: R0, r1: R1 }[rev];
  return { relevant: { instructions: text, options: { yes: "It belongs in this package's upgrade notes.", no: "It concerns other packages only." } } };
}

// Per revision, the dev-F1-best threshold of {0.3 … 0.7} (thresh7.mts): r0 46.4, r1 50.9, r2 50.6, r3 53.5 (rep 79.3).
export const THRESHOLD: Record<Rev, number> = { r0: 0.7, r1: 0.6, r2: 0.7, r3: 0.7 };

/** Frozen for held-out (PREREG.md): no revision passed dev; r3 has the highest dev F1. */
export const FROZEN: Rev = "r3";

/** Whether a revision gives Jev the part of the guide (r1+). */
export const withPart = (rev: Rev): boolean => rev === "r1";

// r2 (after dev r1: one long conditional question was not followed; p(yes) stayed near 1 for providers on every
// guide). Simple judgments, composed in code:
//   own(record, package)      the change is to this package itself
//   core(record, package)     the change is to the core library or framework this package builds on or plugs into
//   provider(package)         the package plugs a backend into a core library whose API its users call directly
//   one_backend(record)       the change concerns one specific provider/adapter/backend (package-independent)
// keep = own >= T, or (provider >= 0.5 and core >= T and no record of the same guide part has one_backend >= 0.5).
// A part of a guide with per-provider sections then keeps only a provider's own changes; a part that is all core
// changes keeps them for providers; plugins, tools and bindings keep only their own changes.
const OWN =
  "Is this change about the package named in `package` itself: its own API, exports, options, defaults, behaviour, " +
  "commands, files or installation? Answer no when it is about another package, even a related one.";
const CORE =
  "Is this change to the core library or framework that the package named in `package` builds on or plugs into (the " +
  "shared core of the family the upgrade guide covers), rather than to one specific provider, plugin, adapter, " +
  "integration or tool of that family? Answer no when the guide is about something the package does not build on.";
const PROVIDER =
  "Is the package named in `package` a provider, adapter or driver that connects a core library to one backend, model " +
  "vendor or service, so that projects using it call the core library's own API directly in their code? Answer no for " +
  "the core library itself, and for plugins, build or lint tools, UI bindings, telemetry integrations, CLIs and utilities.";
const ONE_BACKEND =
  "Does this change concern one specific provider, adapter, driver or backend integration of the family (for example " +
  "one model vendor's provider), rather than the shared core or the family as a whole?";
// r3 (after dev r2: `own` scored core changes 0.5-0.7 for providers, e.g. ToolLoopAgent for @ai-sdk/openai): a change
// counts as a non-core package's own only as far as it is not a core change, own x (1 - core); the core package
// itself keeps own or core changes.
const CORE_PACKAGE =
  "Is the package named in `package` the core library or framework itself that the upgrade guide is mainly about " +
  "(not a provider, plugin, adapter, binding, integration, tool or utility package of its family)?";
const yn = (instructions: string): Questions[string] => ({ instructions, options: { yes: "Yes.", no: "No." } });

const recordOnly = (url: string, version: string, path: string, r: Incoming): Record<string, unknown> => ({
  upgrade_guide: url,
  guide_release: version,
  ...(path ? { guide_section: path } : {}),
  change: { subject: r.subject, ...(r.facet ? { facet: r.facet } : {}), summary: r.summary, evidence: r.quote },
});
const packageOnly = (t: Technology, url: string): Record<string, unknown> => ({
  package: t.name,
  ...(t.repo ? { package_repository: t.directory ? `${t.repo} (${t.directory})` : t.repo } : {}),
  upgrade_guide: url,
});

type Ask = (state: Record<string, unknown>, q: Questions) => Promise<Classification>;
const yes = (c: Classification, id: string): number => c.answers[id]!.probabilities.yes!;
const partOf = (r: Incoming): string => /#(\d+)\./.exec(r.key)?.[1] ?? "0";

/** Per guide (unit): which parts hold a record about one specific backend. Package-independent, asked once per record. */
type Pool = <T, U>(xs: T[], n: number, f: (x: T) => Promise<U>) => Promise<U[]>;
export function unitParts(ask: Ask, url: string, version: string, notes: string, recs: Incoming[], pool: Pool): Promise<Set<string>> {
  return pool(recs, 4, async (r) => {
    const c = await ask(recordOnly(url, version, headingPath(notes, r), r), { one_backend: yn(ONE_BACKEND) });
    return yes(c, "one_backend") >= 0.5 ? partOf(r) : undefined;
  }).then((xs) => new Set(xs.filter((x): x is string => x !== undefined)));
}

/** The keep score of each record for one package (kept when >= THRESHOLD[rev]); NaN when a question failed. */
export async function scorePair(
  rev: Rev,
  ask: Ask,
  t: Technology,
  url: string,
  version: string,
  notes: string,
  recs: Incoming[],
  backendParts: () => Promise<Set<string>>,
  pool: Pool,
): Promise<Array<{ inc: Incoming; p: number; err?: string }>> {
  if (rev !== "r2" && rev !== "r3") {
    const questions = relevanceQuestions(rev);
    return pool(recs, 4, async (inc) => {
      const state = relevanceState(t, url, version, headingPath(notes, inc), inc, withPart(rev) ? partContext(notes, inc) : undefined);
      try {
        return { inc, p: yes(await ask(state, questions), "relevant") };
      } catch (e) {
        return { inc, p: NaN, err: (e as Error).message };
      }
    });
  }
  let provider: number, corePkg = 0, parts: Set<string>;
  try {
    if (rev === "r2") provider = yes(await ask(packageOnly(t, url), { provider: yn(PROVIDER) }), "provider");
    else {
      const c = await ask(packageOnly(t, url), { provider: yn(PROVIDER), core_package: yn(CORE_PACKAGE) });
      provider = yes(c, "provider");
      corePkg = yes(c, "core_package");
    }
    parts = await backendParts();
  } catch (e) {
    return recs.map((inc) => ({ inc, p: NaN, err: (e as Error).message }));
  }
  return pool(recs, 4, async (inc) => {
    try {
      const c = await ask(relevanceState(t, url, version, headingPath(notes, inc), inc), { own: yn(OWN), core: yn(CORE) });
      const gate = provider >= 0.5 && !parts.has(partOf(inc));
      const own = yes(c, "own"), core = yes(c, "core");
      if (rev === "r2") return { inc, p: Math.max(own, gate ? core : 0) };
      if (corePkg >= 0.5) return { inc, p: Math.max(own, core) };
      return { inc, p: Math.max(own * (1 - core), gate ? core : 0) };
    } catch (e) {
      return { inc, p: NaN, err: (e as Error).message };
    }
  });
}
