// Docs change events to extraction (vault: Docs Monitoring - Handoff, sequence step 2). Each event's sections that
// carry a version (a marker on the page, or an upgrade guide) become one extraction note per version: the rendered,
// fenced section diff, through the same extraction, labelling, matching and publishing as release notes. Sections
// without a version are held (counted, never published) until the version-unknown schema decision. A dry run renders
// the notes and makes no model calls.
import { join } from "node:path";
import type { DocsNote } from "../pipeline/extract.ts";
import type { GuideNote } from "../pipeline/fetch.ts";
import type { HttpClient } from "../collector/http.ts";
import { withTechLock } from "../pipeline/lock.ts";
import { readJson, writeAtomic } from "../pipeline/util.ts";
import { TECHNOLOGIES, type Technology } from "../pipeline/technologies.ts";
import { publishable } from "./attribute.ts";
import { docsDir, eventChanges, readEvents, refresh, type DocsEvent, type RefreshReport } from "./monitor.ts";
import { editKind, type EditKind } from "./materiality.ts";
import { renderChange } from "./render.ts";
import type { Context } from "../collector/sections.ts";

export interface PlannedNote {
  event: string;
  note: DocsNote | GuideNote;
  sections: number;
}

export interface Plan {
  notes: PlannedNote[];
  held: Record<string, number>;
  /** Versioned sections dropped before any model call, by edit kind (materiality.ts). */
  trivial: Record<string, number>;
  skipped: number;
  /**
   * Events with nothing to extract (every section held or trivial): recorded as done when the plan's notes are, so a
   * later run does not diff them again. They stay in the event log for the version-unknown decision.
   */
  settled: string[];
}

export interface PlanOptions {
  /** Context carried with each change (sections.ts). */
  context?: Context;
  /** Word-marked rendering (render.ts). */
  words?: boolean;
  /** Edit kinds never sent to the model. */
  skip?: ReadonlySet<EditKind>;
  /** Evidence kind for sections of an upgrade guide: "upgrade_guide" joins the guide's own records (lineage matching). */
  guideKind?: "docs" | "upgrade_guide";
}

/**
 * Promoted 16 October 2026 on the 90-day replay (vault: Docs Monitoring - Handoff, "Diff and gating levers"): block
 * context and word marks lose no changed text and cut versioned input by 12 %; the gate drops format, link, renumber
 * and typo edits (−23 % estimated tokens, no false drop in 36 reviewed). Rewording is not gated: it dropped real
 * additions ("(CommonJS projects use Jest)").
 */
export const PLAN_DEFAULTS: Required<PlanOptions> = { context: "block", words: true, skip: new Set<EditKind>(["format", "link", "renumber", "typo"]), guideKind: "upgrade_guide" };

const ledgerPath = (tech: string) => join(docsDir(tech), "extracted.json");

/**
 * The daily pass's cadence and per-run limits (vault: Docs Monitoring - Handoff, sequence step 6). The pipeline runs
 * every few hours; a technology's docs are checked once a day. A site larger than the page budget is covered over
 * several days (least recently checked first); notes beyond the note budget wait for the next run, guides first.
 */
export const DOCS_PASS = { freshMs: 20 * 3600 * 1000, pages: 3000, notes: 40 };

/** When the technology's docs were last checked (the docs state's time), if ever. */
export const lastPass = (tech: string): string | undefined => readJson<{ at?: string }>(join(docsDir(tech), "state.json"))?.at;

/** The technology's docs, checked when its last pass is older than DOCS_PASS.freshMs (or `force`); undefined if not due. */
export async function dailyPass(
  t: Pick<Technology, "id" | "components">,
  opts: { http: HttpClient; force?: boolean; budget?: number; progress?: (done: number, total: number) => void; log?: (s: string) => void },
): Promise<RefreshReport | undefined> {
  const last = lastPass(t.id);
  if (!opts.force && last && Date.now() - Date.parse(last) < DOCS_PASS.freshMs) return undefined;
  // One writer of a technology's docs state at a time (the pipeline and the onboarding service can both run it).
  return withTechLock(`${t.id}.docs`, "docs", () =>
    refresh(
      { technology: t.id, purls: t.components.map((p) => p.replace("%40", "@")) },
      { http: opts.http, budget: opts.budget ?? DOCS_PASS.pages, ...(opts.progress ? { progress: opts.progress } : {}), ...(opts.log ? { log: opts.log } : {}) },
    ),
  );
}

/** Records events as extracted, so their notes are not planned again. */
export function markExtracted(tech: string, events: Iterable<string>): void {
  const done = readJson<Record<string, string>>(ledgerPath(tech)) ?? {};
  const at = new Date().toISOString();
  let n = 0;
  for (const e of events) if (!done[e]) (done[e] = at), n++;
  if (n) writeAtomic(ledgerPath(tech), JSON.stringify(done, null, 1) + "\n");
}

/** Events whose every planned note succeeded, from the planned notes and the events that had a failed note. */
export function completeEvents(notes: readonly PlannedNote[], failed: ReadonlySet<string>, all: readonly PlannedNote[] = notes): string[] {
  const attempted = new Set(notes.map((x) => x.event));
  // An event with a note beyond this run's limit is not complete yet.
  const pending = new Set(all.filter((x) => !notes.includes(x)).map((x) => x.event));
  return [...attempted].filter((e) => !failed.has(e) && !pending.has(e));
}

/** Notes for the events not yet extracted, upgrade guides first (release priority). */
export async function plan(tech: string, options: PlanOptions = {}): Promise<Plan> {
  const o = { ...PLAN_DEFAULTS, ...options };
  const done = readJson<Record<string, string>>(ledgerPath(tech)) ?? {};
  const out: Plan = { notes: [], held: {}, trivial: {}, skipped: 0, settled: [] };
  const events = readEvents(tech).filter((e) => e.sections?.length && !done[e.key]);
  const rank = (e: DocsEvent) => (e.sections!.some((s) => s.attribution.by === "guide") ? 0 : 1);
  for (const e of events.sort((a, b) => rank(a) - rank(b) || a.at.localeCompare(b.at))) {
    const changes = await eventChanges(e, o.context);
    const byVersion = new Map<string, typeof changes>();
    for (const s of e.sections!) {
      const c = changes.find((x) => JSON.stringify(x.path) === JSON.stringify(s.path) && x.status === s.status);
      if (!c) {
        out.skipped++;
        continue;
      }
      if (!publishable(s.attribution)) {
        out.held[s.attribution.by] = (out.held[s.attribution.by] ?? 0) + 1;
        continue;
      }
      const kind = editKind(c);
      if (o.skip.has(kind)) {
        out.trivial[kind] = (out.trivial[kind] ?? 0) + 1;
        continue;
      }
      const k = `${s.attribution.version} ${s.attribution.by}`;
      byVersion.set(k, [...(byVersion.get(k) ?? []), c]);
    }
    const url = e.to ?? e.url;
    if (!byVersion.size) out.settled.push(e.key);
    for (const [k, group] of byVersion) {
      const [version, by] = k.split(" ") as [string, string];
      const base = { technology: tech, version, date: e.at.slice(0, 10), url, snapshot: `sha256:${e.snapshot ?? e.previous ?? ""}`, notes: renderChange(url, e.kind, group, { words: o.words }) };
      const guide = by === "guide" && o.guideKind === "upgrade_guide";
      out.notes.push({
        event: e.key,
        sections: group.length,
        note: guide
          ? { ...base, kind: "upgrade_guide", tag: `guide-${version.split(".")[0]}`, keyTag: `+guide.sec.${e.key.slice(0, 8)}` }
          : { ...base, kind: "docs", tag: `docs-${e.key.slice(0, 8)}`, keyTag: `+docs.${e.key.slice(0, 8)}` },
      });
    }
  }
  return out;
}

/**
 * Extract planned notes one at a time through the onboarding synthesis (model calls), at most `limit`, and record each
 * event once all its notes succeed. The pipeline batches the same notes with its releases instead (pipeline.ts).
 */
export async function extract(
  tech: string | Technology,
  limit = Infinity,
  log: (s: string) => void = () => {},
  admit?: (noteText: string) => boolean,
): Promise<{ notes: number; records?: number; stopped?: boolean }> {
  const t = typeof tech === "string" ? TECHNOLOGIES[tech] : tech;
  if (!t) throw new Error(`extraction needs a catalog technology; ${String(tech)} is not one`);
  const { synthesize } = await import("../onboarding/synthesis.ts"); // loads the classifier only when extracting
  const p = await plan(t.id);
  // `admit` sees each note's text before its model calls (the budget charges measured volume, not an estimate); a
  // refusal stops the batch there, and the notes not reached stay planned for the next run.
  let batch = p.notes.slice(0, limit);
  const stop = admit ? batch.findIndex(({ note }) => !admit(note.notes)) : -1;
  if (stop >= 0) batch = batch.slice(0, stop);
  let records: number | undefined;
  const failed = new Set<string>();
  for (const { event, note } of batch) {
    try {
      records = await synthesize(t, note);
      log(`${note.url} → ${note.version}: ${records} active records`);
    } catch (e) {
      failed.add(event);
      log(`${note.url}: ${(e as Error).message}`);
    }
  }
  markExtracted(t.id, [...completeEvents(batch, failed, p.notes), ...p.settled]);
  return { notes: batch.length - [...batch].filter((x) => failed.has(x.event)).length, ...(records !== undefined ? { records } : {}), ...(stop >= 0 ? { stopped: true } : {}) };
}
