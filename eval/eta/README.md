# Completion estimates for coverage jobs (H6)

Question: can central tell a user how long shared coverage will take, as a **range**, without inventing it?
(Onboarding hypothesis H6.)

**Data.** `central/src/onboarding/service.ts` appends one line to `.store/central/onboarding/timeline.jsonl` on every
saved job state: public identity, state, records, release and docs counters, time. Nothing about any repository.
Recording started 15 October 2026; the running coverage service writes it after a restart.

**Pre-registered rule** (written before any timeline data existed). A range may be shown only if, over at least 30
jobs that reached `monitoring`, an interval fitted on the earlier half holds the actual duration of at least 80% of
the later half. The interval is the per-unit p10 and p90 (seconds per release and per docs page) times the job's
planned units, plus the queue wait's p10 and p90. (The first draft used p50–p80, which cannot cover 80% of outcomes by
construction; it was corrected on synthetic data before any real timeline existed.) Otherwise the client keeps showing observed progress only: records
so far and time elapsed.

**Also reported:** spread per unit (p80/p50). A ratio above about 2 means queueing or the model budget dominates,
and the hypothesis says to fall back to "shared work, queue position N".

```sh
python3 -I eval/eta/analyze.py [timeline.jsonl] [--json out.json]
```

The jobs come from real onboarding. To reach 30 completed jobs sooner, onboard a stratified subset of `eval/repos/`
(by ecosystem and size), which keeps the sample representative rather than all from one stack.
