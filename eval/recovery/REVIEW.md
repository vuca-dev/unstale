# Review close-out

The review on fcdb5af raised 20 findings. All were addressed in the integration candidate before release:

| Area | Correction | Validation |
|---|---|---|
| Call arity | End bracket-optional state at `]`; the following callback is required | Existing arity regression now requires minimum 2 |
| Advisory counts | Count a fixed advisory and its restatement once | Restatement regression expects one security item and one separate fix |
| Advisory routes | Withheld, blocked and unknown-version records cannot suppress an active security reason | Regression exercises all three excluded routes |
| Type stubs | Use own-property checks for declarations such as toString | Injected tarball regression |
| Partial type-stub reads | Do not persist a partial stub or its ingested keys; retry the complete read | Injected mid-line failure followed by recovery |
| Backfill lock | A partial advisory-API backfill takes the technology lock | Same lock as the production command |
| Chunk measurement | Mutate only the in-memory store, with production's display name; preserve original summaries for reporting | Same classifier path and thresholds as production; syntax check |
| Alias failures | Log the failed advisory ID and error, leaving it uncached for retry | Source inspection; no network required |
| Prompt interpolation | Insert advisory text using a literal replacement function | Dollar-metacharacter regression |
| Extraction failure | Preserve previous APIs on failure; remove them on a successful empty response | Failure/empty distinction regression |
| Measurement arguments | Option values are not mistaken for the output path | Argument parser corrected |
| Measurement package order | Registry descriptor components precede observed package URLs, as in production | Same package ordering as the stage |
| Measurement size | Remove the misleading summary-only chars field | Field removed |
| Empty stores | Type-stub and advisory backfills are no-ops with no records directory | Both commands exercised on a new empty store |
| Grouped snapshots | Judge the evidence belonging to the shared snapshot, including a later evidence entry | Chunk regression starts with unrelated earlier evidence |
| Merged metadata | Both duplicate passes preserve replacements, requirements, introduced APIs, conditions, prerequisites and benefits | Chunk regression pins all fields; split regression retained |
| Job record count | Recount active records after adding type-stub deprecations | Same active-count rule as duplicate merging |
| Advisory scope | Look up API names only in indexes containing the affected package | Two technologies share an advisory ID in a regression |
| CLI API flags | Preserve `--` and require a whole flag on a command line running the package | Reject bare identifiers, longer flags and another command |

For validation, the already measured deduplication fixture was upgraded with `restore-merge-metadata.mts`, using the
original active records to restore metadata before their merge stubs. This updates 48 merged records across 19
technologies without new model calls. The final gate and panel must use that fixture and the reviewed client.
