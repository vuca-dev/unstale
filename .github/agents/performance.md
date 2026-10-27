# Lane: performance

Find and ship the highest-ROI performance improvement across the whole repository, not only what changed. Weigh
first what users and developers wait for:

- Time to first useful result: `unstale init`, onboarding a repository, the first coverage answer for a new
  package (registration to published decision).
- The CLI's own latency and memory (`local/`).
- Central's throughput: crawl and fetch efficiency (requests, bytes and pages fetched per useful record, wasted or
  repeated fetches, parsing far more than is used), pipeline step times, API calls per technology.
- The gateway Worker's latency and its Durable Object reads and writes against platform limits.

Use the observations (`$OBS_DIR`): ingest step durations, Usage output and gateway analytics show where time and
requests go. A skewed distribution (one technology or one step dominating) is the best lead. Measure before and
after on this runner and put both numbers in the PR. A change that can alter results follows the accuracy rules.
