# Judge 2: cheaper requests for the same-or-new judge (step E, Jev)

16 October 2026. Pre-registration: `PREREG.md`, § "Judge 2", written before any run of these arms. Runner
`judge2.mts`; scorer `score5.mts --judge2` (`--fixed s,c,q` for descriptive scoring at given constants). Outputs are in
`out/slice5/runs/j2-*`, `summary-judge2.json` and `judge2-usage.jsonl`.

## Verdict

**No arm passes. Jev stays at K = 8 with the pipeline's own questions.** No production change is recommended under
the rule.

The one arm worth a decision is **F4** (K 8 → 4, same questions):
- It costs 45% less: $78 against $141 per 10k technologies.
- Its recall is not significantly different (+3.0 points, n.s.).
- It misses the false-merge floor by one merge: 1.4 per 100, from 1 DIFFERENT and 3 UNSURE out of 185 merges.

Adopting F4 is a trade-off for the user (see "F4 trade-off").

**Answer-by-id and rules-once don't work on Jev.** Both hold the floor but lose 3–9 recall points, which is
significant. Jev reads the identity rules better inside each question than once in the state.

## Where the request's size is

The judge's state is already a brief: subject, breaking, release and summary for the incoming record and each
candidate (median 1.6k characters). **The identity rules are repeated in every `same_cN` question,** about 8.1k of the
request's 9.7k characters. Jev bills about 2,760 input tokens per held-out request at K = 8.

Slimming the candidate records therefore had almost nothing to remove. The arms test K, and the rules stated once.

## Arms and results

Held-out is Nuxt plus the Next.js guide (236 requests, 197 items with an audited SAME). Constants are fitted on dev
per arm. "Certain misses" counts held-out items whose audited SAME candidate sits outside the top K.

| Arm | Form | Fitted same / cross / quote | HO merges | **Guarded false per 100** [95% CI] | **HO recall** | vs J1 (J1-only / arm-only; McNemar p; Δ CI) | Certain misses | Input tokens / request | $ / tech-year (mean / largest) | 10k / 50k / 200k | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **J1 = F8** | pipeline questions, K = 8 | 0.73 / 0.89 / 0.99 | 178 | **0.8** [0.3–4.8] | **88.8%** (175/197) | — | 0 | 2,760 | 0.0141 / 0.135 | $141 / $707 / $2,827 | **baseline, stays** |
| F4 | pipeline questions, K = 4 | 0.69 / 0.86 / 0.95 | 185 | **1.4** [0.6–5.4] (1 D, 3 U) | 91.9% | 1 / 7; p 0.07; +0.5…+5.6 | 2 | 1,596 | 0.0078 / 0.075 | $78 / $391 / $1,566 | **fails floor** (by one merge) |
| O8 | rules once in state, K = 8 | 0.58 / 0.94 / 1.01 | 162 | 0.6 | 81.2% | 15 / 0; p 1e-4; −11.2…−5.1 | 0 | 1,603 | 0.0082 / 0.078 | $82 / $410 / $1,642 | fails recall |
| O4 | rules once, K = 4 | 0.61 / 0.94 / 0.95 | 171 | 0.6 | 85.8% | 6 / 0; p 0.03; −6.1…−1.0 | 2 | 1,086 | 0.0053 / 0.051 | $53 / $267 / $1,066 | fails recall |
| O2 | rules once, K = 2 | 0.64 / 0.93 / 0.95 | 169 | 0.6 | 84.8% | 9 / 1; p 0.02 | 8 | 812 | 0.0039 / 0.037 | $39 / $196 / $783 | fails recall |
| O1 | rules once, K = 1 | 0.53 / 0.97 / 0.95 | 158 | 0.0 | 80.2% | 18 / 1; p 1e-4 | 12 | 670 | 0.0032 / 0.031 | $32 / $161 / $645 | fails recall |
| I8 | answer by id (one choice over c1..c8, none), reading A | 0.61 / 0.96 / 0.99 | 161 | 0.3 | 81.2% | 15 / 0; p 1e-4 | 0 | 1,230 | 0.0063 / 0.060 | $63 / $315 / $1,260 | fails recall |
| I4 | answer by id, K = 4, reading B | 0.53 / 0.98 / 0.99 | 158 | 0.0 | 80.2% | 17 / 0; p < 1e-4 | 2 | 926 | 0.0045 / 0.043 | $45 / $227 / $909 | fails recall |
| Never merge | — | — | 0 | — | 0% | — | — | 0 | 0 | 0 | 22.7 duplicates / 100 records |

How the table was built:
- **Cost** is the held-out $/request (Jev input only; output is free) × K / the mean candidates per request at that K
  (worst case: every request full) × R (114.6 mean, 1,092 largest).
- **Fitting:** all arms answered 365/365. Dev fit and held-out scoring use the slice 5 objective and grid unchanged.
- **I readings** were chosen on dev: A for I8, B for I4.

**Descriptive, not pre-registered:**
- **At J1's own constants (0.73 / 0.89 / 0.99),** F4 makes 177 merges at 1.1 per 100 (1 D, 2 U), with recall 88.3% (J1:
  88.8%).
- **At the pipeline's live constants (0.70 / 0.85 / 0.95),** F4 is at 1.4 per 100 with 91.9% recall, against J1's 0.8
  and 92.4%.
- **O and I arms at J1's constants** reach 78–85% recall.

So F4's one DIFFERENT merge appears at every constant set tried, and the O and I recall loss is not a fitting artefact.

## F4 trade-off (for the user)

- **Why F4 is close:**
  - Fewer candidates do not lose matches. Only 2 of 197 held-out SAME items have their match outside the top 4.
  - Recall rises (7 items gained, 1 lost).
  - The request is 42% smaller.
- **Why it fails: Jev's p(yes) rises when fewer competing candidates are shown.** Judge-only false merges are 8.9 per
  100 against J1's 6.6. Six held-out DIFFERENT pairs gained 0.09–0.18 in p. One passes every guard, including the cross-source threshold: the
  Next.js guide item "image-generating functions receive params as a Promise" merged into "Route params become
  Promises", at p 0.92 against J1's 0.83.
- **The dev fit can't see this.** The dev sets hold almost no DIFFERENT pairs near threshold: the within-source set is
  only Jev's own merges.
- **The floor is decided by one merge.** One DIFFERENT merge in about 180 moves the rate by 0.55, and F4's interval
  (0.6–5.4) overlaps J1's (0.3–4.8).
- **To adopt F4 honestly,** fit a higher SAME_P on a judge set with real near-threshold DIFFERENT pairs (the missing
  PyPI judge set), then take one fresh held-out look. Picking a threshold from this held-out result would be leakage.

## Rejected

- **Slim candidate records:** the state is already a brief, so there is nothing material to cut.
- **Rules once in the state (O arms):** significant recall loss at every K, and still at K = 8, where nothing but the
  rules' placement changed.
- **Answer by id (I arms):** significant recall loss. One choice over candidates also makes Jev less willing to name a
  match. Reading B (top candidate gets 1 − p(none)) did not recover it. The user's "answer by reference" principle
  therefore doesn't transfer to Jev's judge, where the per-question rule text is what drives recall.
- **K = 2 and K = 1:** 8 and 12 certain misses on held-out, and a significant recall loss.
- **Clef Flash add-on:** not run. The pre-registered condition was a passing O or I arm, and none passed. Running F8 on
  Clef would also use about 3.4k of the 10k neurons/day free tier, shared with the classifier experiments the same
  day.

## Evalisms

- Recall is measured within Jev's pair set, so an arm can't be credited for a SAME pair Jev scored low. The arms that
  lose recall here might gain pairs nobody audited. No arm produced an unaudited merge on held-out.
- The Next.js guide holdout is technology-contaminated (Next.js is dev in the within-source set).
- The floor is a point estimate on about 180 merges, where one merge is 0.55 per 100.
- The answer-by-id readings were chosen on dev. Only one reading was looked at on held-out per arm.

## Spend

Jev: $0.124 (14 runs plus 2 smokes; J1 reproduced from its own caches at $0, 365/365 answers identical). No
gateway or Cloudflare spend.

## Judge rules compression (16 October 2026)

Pre-registration: `PREREG.md` § "Judge rules compression", written after the dev runs and before any held-out run.
The rules stay inside every `same_cN` question, reworded shorter; K = 8, same state, ids and options. Runner
`judge2.mts --arm M8|T8` (text in `RULES`); scorer `score5.mts --rules` → `out/slice5/summary-rules.json`. J1
reproduced from its own caches first: 129/129 dev and 236/236 held-out hits, $0.

**Verdict: M8 passes.** It matches J1 on held-out exactly on the floor and on recall, and the judge alone makes fewer
false merges. At the same K it cuts step E by 22%. It needs its own dev-fitted constants. T8 fails recall.

| Arm | Fitted same / cross / quote | HO merges | **Guarded false per 100** [95% CI] | Judge-only false per 100 | **HO recall** | vs J1 (J1-only / arm-only; McNemar p; Δ CI) | Jev input / request | $ / tech-year (mean / largest) | 10k / 50k / 200k | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| **J1** (pipeline text) | 0.73 / 0.89 / 0.99 | 178 | **0.8** [0.3–4.8] (0 D, 3 U) | 6.6 (9 D, 9 U) | **88.8%** (175/197) | — | 2,760 | 0.0141 / 0.135 | $141 / $707 / $2,827 | baseline |
| **M8** (moderate) | 0.87 / 0.87 / 0.95 | 178 | **0.8** [0.3–4.8] (0 D, 3 U) | **2.4** (3 D, 3 U) | **88.8%** (175/197) | 7 / 7; p 1.0; −3.6…+3.6 | 2,144 | 0.0110 / 0.105 | **$110 / $549 / $2,196** | **passes, cheapest passer** |
| T8 (tight) | 0.65 / 0.75 / 0.90 | 167 | 1.2 [0.4–5.2] (1 D, 2 U) | 2.9 (4 D, 3 U) | 83.2% (164/197) | 13 / 2; p 0.007; −9.6…−2.0 | 1,792 | 0.0092 / 0.088 | $92 / $458 / $1,834 | fails recall and floor |

How the table was built:
- **Cost** is the held-out Jev input per request, scaled from J1's measured $/tech-year (×2,144 / 2,760 for M8).
- **Output** is free on Jev.
- **Dev:** J1 105/109; M8 106/109 (1 D); T8 102/109.

**Descriptive, not pre-registered:** M8 at other constants.
- **At the pipeline's live constants (0.70 / 0.85 / 0.95):** 1.4 per 100 (1 D, 3 U) and recall 91.9%, against J1's 0.8 and 92.4%.
- **At J1's fitted constants:** 0.9 per 100 and recall 87.8%.

So **M8 must ship with its own constants**, SAME_P 0.87 and CROSS_SAME_P 0.87, with QUOTE_GUARD_BELOW unchanged at 0.95. The shorter text shifts Jev's probabilities.

T8's probabilities shift down a long way: at the live constants its recall is 77.2%.

**Rejected:** T8. Cutting the rules to one sentence loses significant recall, as in the rules-once arms. Jev needs the
"not the same, even if related" cases spelled out.

**Caveats:**
- **The same evalisms as Judge 2 apply:** recall is measured within Jev's pair set; Next.js is in both the guide holdout and dev; one merge is 0.55 per 100.
- **The constants were fitted on the same dev set,** which has few near-threshold DIFFERENT pairs.
- **The tie with J1 is exact but not proof:** M8 and J1 each recall 7 items the other misses.
- **The lineage judge's constant (`LINEAGE_SAME_P`) and the advisory judge were not tested;** this set doesn't cover them. If the M8 text is shared with those questions, refit or keep the old text for them.

**Spend:** Jev $0.061: dev $0.022, held-out $0.039. No gateway or Cloudflare spend.

**Text to ship (M8):** it replaces the rules block in each `same_cN` question. The question ids and the yes/no options stay as they are.
```
Is the incoming record the same change as candidate cN?
Same: the same thing changed in the same way. Ignore change_type labels and release lines (a backport is the same change).
Not the same, even if related: a specific function, option, flag or channel vs the broader feature; deprecating or removing an API vs adding its replacement; a rename vs adding the new name; two different options, or two separate fixes, of one API; a breaking vs a non-breaking change.
Unsure: answer no (a wrong match hides a change).
```
For cross-source requests (notes ↔ guide), append:
```
Release notes and an upgrade guide describe the same change in different words and detail.
```
Constants: SAME_P 0.87, CROSS_SAME_P 0.87, QUOTE_GUARD_BELOW 0.95.

## SubQ Snap on the judge (17 October 2026)

Pre-registration: `PREREG.md` § "SubQ Snap on the judge", written before any judge run of Snap. Runner
`judge2.mts --arm M8 --cand subq`; scorer `score5.mts --rules --subq M8 --base M8` → `out/slice5/summary-rules-subq-M8-vs-M8.json` (against J1, without `--base`: `summary-rules-subq-M8.json`).
All 365 requests answered.

**Verdict: Snap fails step E, and the switch rule keeps Jev.** To hold the false-merge floor on dev, the fit pushes
SAME_P to 0.96, which leaves 42.1% held-out recall against Jev's 88.8%. It is not cheaper here either.

| Arm | Fitted same / cross / quote | Dev recall, false per 100 | HO merges | HO guarded false per 100 | **HO recall** | vs Jev M8 (M8-only / Snap-only; McNemar p; Δ CI) | Input / request | $ / request |
|---|---|---|---|---|---|---|---|---|
| **Jev M8** (production) | 0.87 / 0.87 / 0.95 | 106/109, 0.9 | 178 | 0.8 (0 D, 3 U) | **88.8%** | — | 2,144 | 0.0000900 |
| Snap M8, fitted | 0.96 / 0.96 / 0.95 | 53/109, 0.0 | 83 | 0.0 | **42.1%** | 92 / 0; p 4e-28; −54.3…−39.6 | 1,820 | 0.0000910 |
| Snap M8 at Jev's constants (descriptive) | 0.87 / 0.87 / 0.95 | 92/109, **3.6** | 166 | 0.6 (0 D, 2 U) | 83.2% | — | | |

- **Why it fails:** on dev, Snap gives high p(same) to DIFFERENT within-source pairs, so no constant near Jev's holds
  the floor (0.87: 3.6 per 100; 0.93: 1.9). On held-out its SAME pairs also sit lower (median p 0.957 against Jev's
  1.0), so it recalls less at every constant tried.
- **Cost:** Snap bills 15% fewer tokens per request, but its price is 19% higher, so step E costs 1% more ($0.0111
  against $0.0110 per technology-year). Both are scaled as the tables above (held-out $/request × K / mean candidates
  per request × R), which the pre-registration's shorter "$/request × R" left out. Without the K factor it is $0.0104
  against $0.0103: the same 1%.
- **Spend:** SubQ $0.034 (smoke, dev, held-out). No Jev spend: Jev M8 is the run above.
