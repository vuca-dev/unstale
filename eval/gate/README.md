# Release gate

`eval/gate/run_gate.sh <catalog-dir> <label>` reruns the expanded replay (15 events, DEV 9 and HELD-OUT 6) on the
order **the shipped CLI** hands a user. It writes `results/<label>.{json,md,summary.json,agree.json}`. When
`results/baseline.json` exists, the tables show deltas against it. Compare any later catalog or CLI build to the
baseline this way. Do not reuse the earlier harness-queue numbers.

`GATE_K=0` runs the order only: the CLI's queue is scored for key changes covered, queued and in the first batch, with
no review calls (and no model calls when the match maps are reused). It takes minutes and is the check for ranking
changes; reviews are needed only for claims about what an agent finds.

- `gate.py`: the stages (`cliqueue`, `agree`, `match`, `review`, `score`). It imports the replay
  (`eval/replay/run_replay.py` over `~/ati-slice0/harness`) read-only.
- `score.py`: tables per split and required/optional, with run-to-run spread and deltas against a baseline.
- `match/<event>.json`: the replay's two Codex match runs per event. The gate reuses them when the event's window
  catalog is identical, so the same catalog costs no match calls.
- `MISSES.md`: why the required changes are missed (bucketed), and what each fix is worth.

## How the CLI's order is taken (no CLI change)

In a `cp -cR` copy of the event repository at P (the snapshot the review sees), the gate runs:

1. `unstale init --catalog <copy> --yes`, then `sync`.
2. `review --pass upgrade-review --target <pkg>@<new>` for each of the technology's packages (next; prisma and
   @prisma/client; @nestjs/core and @nestjs/common).
3. It reads the batch ids from `.unstale/state/review.json` and marks each `decide <id> do-now`.
4. `review --next`, repeated until the queue is empty.

Do-now lives in review state, not the ledger, so it never changes the funnel's order. Batch k is positions 16(k−1)+1
to 16k of the one order, and the concatenated batches are the CLI's whole upgrade-review queue. `UNSTALE_TODAY` is fixed
at 2026-10-15. No CLI flag was added: `main.rs` has another session's uncommitted onboarding work in it, and agent B
owns `funnel.rs`. A new build is measured by pointing `UNSTALE_BIN` at it, or by letting the script build the working
tree.

The gate scores the **event technology's** records in that order, which is the same as pinning the other catalog
technologies at their installed versions: ordering is per technology, and siblings share a component. The first 16
**as invoked** (other technologies at their default target, the newest release, sharing the batch) is reported
alongside.

## Agreement: replay (harness) queue vs the CLI, before this gate

The harness queue is `eval/rarity-sample/rarity_queue.py --weights fallback`, the edge's weighting at `sample_n = 0`.
Its type-tier order is what `RESULTS-expanded.md` reports as v2-no-sample.

| | Sum over 15 events |
|---|---|
| Harness queue / CLI queue (event technology) | 1,591 / 853 |
| Harness records that are obligations (breaking, removal, deprecation) | 845 |
| In both | 836 (CLI: 17 not in the harness queue; harness obligations: 9 not in the CLI's) |
| First-16 overlap (type-tier order vs CLI order) | 152 of 240 (63%); per event 5 to 15 |
| Required key changes in the first 16 | harness 40 (DEV 32, HELD-OUT 8); **CLI 33** (DEV 28, HELD-OUT 5) |

Why they differ:

1. **What enters the queue.** The CLI's upgrade review holds obligations only. The harness queue also holds
   behaviour, default, new-API and tooling records, about 47% of it. Three DEV required changes covered only by
   non-obligation records are therefore not in the CLI's queue at all (invoicerr-nest12 K9, K10, K12).
2. **Installed version.** The CLI reads the lockfile, or for a library the declared range floor (`peerDependencies`).
   The harness uses the event's locked `old`. Examples: temporal-nest12 is a library with peer floor 9.0.0, so 3
   records from before 11.2.5 enter. payloadplugins reads 15.0.0, chmonitor 15.3.1 and jsontypes 6.14.0.
3. **Applied check.** The harness's `orig` funnel also drops breaking records whose introduced literal is present.
   The CLI never drops a breaking record. This explains `prisma:output`, `prisma:prisma.config.ts~2` and
   `next:images.localpatterns` in the CLI's queue only.
4. **Blocked prerequisites.** The CLI blocks a record whose Node or TypeScript minimum is above the project's lowest
   floor. That removes the Node-minimum obligation itself (`*:node.js*` in 8 events, `next:typescript` in coh2stats).
   This is a funnel bug (MISSES.md).
5. **Order within a tier.** The two sides weigh matches differently:
   - Usage text: the CLI scans every code and config file, workflows included. The harness scans files that
     mention the technology's reference names.
   - Excluded terms: the CLI excludes the technology's package names; the harness excludes its reference list.
   - The CLI puts `requires`-miss records last.
   - The CLI groups siblings.
   - Ties: the CLI breaks them by id; the harness shuffles.

   Next.js and Prisma queues are about 95% tier 1, so these differences decide the first 16.
6. **Other technologies as invoked.** Their records share the batch: 3, 6 and 8 of 16 in workout, invoicerr-prisma7
   and sigle.

**After:** the gate's queues are the CLI's own output (`queue_cli.json` per event keeps the binary's sha256), so
agreement is exact by construction. The review arms see the CLI's first 16 (`tier`) and its whole queue (`all`),
rendered with the replay's skill text and record rendering so the numbers stay comparable with the replay's review
runs.

## Metrics (score.py)

Per split (DEV, HELD-OUT, ALL) and class (all, required, optional):

- **Deterministic:** key changes covered (both match runs), in the CLI queue, in the CLI's first 16, and in the first
  16 as invoked.
- **Per arm, K runs:** found (a key change whose entry the review proposed, do now or later), summed over events per
  run, as mean [min to max] and sd. Found with do now. Unstable = found in some runs but not all.
- **Developer noise:** "do now" proposals on entries no key change maps to, per review.
- **Cost:** review input tokens per key change found.

## Baseline (published catalog, CLI at 2877f2c, K = 3), `results/baseline.*`

Required key changes. The found columns are mean [min to max] over 3 runs.

| Split | Covered | CLI queue | CLI first 16 | `tier` review found | `all` review found |
|---|---|---|---|---|---|
| DEV (72 required) | 49 | 43 | 28 | 26.3 [26–27] | 37.0 [35–39] |
| HELD-OUT (22) | 11 | 11 | 5 | 4.0 [4–4] | 9.7 [9–10] |
| ALL (94) | 60 | 54 | 33 | 30.3 [30–31] | 46.7 [45–49] |

- **Developer noise:** "do now" outside the key, per review: `tier` 2.1, `all` 3.2.
- **Cost:** input tokens per key change found (all classes): `tier` 74.6k, `all` 71.3k (DEV 60.8k / 57.7k; HELD-OUT
  145.7k / 118.0k). Most of these are cached input tokens.
- **Run-to-run:** sd of found per run (all classes, ALL): `tier` 2.4, `all` 1.6. Key changes found in some runs but
  not all: `tier` 7, `all` 17.
- **Reproduction:** rerunning `run_gate.sh` on the same catalog and binary from a fresh work dir gives identical
  per-review results with 0 new Codex calls.
