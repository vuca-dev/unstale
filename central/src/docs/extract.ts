// Docs change events to extraction. Each event's sections that carry a version (a marker on the page, or an upgrade
// guide) become one extraction note per version: the rendered, fenced section diff, through the same extraction,
// labelling, matching and publishing as release notes. Sections without a version are held (counted, never published)
// until the version-unknown schema decision. A dry run renders the notes and makes no model calls.
import { join } from "node:path";
import type { DocsNote } from "../pipeline/extract.ts";
import type { GuideNote } from "../pipeline/fetch.ts";
import type { HttpClient } from "../collector/http.ts";
import { withTechLock } from "../pipeline/lock.ts";
import { readJson, writeAtomic } from "../pipeline/util.ts";
import { TECHNOLOGIES, type Technology } from "../pipeline/technologies.ts";
import { publishable } from "./attribute.ts";
import { docsDir, eventChanges, latestVersion, readEvents, refresh, type DocsEvent, type RefreshReport } from "./monitor.ts";
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
 * Promoted 16 October 2026 on the 90-day replay: block context and word marks lose no changed text and cut versioned
 * input by 12 %; the gate drops format, link, renumber and typo edits (−23 % estimated tokens, no false drop in 36
 * reviewed). Rewording is not gated: it dropped real additions ("(CommonJS projects use Jest)").
 */
export const PLAN_DEFAULTS: Required<PlanOptions> = { context: "block", words: true, skip: new Set<EditKind>(["format", "link", "renumber", "typo"]), guideKind: "upgrade_guide" };

const ledgerPath = (tech: string) => join(docsDir(tech), "extracted.json");

/**
 * The docs pass's limits. A site larger than the page budget is covered over several passes (least recently checked
 * first); notes beyond the note budget wait for the next run, guides first. `freshMs` is the old daily cadence, still
 * used when a release cannot be read (fail open).
 */
export const DOCS_PASS = { freshMs: 20 * 3600 * 1000, pages: 3000, notes: 40 };

const days = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return (v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback) * 86_400_000;
};
/**
 * When a pass runs (user, 16 October 2026: on a new release, until shown otherwise). Docs changes that matter land with
 * releases, so a technology's docs are checked when one of its packages publishes a new version, once more `followupMs`
 * later (docs often follow the release by days), and until a pass cut short by the page budget has covered the rest.
 * `maxAgeMs` (0: off) re-checks a technology with no release for that long.
 */
export const DOCS_GATE = {
  followupMs: days(process.env.UNSTALE_DOCS_FOLLOWUP_DAYS, 3),
  maxAgeMs: days(process.env.UNSTALE_DOCS_MAX_AGE_DAYS, 0),
};

/**
 * What the gate remembers between passes: the releases last checked, a follow-up due, a pass left unfinished, and
 * when a site's listing last named no page (listed again a day later, not only on the next release).
 */
export interface DocsGate {
  release?: string;
  followupAt?: string;
  incomplete?: boolean;
  unlistedAt?: string;
}
const gatePath = (tech: string) => join(docsDir(tech), "gate.json");

export type PassReason = "baseline" | "release" | "followup" | "continue" | "relist" | "age" | "daily";

/**
 * Why a pass is due now, or undefined. `release` is the components' current versions (undefined when a registry
 * could not be read: the old daily cadence applies, so an unreadable registry never stops docs monitoring).
 */
export function passDue(gate: DocsGate | undefined, release: string | undefined, last: string | undefined, now = Date.now(), g = DOCS_GATE): PassReason | undefined {
  if (!last) return "baseline";
  if (release === undefined) return now - Date.parse(last) >= DOCS_PASS.freshMs ? "daily" : undefined;
  if (gate?.release !== release) return "release";
  if (gate.incomplete) return "continue";
  if (gate.unlistedAt && now - Date.parse(gate.unlistedAt) >= DOCS_PASS.freshMs) return "relist";
  if (gate.followupAt && now >= Date.parse(gate.followupAt)) return "followup";
  if (g.maxAgeMs > 0 && now - Date.parse(last) >= g.maxAgeMs) return "age";
  return undefined;
}

/** The gate after a pass for `reason` that checked `checked` pages under `budget`; `unlisted`: a site listed no page. */
export function nextGate(gate: DocsGate | undefined, reason: PassReason, release: string | undefined, checked: number, budget: number, now = Date.now(), g = DOCS_GATE, unlisted = false): DocsGate {
  const out: DocsGate = { ...gate };
  if (release !== undefined) out.release = release;
  if (reason === "release") {
    if (g.followupMs > 0) out.followupAt = new Date(now + g.followupMs).toISOString();
    else delete out.followupAt;
  }
  if (reason === "followup" || reason === "baseline") delete out.followupAt;
  if (checked >= budget) out.incomplete = true;
  else delete out.incomplete;
  if (unlisted) out.unlistedAt = new Date(now).toISOString();
  else delete out.unlistedAt;
  return out;
}

/** The technology's current releases: each component's latest version, or undefined when any cannot be read. */
async function currentRelease(http: HttpClient, purls: string[]): Promise<string | undefined> {
  const versions = await Promise.all(purls.map((p) => latestVersion(http, p)));
  if (versions.some((v) => !v)) return undefined;
  return purls.map((p, i) => `${p}@${versions[i]}`).sort().join(" ");
}

/** When the technology's docs were last checked (the docs state's time), if ever. */
export const lastPass = (tech: string): string | undefined => readJson<{ at?: string }>(join(docsDir(tech), "state.json"))?.at;

/** The technology's docs, checked when the gate says a pass is due (or `force`); undefined if not due. */
export async function dailyPass(
  t: Pick<Technology, "id" | "components">,
  opts: { http: HttpClient; force?: boolean; budget?: number; progress?: (done: number, total: number) => void; log?: (s: string) => void },
): Promise<(RefreshReport & { reason?: PassReason }) | undefined> {
  const purls = t.components.map((p) => p.replace("%40", "@"));
  const release = await currentRelease(opts.http, purls);
  const budget = opts.budget ?? DOCS_PASS.pages;
  // One writer of a technology's docs state at a time (the pipeline and the onboarding service can both run it).
  return withTechLock(`${t.id}.docs`, "docs", async () => {
    const gate = readJson<DocsGate>(gatePath(t.id));
    const reason = opts.force ? (lastPass(t.id) ? "release" : "baseline") : passDue(gate, release, lastPass(t.id));
    if (!reason) return undefined;
    opts.log?.(`docs pass: ${reason}`);
    const report = await refresh(
      { technology: t.id, purls },
      { http: opts.http, budget, ...(opts.progress ? { progress: opts.progress } : {}), ...(opts.log ? { log: opts.log } : {}) },
    );
    writeAtomic(gatePath(t.id), JSON.stringify(nextGate(gate, reason, release, report.checked, budget, Date.now(), DOCS_GATE, report.sites.some((s) => s.listingFailed)), null, 1) + "\n");
    return { ...report, reason };
  });
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
      const bound = s.attribution.by === "guide" ? s.attribution.noLaterThan : undefined;
      const k = `${s.attribution.version} ${s.attribution.by}${bound ? ` ${bound}` : ""}`;
      byVersion.set(k, [...(byVersion.get(k) ?? []), c]);
    }
    const url = e.to ?? e.url;
    if (!byVersion.size) out.settled.push(e.key);
    for (const [k, group] of byVersion) {
      const [version, by, bound] = k.split(" ") as [string, string, string | undefined];
      const base = {
        technology: tech,
        version,
        date: e.at.slice(0, 10),
        url,
        snapshot: `sha256:${e.snapshot ?? e.previous ?? ""}`,
        notes: renderChange(url, e.kind, group, { words: o.words }),
        ...(bound ? { noLaterThan: bound } : {}),
      };
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
