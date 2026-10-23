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
/** The same two bars, and the quote guard's, for requests asked with the shorter rule text (match.ts shortRules).
 * Refitted for Jev 1.14 (eval/select/slice17/RESULTS.md, "C′"): at 0.87 / 0.87 / 0.95, Jev 1.14 made 2.3 false merges
 * per 100 on a fresh held-out set (slice 16); these make 0.66 at a recall 2 points lower (n.s.). The quote guard is
 * raised for these requests only: raised for every request, it would have blocked 33 true production merges of
 * other kinds (slice 17, QG). */
export const SAME_P_SHORT = 0.82;
export const CROSS_SAME_P_SHORT = 0.91;
export const QUOTE_GUARD_BELOW_SHORT = 0.99;
/** Under the shorter rule text, a candidate gets a same-or-new question only at or above this retrieval score
 * (match.ts retrieve); the state still shows every candidate, and a request left with no question is not sent. Fitted
 * on dev, where the lowest-scoring true match scored 0.63 (eval/select/slice5/RESULTS-judge2.md, "Question floor"). */
export const QUESTION_FLOOR = 0.6;

export const isBorderline = (p: number): boolean => p >= BORDERLINE[0] && p < BORDERLINE[1];

/** Lineage matching: an item from a later version of a document the candidate cites, same release (match.ts sameLineage). Calibrated 16 October 2026 on 56 hand-labelled pairs from the decision-2 arms: at 0.8, 37 merges, 1 different, 5 unsure (0.7: 4 different; 0.86: none, but 31 true duplicates kept). */
export const LINEAGE_SAME_P = 0.8;
