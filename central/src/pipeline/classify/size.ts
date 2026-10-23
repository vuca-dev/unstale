// Magnitude and maturity for records labelled before they were asked (23 October 2026): records ingested since get
// them in their one labelling request (labels.ts); `catalog -- label-size` asks only these two questions of older
// feature records, once each (the classifier cache keeps the answer). Usage is tagged `other`, apart from coverage.
import type { StoredRecord, TechStore } from "../store.ts";
import { applyChange } from "../store.ts";
import { pool } from "../util.ts";
import { sizeOf, sizeQuestions } from "./labels.ts";
import type { Classification, Questions } from "./adapter.ts";

/** The change types the report's opportunities read magnitude and maturity for. */
export const FEATURE_TYPES: ReadonlySet<StoredRecord["change_type"]> = new Set(["new_api", "new_option", "stability_change", "performance"]);

/** The record's classifier state, as `recordState` builds it from an incoming record. */
export function storedState(name: string, r: StoredRecord): Record<string, unknown> {
  const e = r.evidence[0];
  const latest = [...r.releases].sort((a, b) => b.date.localeCompare(a.date))[0];
  return {
    technology: name,
    source: e?.kind === "upgrade_guide" ? "upgrade guide" : e?.kind === "docs" ? "official documentation change" : "release notes",
    release: latest?.version ?? "",
    subject: r.subject,
    ...(r.facet ? { facet: r.facet } : {}),
    summary: r.summary,
    evidence: e?.quote ?? "",
    ...(e?.section ? { section: e.section } : {}),
    introduces: r.introduces,
    replaces: r.replaces,
  };
}

/** A technology's display name from its id (`zod-6ac59393` → `zod`). */
export const nameOf = (tech: string): string => tech.replace(/-[0-9a-f]{8}$/, "");

/** Labels magnitude and maturity on the store's active feature records that have none (or only `ids`). */
export async function labelSize(
  s: TechStore,
  classify: (state: Record<string, unknown>, q: Questions) => Promise<Classification>,
  ids?: ReadonlySet<string>,
): Promise<{ labelled: number; failed: number }> {
  const todo = Object.values(s.records).filter((r) => r.status === "active" && !r.magnitude && FEATURE_TYPES.has(r.change_type) && (!ids || ids.has(r.id)));
  let labelled = 0;
  let failed = 0;
  await pool(todo, 8, async (r) => {
    try {
      const size = sizeOf(await classify(storedState(nameOf(s.technology), r), sizeQuestions()));
      if (!size) return void failed++;
      applyChange(r, { magnitude: size.magnitude, maturity: size.maturity }, "label-size");
      labelled++;
    } catch {
      failed++;
    }
  });
  return { labelled, failed };
}
