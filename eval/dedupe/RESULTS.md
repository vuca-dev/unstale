# Duplicate records from one release body

Known bugs 2.5: "valibot duplicate records" and "duplicate records per feature" (QA 2026-10-19, gutenberg attempt 29;
sveltejs/kit attempt 57). Measured on a copy of the full store (`~/unstale-full-store`, 97,501 active records in
2,703 technologies).

## Causes

`match.ts retrieve` never offers a record holding evidence from the same document snapshot as a candidate: "the
extractor separated those changes itself". That assumption fails in two ways.

1. **One item, one record per API.** The extractor sometimes cuts one release-note item into one record per API it
   names, each with the item's quote and the same summary. Example: valibot 1.5.0, "Add `codePoints`,
   `maxCodePoints`, `minCodePoints` and `notCodePoints` validation actions", became four records with the summary
   "Adds a validation action to validate the number of Unicode code points." Ingest never compared them.
2. **One change, two chunks.** A release body over `MAX_CHUNK` (30,000 characters) is extracted in parts, so the
   extractor never sees its highlights and its commit list together. Example: zod 4.5.0 gave `z.compile`
   (highlights, chunk 0) and `z.compile~2` ("feat(v4): z.compile — ahead-of-time schema compilation", chunk 1), with
   benefits `performance, cost` and `none`.

## Fix

- **Split items** (`mergeSplitRecords`, deterministic, no model call). Active records sharing an evidence entry
  (snapshot and normalised quote) with the same summary, change_type and breaking flag merge into the first one
  extracted, when the quote names each one's subject (or its last segment). The other subjects join its terms, and
  replaces, requires, introduces, conditions, prerequisites and benefits are unioned. Without the subject rule, two
  yt-dlp extractor fixes quoted only as "Fix extractor" merged; the rule leaves 327 records apart.
- **Other chunks** (`otherChunkSameSubject`). At ingest, a same-snapshot record from another chunk with the same
  subject and facet is now a candidate. Within one document the quote guard does not apply (two sections word a change
  differently), so the judge must reach the cross-source bar (`CROSS_SAME_P`, `CROSS_SAME_P_SHORT`).
- **Backlog** (`mergeChunkDuplicates`). Pairs ingested before this change are asked once each with the same request,
  rules and guards, recorded in history (`chunk-match`), and merged when judged the same.

Both passes run after ingest in the pipeline and the onboarding service. `npm run catalog -- dedupe --all` runs them
alone.

## Measured (full store copy)

| | Pairs | Merged | Model calls |
|---|---|---|---|
| Split items | one item's quote naming each subject | 1,461 records | none |
| Other chunks (backlog) | 528 judged | 158 records (182 pairs judged same before merges reorder groups) | 528 Jev requests, about 600 input tokens each (0.3M Jev tokens, about $0.013 once) |

- New ingests add no request: the candidate joins the request ingest already sends (a few more questions).
- Precision, read by hand: of 30 random split merges before the subject rule, 29 were one item cut per API and 1 was
  the "Fix extractor" pair. All 30 of a fresh sample after it were one item cut per API. 25 random chunk merges and
  the 30 lowest-p ones (p 0.80 to 0.93) were all the same change. Below the bar, 304 pairs stay apart; the sampled ones are
  separate fixes to one API (`torch.compile`, astro `ClientRouter`) or a different behaviour of one feature.
- valibot `codePoints`: one record, the other three subjects in its terms. zod `z.compile~2` merged into `z.compile`
  at p 0.99.

## Release gate (`GATE_K=0`, full-store catalog after both passes, main client 0.2.7)

| | DEV required in CLI first 16 | HELD-OUT |
|---|---|---|
| full store (#147 reference) | 27/72 | 6/22 |
| this change | **27/72** | **6/22** |

No required key change moves. The catalog window changed for most events, so their Codex matches ran again. On a first
run, before the subject rule, one fresh match run left `prisma:driver-adapters` out of cedar-prisma7 K10's map: DEV
26/72. That record was unchanged and still 4th in the CLI's queue, and scoring with the full store's match maps gave
27/72.
