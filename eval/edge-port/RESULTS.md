# Port parity results: the client's model steps against central's numbers

11 November 2026, under `PREREGISTRATION.md` (commit `c4c0737`, pushed before any paid call). Client: `origin/main`
at `8835d5c`, `unstale internal run-step`. One run per cell, one diagnosis pass, no tuning, no product code changed.

The model steps are: **extraction** (release notes to change records, two calls per chunk of notes), **labels**
(breaking or not, benefit, kind of change, for each record) and **matching** (a judge that says whether a new record
is the same change as one already stored, so duplicates merge). "Central" is the TypeScript pipeline that ran them
until now; "the client" is the Rust port. "The labelling service" is Jev; "by choice" means a text model
(`gpt-6-luna`) asked the same closed questions and read on the option it picks.

## Verdicts

- **Under the pre-registered rule (client at `8835d5c`): fail**, 7 of 8 parity cells pass. The failing cell is
  matching on `gpt-6-luna` by choice; its cause is a reading rule central shares, not the port.
- **Under addendum 1 (client at `1494730`, PR #237's two fixes; one run each, no further revision): pass**, 8 of 8.
  Matching by choice is now 141/197 = 71.6% against central's 72.1%, with no unreadable answer and no false merge.
- **Codex extraction with length-based batching is better and still below the direct route** (60.1% pooled recall
  against 53.5% before, 75.6% for the client's direct run and 66.3 to 67.4% for central's). It can be called measured,
  not equal.

## After the fixes (addendum 1, 11 November 2026)

Pre-registered in `PREREGISTRATION.md`, "Addendum 1" (commit `1d3c5c5`, pushed before any call for it).

| Cell | Metric | Reference | Before the fix | After the fix | Band (after minus reference) | Verdict |
|---|---|---|---|---|---|---|
| 8b Matching, `gpt-6-luna` by choice | Merge recall | central 142/197 = 72.1% | 124/197 = 62.9% | **141/197 = 71.6%** | −0.5 [−3.6, +2.5], McNemar p 1 | pass |
| 8b | False merges per 100 merges | central 0.0 | 0.0 | 0.0 (0 of 141) | McNemar p 1 | pass |
| 8b | Requests unreadable after three attempts | | 23 of 235 | **0 of 235** | | |

- **How it ran.** The 212 answers cell 8 had cached were read again at no cost; the 23 requests stored as unreadable
  were asked again, once each (23 calls, 35,667 input and 2,169 output tokens, $0.0044 billed). All 23 were read on
  the first attempt.
- **Duplicates.** A key alone now misses 56 true merges against the labelling service's 26 (production wording) or 22
  (slice 5's run): 30 to 34 more over 867 records, **4.0 to 4.5 more duplicate records per technology-year**. "About
  4" holds with the fix; it was about 6 without it.
- **Labels by choice re-read with the new answer reading:** 0 calls, 0 of 233 and 0 of 347 records change a label.

Codex extraction, short notes (9b; plan-billed, empty cache, 51 calls):

| Run | Recall, pooled | Mean per technology | Breaking | Precision | Records |
|---|---|---|---|---|---|
| Codex, batching by length (after) | **60.1** | 85.6 | 71.4 | 77.3 | 207 |
| Codex, any 8 chunks to a call (before) | 53.5 | 82.7 | 68.6 | 88.3 | 162 |
| Client, direct (cell 1) | 75.6 | 90.4 | 74.3 | 78.8 | 259 |
| Central's three direct runs | 66.3 to 67.4 | 91.7 to 92.5 | 74.3 to 85.7 | 81.1 to 83.2 | 214 to 228 |

| New batching minus | Recall, pooled | Mean per technology | Breaking | Precision |
|---|---|---|---|---|
| Client, direct | −15.5 [−25.5, +1.1] | −4.8 [−13.5, +3.5] | −2.9 [−19.4, +10.5] | −1.5 [−5.8, +3.5] |
| Central, gateway | −6.2 [−11.5, +1.2] | **−6.4 [−13.7, −0.2]** | **−11.4 [−35.0, −2.4]** | −4.7 [−12.1, +5.4] |
| Central, replicate | −7.4 [−13.9, +0.5] | **−6.1 [−12.2, −0.3]** | **−14.3 [−26.7, −5.0]** | −3.8 [−13.3, +5.7] |
| Central, direct | **−6.2 [−13.9, −1.6]** | **−6.9 [−14.4, −0.6]** | −2.9 [−31.2, +9.2] | −5.9 [−14.0, +4.2] |
| Old batching | +6.6 [−0.9, +10.6] | +2.9 [−4.9, +10.6] | +2.9 [0.0, +6.5] | −11.0 [−19.2, +5.1] |

- **Verdict by the rule ("no measurable loss" = every interval includes 0): not met.** Against the client's own
  direct run every interval includes 0, the pooled one barely; against central's direct runs six of twelve exclude 0.
- **Where the rest of the gap is.** The longest chunk now goes alone and gives 30 records, against 14 in a batch and
  37 to 75 on the direct route. So part of the loss is not batching: the same model writes less through Codex.
- **Relative to direct:** pooled recall is 79% of the client's direct run and about 90% of central's direct runs.
- **Plan tokens:** 400,046 for the set (372,162 input, 165,632 of it cached; 27,884 output). Per technology-year,
  scaled by chunks as before: **167k plan tokens** (69k cached input, 11.6k output; ≈ $0.015 at API prices). The old
  batching's figure was 152k.

Spend for the addendum: $0.0044 on the gateway (cap $0.50), 400k Codex plan tokens. Keys: the gateway key was read
from the one variable `AI_GATEWAY_API_KEY` in the gateway key file that `central/src/pipeline/llm.ts` names; the
labelling-service key was not needed. Nothing was printed.

## Same-or-new by rule (addendum 2, 11 November 2026)

No paid call. Pass rule, stated before the replay: false merges not above the current route on any set, and merge
recall not lower. One run.

**What changed in the client.** A new record whose quote is near-identical to a candidate's quote from the same kind
of source, where no guard blocks the pair and the quote names both records' subjects, is the same change by rule
(`local/cli/src/pipeline/matching.rs`, `by_rule`), with no model call on any route. A route read on its choices
(`gpt-6-luna`, Haiku, Codex) is then asked nothing: its "yes" is read at probability 0 by every guard, so it could
only ever merge a pair with a near-identical quote. A calibrated judge (the labelling service, Snap) is asked only
when the rule finds no candidate. An Anthropic key alone, which did not match at all, now matches by the same rule.

**Why the rule also asks that the quote name both subjects.** Without it, two different changes that share a
boilerplate quote ("Bug fixes", "Updated dependencies", a version-bump line, one deprecation sentence used for several
APIs) pass every guard: the unit test `the_rule_refuses_two_changes_that_share_a_boilerplate_quote` holds nine such
pairs, checks each would pass on its quote alone, and checks the rule refuses it. The test costs the rule 3 of 145
merges on the held-out set, all three audited same.

| Set | Route | Before | After | Paired | Requests sent |
|---|---|---|---|---|---|
| Held-out (236 items, 197 with a true match) | `gpt-6-luna` by choice | 141/197 = 71.6%, 0 false in 141 | **142/197 = 72.1%, 0 false in 142** | 3 true merges only before, 4 only after (McNemar p 1); false 0 and 0 | 235 → **0** |
| Held-out | Labelling service, stored answers | 171/197 = 86.8%, 1.4 false per 100 | **173/197 = 87.8%, 1.4 per 100** | 0 only before, 2 only after (p 0.5); false 0 and 0 | 235 → **93** |
| Held-out | Snap 1.2, stored answers (four candidates, its bars) | 170/197 = 86.3%, 0.3 per 100 | 171/197 = 86.8%, 0.3 per 100 | 1 item differs, a true merge gained | 236 → 94 |
| Dev (129 items, 109 with a true match) | by rule alone | not run on this split | 55/109 = 50.5%; 56 merges: 55 audited same, 0 different, **1 into a candidate no audit read** | | 127 → 0 |
| Dev | Labelling service, stored answers | 103/109 = 94.5%, 0 false in 103 | 103/109 = 94.5%; 104 merges, the same unaudited one | 0 and 0 true merges; 1 item differs | 127 → 71 |

- **Verdict by the rule: pass on the held-out set on every route. On the dev split the rule is not met as written**,
  because the scorer counts a merge into a candidate no audit read as a false one, and there is one:
  `next@16.3.8#0.2` ("Cache poisoning of SSG and ISR pages in self-hosted Next.js applications", subject "SSG and ISR
  pages") merges into `next:isr`, whose evidence is that same sentence from release 15.5.27 (summary "Security fix
  prevents cache poisoning of ISR pages in self-hosted Next.js applications."). The audit read another candidate for
  this item (`next:ssg-isr-rendering`, unsure) and the service made a new record. The two records quote one sentence
  of one security fix shipped on two release lines, which the judge's own rules call the same change; no audited
  verdict says so. No merge on any set went into a candidate an audit called different.
- **How it ran.** The client's `run-step --step match` over the held-out inputs of this file and over the dev split
  built the same way (`rule_dev_inputs.mts`: 129 items, 127 requests, all 127 byte-identical to the stored run's);
  the labelling service's stored answers given back through `recorder.py`; scored by `rule_score.py` (this file's
  scorer, on either split). The "before" columns are this file's own runs (`match-choice-fixed`, the replayed service
  cell) and, for the dev service row, the client at `5b7c36b` on the same replay. Snap's row is a replica of the
  client's rule and bars over slice 19's stored answers, outside the client (it reproduces the published 170/197 and
  0.3); `run-step` has no Snap route.
- **Limits of the sets.** Their pairs exist only where the service scored a candidate 0.5 or more, so they cannot show
  a rule merge the service would have scored low. The population replay below covers that.

### How often the rule decides on ordinary records

`rule_population.mts`: every stored record of four technologies ingested again from empty in ingest order, following
each store's own decisions (1,866 of 1,866 reproduce), with the rule applied to the candidates production asks about
(question floor 0.6). Labels are the stored record's.

| Technology | Records | With a question today | Rule decides | Same record the store merged into | Store merged elsewhere | Store made a new record |
|---|---|---|---|---|---|---|
| Nuxt | 794 | 669 | 143 (18.0% of records) | 142 | 0 | 1 |
| Next.js | 541 | 400 | 65 (12.0%) | 64 | 0 | 1 |
| Prisma | 253 | 145 | 0 | | | |
| NestJS | 278 | 158 | 0 | | | |
| All | 1,866 | 1,372 (73.5%) | **208 (11.1% of records, 15.2% of requests)** | 206 | 0 | 2 |

- The two the stores kept apart are `next@16.3.8#0.2` above and `nuxt@4.4.6#0.13` ("Use `statusCode` for nitro v2
  compatibility", subject `statusCode`, into the record of the same sentence, subject and summary from 3.21.6).
- The rule decides where release notes repeat a line across release lines (backports); a technology that does not
  backport gives it nothing. So the saving on a calibrated judge is **0 to 18% of records, 11% pooled**, not the 60%
  of the held-out set, whose items were chosen for having a likely match.
- **A published figure to correct:** the cost tables below count one same-or-new request per record. In this replay
  73.5% of records have a candidate at the question floor; the rest send nothing.

### Input tokens per package per year (114.6 records)

| Route | Step | Published below | As measured now, before the rule | With the rule |
|---|---|---|---|---|
| Key alone | Extraction | 53k | 53k | 53k |
| | Labels | 187k | 187k | 187k |
| | Same-or-new | 185k (1.29 calls per request, before PR #237) | 143k at 1.0 calls and one request per record; 105k at 0.735 requests per record | **0** |
| | All | 425k | 383k; 345k | **240k** |
| Labelling service + key | Extraction | 53k | 53k | 53k |
| | Labels | 241k | 241k | 241k |
| | Same-or-new | 184k | 135k at 0.735 requests per record | **115k** (0.624 requests per record; 0 to 33k saved by technology) |
| | All | 478k | 429k | **409k** |
| Snap + key | Same-or-new | 145k (1,263 per request) | 137k (a request whenever there is a candidate: 94.8% of records) | 121k (83.7%) |
| Anthropic key alone | Same-or-new | 0, no matching | 0, no matching | 0, matching by rule |

- Duplicates against the labelling service: a route by rule alone misses 55 of the 197 true merges against the
  service's 24 (with the rule ahead of it) or 22 (slice 5's run): 31 to 33 more over 867 records, **4.1 to 4.4 more
  per package per year**, as before ("about 4"). An Anthropic key alone goes from never merging (about 23 more) to the
  rule; the rule was measured on `gpt-6-luna`'s records, not Haiku's.
- Codex alone: same-or-new through Codex was an estimate inside the 482k for labels and matching and was never
  measured; it is no longer asked. The estimate is left as an upper bound.
- Not measured: the rule on records extracted by Haiku or through Codex; a first sync; Snap through the client.

Everything below is the first run, on `8835d5c`, as recorded before the fixes.

## Conclusions (first run)

1. **The port is faithful.** Given the same answers, the client reproduces central exactly: 815 of 815 requests to the
   labelling service are byte-identical to central's, and with central's stored answers replayed every one of 580
   records gets central's labels and every one of 236 judge items gets central's decision. Every prompt the client
   sent to `gpt-6-luna` on these sets (49 extraction prompts, 47 label-call prompts built from its own first answers,
   815 choice prompts) is the text central's code builds.
2. **By the pre-registered rule, parity fails on one cell of eight: matching on `gpt-6-luna` by choice.** The client
   merges 124 of 197 true matches (62.9%) where central's reference says 142 (72.1%). The diagnosis: this is not a
   port difference. In 23 of 235 judge requests the model answered with an option's text ("The same change as
   candidate c1.") instead of its key ("yes"); central's parser and the client's both discard such an answer, three
   attempts each. Central's reference number never met this, because it was measured with a different prompt. On the
   213 requests that were read, the client recalls 124 and central 125.
3. **So the published figure for matching without the labelling service is too good.** With the prompt production
   sends, an OpenAI-compatible key alone leaves about **6 more duplicate records per technology-year** than the
   labelling service, not "about 4" (and not the 2 the setup screen's table holds). No false merge was made (0 of
   124). The cause is one shared reading rule, described under "Differences" with a failing input; it is not fixed
   here.
4. **Extraction and labels on `gpt-6-luna` are within noise of central's runs** on both sets each (13 of 13
   intervals include 0).
5. **Batched Codex extraction loses recall, and should not be marked as equal to the direct route.** On the short
   notes it finds 53.5% of the labelled changes against 75.6% for the same client on the direct route and 66.3–67.4%
   for central's three direct runs; the interval excludes 0 against every one of them. The loss is in long chunks
   answered eight to a call: the longest chunk yields 14 records in a batch against 37 to 75 alone. Short notes are
   level, and precision is not lower.
6. **The setup screen's "≈ 93% of the best option's breaking-change flags" is measured against a threshold the client
   does not run.** The client reads the labelling service at 0.5, not 0.05. At 0.5 a key alone finds at least as many
   breaking changes as the service (details below); what it gives up is exactness: more of its flags are wrong.
7. **The labelling service has moved on from the version central's label numbers were measured with** (1.13.0 then,
   1.14.0 today): in a live sample, 8 of 50 records get a different label from the stored baseline. Central's
   published label figures for the service describe the old version.
8. **The gateway's flex tier did not lower the bill.** The client asks for flex on every gateway call; this run was
   billed $0.262 against $0.263 at list price. Quotes that assume half price on the gateway are not what was charged.

## Parity table

Central's number, the client's, the band (95% interval of the paired difference, client minus central's reference
run; replayed cells are exact), and the verdict by the pre-registered rule.

| Cell | Step | Route | Set | Metric | Central | Client | Band | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | Extraction | `gpt-6-luna`, gateway | Short notes | Recall, pooled | 66.3 | 75.6 | +9.3 [−2.5, +16.1] | pass |
| 1 | | | | Recall, mean per technology | 91.9 | 90.4 | −1.6 [−8.0, +3.6] | pass |
| 1 | | | | Recall, breaking changes | 82.9 | 74.3 | −8.6 [−28.6, +3.1] | pass |
| 1 | | | | Precision | 82.0 | 78.8 | −3.2 [−7.7, +3.6] | pass |
| 2 | Extraction | `gpt-6-luna`, gateway | Guides | Recall, required changes | 88.7 | 87.3 | −1.4 [−4.7, +1.1] | pass |
| 2 | | | | Recall, breaking changes | 86.4 | 85.7 | −0.7 [−4.0, +2.0] | pass |
| 2 | | | | Precision | 84.8 | 82.8 | −2.1 [−6.1, +2.3] | pass |
| 3 | Labels | Labelling service, stored answers replayed | Label set 1 | Breaking / benefit / actionable recall, change-type accuracy | 82.8 / 85.1 / 84.9 / 82.0 | 82.8 / 85.1 / 84.9 / 82.0 | exact: 233 of 233 records | pass |
| 4 | Labels | Labelling service, replayed | Label set 2 | Breaking recall / precision | 90.0 / 94.5 | 90.0 / 94.5 | exact: 347 of 347 records | pass |
| 5 | Labels | `gpt-6-luna` by choice | Label set 1 | Breaking recall | 86.2 | 89.7 | +3.4 [−10.3, +17.2] | pass |
| 5 | | | | Benefit recall | 96.7 | 98.3 | +1.7 [0.0, +4.1] | pass |
| 5 | | | | Actionable recall | 89.0 | 87.7 | −1.4 [−4.1, 0.0] | pass |
| 5 | | | | Change-type accuracy | 85.0 | 83.3 | −1.7 [−5.6, +2.1] | pass |
| 6 | Labels | `gpt-6-luna` by choice | Label set 2 | Breaking recall | 92.6 | 92.6 | 0.0 [−3.9, +3.0] | pass |
| 6 | | | | Breaking precision | 92.2 | 93.4 | +1.2 [−0.6, +3.7] | pass |
| 7 | Matching | Labelling service, replayed | Matching set | Merge recall; false merges per 100 | 171/197 = 86.8%; 1.4 | 171/197 = 86.8%; 1.4 | exact: 236 of 236 items | pass |
| 8 | Matching | `gpt-6-luna` by choice, production rule | Matching set | Merge recall | 142/197 = 72.1% | 124/197 = 62.9% | −9.1 [−14.2, −4.6], McNemar p 0.0005 | **fail** |
| 8 | | | | False merges per 100 merges | 0.0 | 0.0 | McNemar p 1 | pass |

Cells run: 9 of 9 planned (8 parity cells and the Codex cell). Parity cells passing: 7 of 8.

Reading the table:
- **Cell 1.** Central's three runs sit at 66.3, 67.4 and 66.3 pooled; the client's 75.6 comes from one 30,000-character
  chunk of one note (zod 4.5.0), which gave 75 records in this run against 46 and 37 in central's two gateway runs.
  The prompt for that chunk is byte-identical, and nothing was cut short or split. Central's results already name this
  kind of effect ("single 30k chunks answered differently"). The breaking figure, 74.3, is the same 26 of 35 that central's
  own direct-route run found.
- **Cells 3, 4, 7** are exact because the answers are central's own, given back only to requests whose bytes equal
  central's. Three of 233 and 13 of 347 label answers differ from the stored text in the last digit of one
  probability (see "Differences"); no label moves.
- **Live samples of the labelling service** (25 items per cell, not part of the rule): every request was answered.
  Labels were served by 1.14.0 against a 1.13.0 baseline and 5 of 25 and 3 of 25 records changed a label; matching
  was served by the same version as its baseline, 1.14.0, and 0 of 25 decisions changed.

## Batched Codex extraction against the direct route (short notes)

`--provider codex`: extract calls go eight chunks to a call, label calls one chunk each. Plan-billed.

| Run | Recall, pooled | Recall, mean per technology | Recall, breaking | Precision | Records |
|---|---|---|---|---|---|
| Codex, batched 8 | 53.5 | 82.7 | 68.6 | 88.3 | 162 |
| Client, direct (cell 1) | 75.6 | 90.4 | 74.3 | 78.8 | 259 |
| Central, gateway | 66.3 | 91.9 | 82.9 | 82.0 | 222 |
| Central, gateway, replicate | 67.4 | 91.7 | 85.7 | 81.1 | 228 |
| Central, direct OpenAI route | 66.3 | 92.5 | 74.3 | 83.2 | 214 |

| Codex minus | Recall, pooled | Mean per technology | Breaking | Precision |
|---|---|---|---|---|
| Client, direct | **−22.1 [−33.9, −1.8]** | −7.7 [−16.7, +1.5] | −5.7 [−22.7, +10.3] | +9.5 [−4.9, +16.6] |
| Central, gateway | **−12.8 [−18.1, −4.0]** | **−9.3 [−16.7, −3.4]** | **−14.3 [−35.0, −5.0]** | +6.3 [−4.8, +12.8] |
| Central, replicate | **−14.0 [−20.3, −4.2]** | **−9.0 [−16.1, −2.9]** | **−17.1 [−30.8, −5.0]** | +7.1 [−5.2, +14.9] |
| Central, direct | **−12.8 [−19.7, −5.3]** | **−9.8 [−17.4, −3.8]** | −5.7 [−31.8, +8.5] | +5.1 [−5.9, +12.2] |

- Records by technology, Codex against the client's direct run: zod 96 against 188; posthog-js 25 against 29; uvicorn
  25 against 26; typer 16 against 16. The loss is zod, whose notes are long.
- The longest chunk (29,820 characters) gave 14 records in its batch; alone it gave 75, 46 and 37.
- Nothing failed and no call was refused: 6 batch calls and 40 label calls, all read. The model simply writes less
  when eight chunks share a call: 20.6k output tokens for the whole set against 56.6k on the direct route.

## Spend

| Cell | Calls | Input (cached) / output (reasoning) tokens | $ at list | Billed to |
|---|---|---|---|---|
| 1 Extraction, short notes | 82 | 172,943 (0) / 56,645 (18,646) | 0.046 | gateway |
| 2 Extraction, guides | 14 | 115,543 (0) / 70,241 (2,715) | 0.047 | gateway |
| 5 Labels by choice, set 1 | 233 | 378,560 (0) / 24,025 (11,186) | 0.050 | gateway |
| 6 Labels by choice, set 2 | 347 | 567,274 (0) / 44,841 (25,387) | 0.079 | gateway |
| 8 Matching by choice | 305 | 381,444 (88,443) / 21,745 (6,208) | 0.041 | gateway |
| Diagnosis, 3 requests resent | 3 | 4,430 / 278 | 0.0004 | gateway |
| 3, 4, 7 live samples | 75 | 145,528 / 0 billed | 0.006 | labelling service |
| 3, 4, 7 replayed | 815 | 0 | 0 | none |
| 9 Extraction through Codex | 46 | 344,804 (148,736) / 20,577 | 0 | Codex plan: 365,381 tokens |
| **Total** | | 1.77M in / 218k out on paid APIs | **$0.27** | of a $3 cap |

Gateway balance: $2.7562 before the first call, $2.4943 after the last: **$0.2619 billed**, against $0.2628 at list
price for the same tokens. The estimate was $0.31.

## Measured cost per technology-year

A mean technology-year is central's: 6,460 note tokens in 17.5 chunks, 114.6 records (`slice3/cost3.py`).
Extraction uses that file's formula with the client's measured output per record and attempts; labels and matching
are measured tokens per record or per request × 114.6. Dollars at list price, which is what this run was billed.

| Step and route | Tokens in / out | $ | The setup screen's table today |
|---|---|---|---|
| Extraction, `gpt-6-luna` | 53.3k / 17.6k (guides) to 25.1k (short notes) | 0.014 to 0.018 | $0.0192 list, $0.0096 flex |
| Labels, labelling service | 241k / none billed | 0.0101 | $0.0100 |
| Labels, `gpt-6-luna` by choice | 186k to 187k / 11.8k to 14.8k | 0.025 to 0.026 | $0.0261 list, $0.0182 billed |
| Matching, labelling service | 184k / none billed | 0.0077 | $0.0081 |
| Matching, `gpt-6-luna` by choice | 185k (23% cached) / 10.6k, 1.29 calls per request | 0.020 | $0.0455 list, $0.0269 flex |
| Extraction, Codex batched 8 | 152k plan tokens, harness included (62k of them cached input; 8.6k output) | 0 billed; ≈ 0.013 at API prices | 109k tokens, $0.0198 |

| Route (all three steps) | Tokens in / out | $ per technology-year |
|---|---|---|
| Labelling service + OpenAI-compatible key | about 478k / 18k to 25k | **0.032 to 0.036** |
| OpenAI-compatible key alone | about 425k / 40k to 50k | **0.059 to 0.064** |
| Labelling service + Codex | 425k service input; 152k plan tokens | **0.018**, plus the plan tokens |
| Codex alone | extraction 152k plan tokens | labels and matching through Codex were not run here |

- Matching by choice costs less than half the table's figure: production's request is shorter than the one central
  costed (fewer candidates asked, choices only), even with a quarter of the requests retried.
- The flex figures in the table should go: flex was requested on every call and the bill equals list price.
- The Codex figure is from short notes, whose chunks are about 2.7 times the mean chunk; per mean chunk it would be
  lower, but most of it is the harness's fixed input per call.

## The "≈ 93%" line on the setup screen

- **What it is:** 86.2% (central's choice run) over 93.1% (the labelling service at a breaking threshold of 0.05) on
  label set 1.
- **Which threshold the client runs for the labelling service:** 0.5 (`breaking_p` and `benefit_p` in
  `schema/prompts/thresholds.json`, applied in `local/cli/src/pipeline/labels.rs` `interpret`). 0.05 was a fit on a
  dev set that central's results call unshippable; at 0.05 the service flags 70 records to find 27 of 29.
- **The figure at 0.5:**

  | Set | Breaking changes | Service at 0.5: found, flags raised | Key alone, central's run | Key alone, the client's run |
  |---|---|---|---|---|
  | Label set 1 | 29 | 24, 32 flags (75.0% right) | 25, 37 flags (67.6%) | 26, 42 flags (61.9%) |
  | Label set 2 | 230 | 207, 219 flags (94.5% right) | 213, 231 flags (92.2%) | 213, 228 flags (93.4%) |

  A key alone finds 103% to 108% of the breaking changes the service finds; the paired interval of the difference
  includes 0 on both sets (set 1 +6.9 [−6.9, +20.7], set 2 +2.6 [−1.0, +5.1]).
- **The right line:** not "≈ 93% of the best option's breaking-change flags". A key alone finds **about as many
  breaking changes (≈ 100%)** and raises more wrong flags: on short release notes about 2 in 3 of its breaking flags
  are right against 3 in 4 for the service; on upgrade guides 92 to 93 in 100 against 94 to 95. The trade to state is
  exactness, not completeness.
- **Caveat:** the service column is version 1.13.0. No full run of the label sets on 1.14.0 exists; the ratio should
  be re-read when one does.

## Differences between the ports, and whether they explain a gap

| # | Difference | Failing input | Explains a gap? |
|---|---|---|---|
| 1 | **Not a port difference, but the cause of cell 8.** A choice answer that gives an option's text instead of its key is discarded by both parsers: `ChatClassifier` in `central/src/pipeline/classify/adapter.ts` (`Object.hasOwn(q.options, choice)`) and `read_choices` in `local/cli/src/pipeline/labels.rs`. The prompt (`schema/prompts/choice.json`) lists each question's options as `{"yes": "The same change as candidate c1.", "no": "A different change from candidate c1, or unsure."}` and says "picking exactly one of its options" without saying to answer with the key | Matching set item `nuxt@4.3.0#0.3` (3 candidates asked). Answer: `{"same_c1":"The same change as candidate c1.","same_c2":"A different change from candidate c2, or unsure.","same_c3":"A different change from candidate c3, or unsure."}`. Read as no answer, three times; the item is stored as failed and its record is not merged | **Yes, all of cell 8's gap**: 23 of 235 requests, 21 of them with a true match, 17 of them merged in central's reference run. Labels by choice were not affected (580 of 580 read on the first call) |
| 2 | The client reads some probabilities one unit in the last place away from the text (`serde_json` without exact float parsing) | The service's `"code_api": 0.45999999999999996` is kept as `0.46` | No. 16 of 580 label answers differ this way; no label and no decision changed. A probability within one unit of a threshold could in principle fall on the other side |
| 3 | The client's extraction splits a chunk whose answer runs out of room and extracts the pieces (as central's production does); central's evaluation harness failed such a chunk | None occurred: no answer was cut short on either set | No |
| 4 | One provider call may take 300 s on the client; central's harness allowed 600 s | None occurred (the slowest calls, on the guides, took about a minute) | No |
| 5 | `run-step --step match` prints an empty `judged` list for a request with no candidate above the question floor; central's `pick` lists each candidate as "unasked" | Matching set item `nuxt@4.3.1#0.1` | No: the decision (no merge) is the same |
| 6 | `run-step --step match` retrieves again from the candidates it is given and passes no record sources, so central's exception for the same subject in another chunk of one document cannot apply there | None in this set: 235 of 235 requests came out byte-identical | No |
| 7 | Batched Codex extraction puts any eight chunks in one call (`Extractor::prefetch`), whatever their length; central never batched extraction | zod 4.5.0, chunk 1 (29,820 characters): 14 records in a batch, 37 to 75 alone | It is cell 9's loss |

For running `run-step` on central's stored data: `match` candidates must be in the catalog's record shape (terms as
`[term, count]`; central's `shardLine` gives it), and an input line that does not parse ends the command with exit
status 1.

## What this run does not show

- Labels and matching through Codex, and a first sync, were not run (not in this experiment's cells).
- An Anthropic key alone and OpenRouter were not run.
- The labelling-service cells are exact for the port, on central's stored answers. Only 75 requests went to the live
  service.
- Cell 8's central reference used another request; no central run on production's own request exists to compare
  with. The answered-items comparison (124 against 125) is descriptive.
- 15 intervals were read on the live parity cells; one excluding 0 by chance would not be surprising. The one that
  does (cell 8) has a mechanical cause.

## Files

- `PREREGISTRATION.md`: sets, cells, references with their sources, bands, pass and stopping rules, cost estimate.
- `inputs-manifest.json`: counts and hashes of the five input files `build_inputs.mts` writes.
- `results/summary.json`: every number above; `results/<cell>.json` per cell; `results/diagnosis.json` the diagnosis
  pass; `results/table.md` the parity table as scored.
- `build_inputs.mts`, `recorder.py`, `run_cell.sh`, `score.py`, `central_match_rows.mts`, `check_label_prompts.mts`,
  `analyze.py`, `diagnose_request.mts`: the harness. Raw outputs and caches are under `out/` (not committed).
