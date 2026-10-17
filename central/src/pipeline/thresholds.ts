// Classifier thresholds (CONTRACT: "Classifier thresholds"). The one place they are set.
export const BREAKING_P = 0.5;
export const BENEFIT_P = 0.5;
/** A probability in [low, high) is borderline: flagged, never dropped. */
export const BORDERLINE: readonly [number, number] = [0.35, 0.65];
/** change_type and surface are borderline below this confidence. */
export const CHOICE_CONFIDENCE = 0.6;
/** Same-or-new at ingest: "same" only at or above this. */
export const SAME_P = 0.7;
/** Same-or-new across evidence kinds (a guide item against a release-notes record), where the quote guard does not
 * apply: "same" only at or above this. Set from docs/match-audit-guides.md (tuned in-sample). */
export const CROSS_SAME_P = 0.85;
/** The same two bars for requests asked with the shorter rule text (match.ts shortRules), fitted on dev for it
 * (eval/select/slice5/RESULTS-judge2.md, "M8"): at the old bars it let one wrong merge through on held-out. */
export const SAME_P_SHORT = 0.87;
export const CROSS_SAME_P_SHORT = 0.87;

export const isBorderline = (p: number): boolean => p >= BORDERLINE[0] && p < BORDERLINE[1];

/** Lineage matching: an item from a later version of a document the candidate cites, same release (match.ts sameLineage). Calibrated 16 October 2026 on 56 hand-labelled pairs from the decision-2 arms: at 0.8, 37 merges, 1 different, 5 unsure (0.7: 4 different; 0.86: none, but 31 true duplicates kept). */
export const LINEAGE_SAME_P = 0.8;
