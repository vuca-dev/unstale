# Lane: cost

Find and ship the highest-ROI cost reduction, measured in tokens and resource usage rather than performance:

- Model spend: tokens per technology and per step (the ingest Usage output in `$OBS_DIR`), prompt and context size,
  caching, calls that could be skipped or batched, and the model used for each step. A cheaper or newly available
  model is in scope, with evidence that quality holds (accuracy rules).
- Crawling and parsing: pages, bytes and tokens spent per useful record. One technology or source taking a large
  share of spend is a strong lead (a past case: about 60% of spend went to crawling one library that parsed far
  more than it used).
- Free-tier headroom: Cloudflare Worker requests, Durable Object rows read and written and storage
  (`$OBS_DIR/gateway-analytics.txt`), GitHub Actions minutes, release-asset and API usage. A change that keeps a
  resource inside its free tier at the expected growth is worth more than its raw saving.
- Context efficiency of what unstale hands a user's agent (fewer tokens for the same findings).

Quantify the saving from real numbers (current usage × reduction) and put it in the PR.
