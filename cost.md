# cost agent log

## Revisit
- 2026-10-27: per-technology attribution of extraction (vercel) spend, like `jev-usage` does for Jev: the Usage step gives vercel only by phase ($9.25 of $21.08 live over 8.4 days, 60% of it output tokens), so no technology or source can be ranked yet; the usage log (draft state release) is not readable with the agents' token (needed to find the next lead)
- 2026-10-27: backported note items (Electron's "Also in N" lines) go through extract, label and match once per release line: Electron monitoring was 904 labelling + 866 matching Jev calls in 4 of 25 runs (6% of 29,299 Jev calls, about $0.15); worth it only if its extraction share is large (needs the attribution above)
- 2026-10-27: labelling's 8 questions are 6.4 KB of each Jev request (about 75% of its ~2,100 input tokens); trimming is a prompt change (eval + gate) for at most ~$5/month at $0.042/M

## Entries

### 2026-10-27 · Spend survey: no lever clears the bar
- Tried: read the ingest Usage output (run 40538916421) and `jev-usage` from 25 successful ingest runs (2.5 days), the per-cycle metrics, 523 coverage_stages events, gateway analytics, the price list and the selection slices.
- Found: phased spend over 8.4 days is $21.08: onboarding $13.08 ($0.0087 per onboarded technology, 1,497 onboarded), monitoring $8.00 ($0.134 per technology-year, 2,598 monitored); Jev $11.83 (input-only at $0.042/M), extraction on gpt-6-luna flex $9.25. The $25.11 "unattributed" (codex $11.45) is from before phases were recorded, and no step calls Codex now. Jev over 25 runs: $2.42 / 29,299 calls with no technology above 6%. Free tiers have wide headroom: Worker ~14k requests/day, DO rows ~2k read / ~650 written per day (allowance 5M / 100k), DO storage 16 KB; GitHub API ~340 requests/hour from ingest. The docs pass dominates refresh wall time (5,586 s of 10,151 s summed) but already shares pages across technologies and answers conditional requests. Extraction prompt and output levers (diet, ids, one-call, section diet) already failed on quality in slice 3c / labels; a subq-snap-1.1 swap is 5% cheaper than Jev (~$1/month). The agent-facing report already has A/B-fitted byte budgets.
- Chosen: none: the largest remaining lever is a few dollars a month and moves labels or extraction
- Outcome: live model spend is ~$2.5/day (~$76/month), roughly half Jev and half flex extraction; next lead needs per-technology extraction attribution
