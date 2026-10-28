# cost agent log

## Revisit
- 2026-10-28: rank `provider-usage vercel` by stage once PR #178 has run a few days: if `terms` (label call, resends the notes) is a large share of input, try the label call as a second turn after the extract answer so prompt caching bills the notes at 10% (prompt change: eval + gate, and every cached label answer is invalidated); if the fallback `labelling`/`matching` rows are large, revisit the Jev-disable rule (10 consecutive fallbacks disables Jev for the run, so the rest is paid at gpt-6-luna input+output)
- 2026-10-27: backported note items (Electron's "Also in N" lines) go through extract, label and match once per release line: Electron monitoring was 904 labelling + 866 matching Jev calls in 4 of 25 runs (6% of 29,299 Jev calls, about $0.15); worth it only if its extraction share is large (now measurable per technology and stage)
- 2026-10-27: labelling's 8 questions are 6.4 KB of each Jev request (about 75% of its ~2,100 input tokens); trimming is a prompt change (eval + gate) for at most ~$5/month at $0.042/M

## Entries

### 2026-10-28 · Extraction spend had no stage or source
- Tried: read the Usage step of run 40594841072, the first with `provider-usage vercel` (PR #176): 176 calls, $0.049, every row stage `unknown` and source `unknown`, technology as the job slug (not the display name Jev's lines use). Over the 8.7 phased days the gateway took $9.35 of $21.29 (38,677 calls, ~1,490 input and ~560 output tokens per call; output ~60% of its dollars). Checked the prompt-caching idea: the extract prompt's static text is under the 1,024-token cache minimum and `Technology:` sits on line 3, so nothing is cached today. 23 of 73 cancelled ingest runs had no jobs (concurrency), so they cost nothing.
- Found: three levers (label call as a cached second turn, the gpt-6-luna fallback classifier after `jev-disabled`, which happened 9 times in the log, and docs against release notes) can't be ranked without a per-stage split. No other step calls the gateway.
- Chosen: `extractLlm` attribution (usage line only, outside the request and the cache key): `extraction` / `terms` with source and display name; the fallback classifier logs `classifierAttribution`. 528 tests pass, $0 model spend. PR #178
- Outcome: from PR #178, `provider-usage vercel` ranks extraction spend by stage (extraction, terms, labelling/matching fallback) and source; read it before choosing an extraction lever

### 2026-10-27 · Spend survey: no lever clears the bar
- Tried: read the ingest Usage output (run 40538916421) and `jev-usage` from 25 successful ingest runs (2.5 days), the per-cycle metrics, 523 coverage_stages events, gateway analytics, the price list and the selection slices.
- Found: phased spend over 8.4 days is $21.08: onboarding $13.08 ($0.0087 per onboarded technology, 1,497 onboarded), monitoring $8.00 ($0.134 per technology-year, 2,598 monitored); Jev $11.83 (input-only at $0.042/M), extraction on gpt-6-luna flex $9.25. The $25.11 "unattributed" (codex $11.45) is from before phases were recorded, and no step calls Codex now. Jev over 25 runs: $2.42 / 29,299 calls with no technology above 6%. Free tiers have wide headroom: Worker ~14k requests/day, DO rows ~2k read / ~650 written per day (allowance 5M / 100k), DO storage 16 KB; GitHub API ~340 requests/hour from ingest. The docs pass dominates refresh wall time (5,586 s of 10,151 s summed) but already shares pages across technologies and answers conditional requests. Extraction prompt and output levers (diet, ids, one-call, section diet) already failed on quality in slice 3c / labels; a subq-snap-1.1 swap is 5% cheaper than Jev (~$1/month). The agent-facing report already has A/B-fitted byte budgets.
- Chosen: none: the largest remaining lever is a few dollars a month and moves labels or extraction
- Outcome: live model spend is ~$2.5/day (~$76/month), roughly half Jev and half flex extraction; next lead needs per-technology extraction attribution
