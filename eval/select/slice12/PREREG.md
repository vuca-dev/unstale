# Slice 12 pre-registration: MiniMax M3.1 Flash for release notes only, on a fresh held-out set

20 October 2026. Written, committed and pushed before any MiniMax call on this slice's set. Before writing it, the
only outputs on the set were the inventory, the selection and the `base` arm (production's cached answers, plus a
fresh judge (E) on them, $0.041 of Jev); its records were counted, not compared with anything.

Question: can `vercel:minimax/minimax-m3.1-flash` (free on the AI Gateway) extract **release notes** (steps A and B)
in place of `vercel:openai/gpt-6-luna` (`low`, flex), with gpt-6-luna as its fallback, while **upgrade guides and docs
notes stay on gpt-6-luna**, with no quality loss? Slice 11 fitted MiniMax's extract prompt (r3) and passed H1 and H2
(release-note-heavy) but failed on upgrade guides (slice 6's shared AI SDK guides, F1 −26.5; H2 gold guides required
recall −5.8). The release-notes-only split was suggested by those held-out results, so it is tested on a set no
earlier slice has used.

## Why it matters (step 1: spend share, `share12.py`, no model calls)

Each gateway line of production's October usage log (restored state `state-20261020T173335Z-39461062144-1`, 48,708
calls, $8.84) is matched to the cached step-A or step-B answer with the same token counts (`inventory.mts` rebuilds
every chunk production extracted and its label request):

| Class | Calls | $ | Share of all gateway $ |
|---|---|---|---|
| Release notes, A | 16,538 | 3.356 | 38.0% |
| Release notes, B | 14,018 | 3.248 | 36.7% |
| Upgrade guides, A+B | 492 | 0.340 | 3.8% |
| Docs notes, A+B | 77 | 0.021 | 0.2% |
| Unmatched (chat-fallback labels, answers since rechunked or refetched) | 17,583 | 1.875 | 21.2% |

Of the matched A+B spend, release notes are **94.8%** (guides 4.9%, docs 0.3%). On 19–20 October, after the bulk
onboarding, they are 90.5%. In the monitoring phase alone they are 53% (release $0.180, guides $0.142, docs $0.013),
because a monitored technology's new major brings a guide. A+B at 20k technologies costs **$102/yr** on slice 3d's
production replay ($192 worst case). Release notes on MiniMax would leave the guide and docs share plus the fallback
share: about **$5–10/yr** at the overall mix, **about $48/yr** if the monitoring mix holds.

## Set (`select12.py`, `set.json`, committed)

Release notes (not guides or docs notes) whose every non-empty chunk has a cached gpt-6-luna step-A answer. Excluded:
- every chunk that slice 8 called a model on or fitted with: its DEV split, its HELD-OUT split (replicated), and the
  chunks its rule skipped. Slice 8's HELD-OUT-TIME chunks that the rule did not skip entered only an aggregate count,
  with no call and no record looked at. They stay in the pool, together with the 167 releases first extracted after
  slice 8's state was saved (14:22Z);
- the repositories of every earlier extraction or label set: the gate (Next.js, Prisma, NestJS), H1, H2, and slices
  6, 7 and 11's guide units.

Every chunk in the pool was answered on or after 19 October, so every release was first ingested after 15 October.
No labelled gold exists for these releases. Strata come from the version and the size only. Order is
sha256(`20261020|tech|version`). There is at most one release per technology per stratum, two per technology and
three per repository.

| Stratum | Pool | Taken | Base records |
|---|---|---|---|
| MAJOR (x.0 / x.0.0) | 129 | 24 | 316 |
| LARGE (≥ 8,000 characters) | 83 | 12 | 256 |
| NPM (other) | 3,228 | 54 | 133 |
| PYPI (other) | 970 | 36 | 233 |
| **Total** | | **126 releases, 116 technologies** | **938** (14 releases with none) |

## Arms (`run12.mts`, this branch's `central/src`)

| Arm | What |
|---|---|
| `base` | Production: A+B from the state's model cache (network refused for extraction), D from its classifier cache (34 of 938 labels missing there were asked of Jev) |
| `rep` | A fresh gpt-6-luna replicate (`UNSTALE_RELEASE_MODEL=none`, `low`, flex, empty caches): the noise reference |
| `mm` | The design: `extractRelease` with MiniMax first on slice 11's frozen r3 extract prompt (template sha `2f578d1b…`, pinned in `central/test/llm-fallback.test.ts`), production's label prompt for B, and gpt-6-luna as the fallback. Empty caches. **r3 is frozen: no new fitting.** |

D is the pipeline's classifier (Jev, with the chat fallback), `labelQuestions()`, `interpret`, for every record of
every arm. E is the same-or-new judge as `ingest` asks it: `retrieve`, `matchRequest`, then the judge's answer through
`pick`. It runs against the technology's production record store with this release's evidence removed. Records the
release alone created are dropped, and records it joined keep their other evidence. The outcome is the chosen record
id or `new`. E's cache is fresh for every arm.

## Metrics (`score12.mts`)

Records are matched one to one to `base`, per release, as in slices 3d and 6: grounded quotes whose spans overlap in
the folded notes (markdown links folded too), else the same subject. Bootstrap: 2,000 resamples of releases, seed
20261020, percentile 95% CIs. The `mm − rep` CI is paired.
- **Recall vs production** = matched / base records, pooled. **Precision** = matched / arm records.
- **Breaking recall** = matched / base records that production's labels call breaking. **Actionable ("required")
  recall** = the same over base records whose surface is not `runtime_internal` (the actionable definition of slices
  4 and 9). With no gold, these stand in for H2's required groups.
- **Records** = arm / base − 1. **Terms Jaccard** on matched records (step B's terms).
- **D agreement** on matched records: breaking, and actionable (surface ≠ `runtime_internal`), each arm's label against
  base's.
- **E agreement** on matched records: the same outcome (the same existing record, or both `new`).
- **Failed releases**: those with a failed call, after the fallback.
- F1, benefit and change_type agreement, the per-stratum table and the calls by model and role are reported but are
  not gates.

## Decision rule (one look; `mm` against `rep`, both against `base`)

`mm` passes when **all** of the following hold:
1. **Recall** is no more than **5 points** below rep's, and the paired CI of `mm − rep` is not entirely below 0.
2. **Breaking recall** and **actionable recall**: each the same as rule 1.
3. **Precision** is no more than 5 points below rep's, and the paired CI is not entirely below 0.
4. **Records** are within ±10% of base, or within rep's own deviation + 5 points if rep deviates more than 5%.
5. **Terms Jaccard** is no more than 5 points below rep's.
6. **D**: breaking agreement and actionable agreement are each no more than **3 points** below rep's, and the paired
   CI is not entirely below 0.
7. **E**: outcome agreement is no more than 3 points below rep's, and the paired CI is not entirely below 0.
8. **Failed releases** are at most max(1, 2%).

The margins are slice 6's (5 points for extraction, 3 for labels). The paired CI is what keeps each difference within
the replicate's noise. If the Jev cap stops D or E early, the rule is scored on the releases that all three arms
completed, in `set.json` order, and RESULTS says so.

**If it passes:** the change ships in `central/src` as committed on this branch before this file. Release notes
(`ReleaseNote`, without `kind`) go first to `UNSTALE_RELEASE_MODEL` (default MiniMax; `none` turns it off) for steps
A and B, and the gpt-6-luna fallback takes HTTP errors, exhausted 429s, truncation and unparseable answers. Guides and
docs notes, the classifier's chat fallback and every other call stay on `UNSTALE_EXTRACT_MODEL` (gpt-6-luna) with
their prompts and cache keys unchanged. Every model's cache is read before any call, so gpt-6-luna's cached
release-note answers are not paid for again. The cache entry and the usage log name the answering model and its role.
`UNSTALE_RELEASE_CONCURRENCY` (default 40) sets the release model's calls in flight. Slice 11 measured 53 calls a
minute with no 429 at 40. A PR is opened and not merged.
**If any condition fails:** `central/src` returns to `origin/main`, the change is kept as `design.patch`, and an
eval-only PR is opened.

## Budget

Vercel **$2.00** across slice 12's logs (provider-reported). The only paid gateway calls are `rep`, gpt-6-luna
fallbacks in `mm`, and the classifier's chat fallback. Jev **$0.50** at $0.042 per million input tokens. `base` used
$0.041, and `rep` plus `mm` are projected at about $0.25. `run12.mts` refuses a call that would pass either cap.

## Known limits

- The reference is production's own output, not gold: the comparison measures "no worse than asking gpt-6-luna again".
- There is one replicate and one MiniMax run. Releases share technologies (at most two each), and the bootstrap
  resamples releases, not technologies.
- E's pre-release store is reconstructed. Other fields of a record the release joined may have been changed by the
  join, and records from later releases are present. The same reconstruction serves all three arms.
- Slice 8 counted HELD-OUT-TIME chunks without calling a model on them or looking at their records. These chunks are
  "unused" only in that sense.
