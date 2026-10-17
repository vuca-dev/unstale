# Power of the held-out sets

Minimum detectable paired difference (MDD) between two candidates scored on the same items: exact two-sided McNemar,
α = 0.05, power 0.80, **assuming 10% of items are discordant** (one candidate right, the other wrong). Computed by
`power.py` (exact: summed over the binomial number of discordant pairs; the normal approximation is shown beside it).
With 10% discordance the largest possible difference is 10 points (every discordant item favouring one side), so
"> 10 pts" means no difference of that kind can reach significance on that set.

| Set | Items (n) | MDD, exact | MDD, normal approx. |
|---|---|---|---|
| **Classifier held-out, all** | 233 | 6.0 pts | 5.8 pts |
| Classifier held-out, npm (posthog-js + zod) | 160 | 7.2 pts | 7.0 pts |
| Classifier held-out, PyPI (uvicorn 40 + typer 33) | 73 | > 10 pts | > 10 pts |
| Classifier, one npm technology | 80 | 9.8 pts | 9.8 pts |
| Classifier, one PyPI technology | 33–40 | > 10 pts | > 10 pts |
| Classifier, breaking recall, if 25% of 233 are breaking | 60 | > 10 pts | > 10 pts |
| Classifier, breaking recall, if 40% of 233 are breaking | 96 | 9.0 pts | 8.9 pts |
| **Extraction inventory**, if 3 items per note | 120 | 8.2 pts | 8.0 pts |
| Extraction inventory, if 5 items per note | 200 | 6.5 pts | 6.2 pts |
| Extraction inventory, if 8 items per note | 320 | 5.2 pts | 4.9 pts |
| Existing: benefit (dev only) | 150 | 7.3 pts | 7.2 pts |
| Existing: breaking (Laravel held out) | 241 | 5.9 pts | 5.7 pts |
| Existing: extraction-recall | 100 | 8.8 pts | 8.8 pts |
| Existing: Nuxt pairs | 211 | 6.2 pts | 6.1 pts |

Reading it:

- **Recall metrics are scored on the positives only,** so their n is the number of reference positives, not the set
  size. Breaking recall on the classifier set has n = the breaking count after adjudication (unknown until labelled);
  at a quarter of 233 it cannot detect a 10-point loss at 10% discordance. Removal + deprecation recall is weaker
  still: the extraction hints put 8 removal/deprecation records among the 485 npm units (2 of 269 posthog-js, 6 of 216
  zod) and 9 among the 94 PyPI units (3 uvicorn, 6 typer), so the set holds at most about 15 such hints (reference counts are known only after labelling). **No set built here can certify "no loss" on removal/deprecation recall.**
- **Extraction items are clustered in notes** (40 notes; one long zod note may hold dozens of items). McNemar treats
  items as independent, so its p-values are optimistic; `score.py compare` also reports a bootstrap CI that resamples
  whole notes, and that CI is the one to trust. The effective n is between 40 (notes) and the item count.
- Per-technology and per-ecosystem slices (n ≤ 80) are descriptive only: none can separate candidates closer than
  about 10 points.
- If discordance is lower than 10% (two similar models), the MDD shrinks roughly with √(discordance); if higher, it
  grows. Report the observed discordance next to each comparison.
