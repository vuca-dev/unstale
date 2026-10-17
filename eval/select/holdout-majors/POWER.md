# Power of held-out set 2 (upgrade guides and major-version notes)

Same method as `../holdout/POWER.md`: the minimum detectable paired difference (MDD) for an exact two-sided McNemar
test, with α = 0.05 and power 0.80, **assuming 10% of groups are discordant**. Computed with `../holdout/power.py`.

## Expected group counts (before labelling)

Labels do not exist yet, so the counts are estimates from the documents' structure. Only counts were used: list items
and heading lines outside code blocks, with no reading of what any line says. The scale comes from the first set: its
adjudicated reference has 270 groups over 575 list items and 134 headings. That is 0.38 groups per (item + heading),
or 0.47 per item. Its ratio is low because zod's "Commits" lists repeat the prose. These documents have no commit
lists, and guides are organised by heading (one step per heading), so the range below is wider than one ratio would
give.

| Document | Chars | List items | Headings | Expected groups |
|---|---|---|---|---|
| sveltejs-kit 3.0.0 guide | 29,984 | 50 | 81 | 40–80 |
| sveltejs-kit 3.0.0 major notes | 15,407 | 111 | 2 | 45–90 |
| msw 3.0.0 guide | 10,476 | 3 | 20 | 10–20 |
| msw 3.0.0 major notes | 3,319 | 40 | 4 | 15–35 |
| transformers 5.0.0 guide | 28,059 | 68 | 31 | 30–65 |
| transformers 5.0.0 major notes | 29,986 | 131 | 41 | 45–110 |
| mypy 2.0.0 major notes | 14,923 | 90 | 19 | 35–75 |
| **All (7 documents)** | 132,154 | 493 | 198 | **≈ 220–475; central ≈ 250** |
| Guides (3) | 68,519 | 121 | 132 | ≈ 80–165 |
| Major notes (4) | 63,635 | 372 | 66 | ≈ 140–310 |
| **Required groups** (guess: 50–80% of guide groups, 25–50% of notes groups) | | | | **≈ 75–285; central ≈ 120** |

## MDD at those counts

| Slice | Groups (n) | MDD, exact | MDD, normal approx. |
|---|---|---|---|
| All groups, low / central / high | 220 / 250 / 330 | 6.2 / 5.8 / 5.1 pts | 5.9 / 5.6 / 4.9 pts |
| **Required groups**, low / central / higher | 75 / 120 / 180 | > 10 / 8.2 / 6.8 pts | > 10 / 8.0 / 6.6 pts |
| Guides only | 90–150 | 9.3–7.3 pts | 9.2–7.2 pts |
| One technology, or required in one kind | 40–60 | > 10 pts | > 10 pts |
| First set's 258 sure groups plus this set's ≈ 120 required / ≈ 250 groups | ≈ 380 / 510 | 4.7 / 4.0 pts | 4.5 / 3.9 pts |

## Reading it

- **Required-group recall is the headline, and at about 120 groups it can detect a loss of about 8 points;
  at the low estimate (75) it cannot detect 10.** That
  assumes 10% discordance. Slice 3 measured 12% discordance between two Luna runs on the first set. The dev gap that
  motivated this set was 61/61 against 53/61 required, a 13-point loss, which is within reach. A 5-point margin is
  not.
- **The clustering is much worse than in the first set.** There are 7 documents from 4 technologies, against 40
  notes. McNemar treats groups as independent, so its p-values are optimistic. `score.py compare`'s bootstrap resamples
  whole notes, so here it draws from only 7 clusters: its CI will be coarse and discrete, and with 3 guides a
  guide-only CI hardly exists. Before any model is scored, decide which CI is of record. The options are the note
  bootstrap as is, or a bootstrap over top-level sections (which `score.py` does not do yet). Make that decision
  without seeing results.
- **Slices are descriptive.** Each technology holds about 15–35% of the groups, and per-kind required slices have
  fewer than 100 groups.
- **Size dominance:** transformers (two documents, ≈ 58k characters) may hold 30–40% of the groups. Report macro per
  document next to pooled, as for the first set (zod 4.5.0 there).
- **Every document fits one chunk** (≤ 30,000 characters, `MAX_CHUNK`). The cap of 30k per document when both
  documents are long makes this so. The set therefore does not test multi-chunk splitting. The slice 3 dev documents
  averaged 14k characters per chunk, which is comparable to these.
