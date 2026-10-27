# Lane: qa

Find the bugs that the past week's runs actually hit, and fix the top one to three by ROI, done well: root cause,
a regression test each, no unrelated changes. Fewer, solid fixes beat more, shallow ones; list the rest under
`Revisit` with their evidence.

Sources, in `$OBS_DIR`:

- `runs-summary.txt`: every workflow's runs this week by conclusion.
- `failed-*.log`: the failed steps of failed runs.
- `usage-*.txt` and `steps-*.txt`: the ingest runs' Usage output and step durations (a step that suddenly takes
  much longer, errors counted in its output, retries).
- `gateway-analytics.txt`: the Worker's invocations by status and the Durable Object's activity (error statuses,
  exceptions, spikes).

`gh` can read more (`gh run view <id> --log`, the ingest runs' other steps). An anomaly that is by design (a run
cancelled by its concurrency group, a budget stop) is not a bug; check the workflow's comments before calling it
one. Rank by user impact × frequency, then by how surely you can fix it.
