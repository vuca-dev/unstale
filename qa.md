# qa agent log

## Revisit

- 2026-10-27: Rank the failing coverage slices by reason. Read `{"event":"slice_failed"` lines in the ingest logs (added in PR #175; they carry an error class only, so a single class may need the job's stored status for detail). Run 40562343126 had 46 failed new slices and about 15 failed "other" slices, and about 130 jobs stay `failed`. This is likely the highest-impact bug: those packages get no coverage.
- 2026-10-27: Worker `exceededResources`: 357 of 99.6k invocations this week (0.36%), in 8 separate hours, averaging about 18 subrequests and 12–14 ms CPU each (free-plan CPU kills). Successful requests also average 8–16 ms CPU. Suspects: `/coverage/status` and `/coverage/register` batches of 16 (each purl reads a bucket header, then the bucket or the static file). Needs `gateway-diagnostics` tail output to attribute; measure CPU per endpoint before changing anything.
- 2026-10-27: Ingest publish: one Cloudflare 507 ("exceeded request buffer limit while retrying upstream") on the assets-upload-session failed run 40132072964, which lost a cycle. A single deploy retry in `.github/scripts/ingest-cycles.sh` is outside this lane (`.github/` is refused), so it needs an owner change. 1 of about 74 runs.
- 2026-10-27: CI flake: `docs.test.ts` "guides come from the docs module…" timed out once (7.7 s against about 0.47 s normally; 1 of about 181 ci runs, run 40234125943). Every request goes to the local server, and the code has no sleeps. 7.7 s fits three 2 s HttpClient timeouts. Not reproduced locally, including under the full suite. Revisit if it recurs.
- 2026-10-27: Dependabot fails three times a week on undici: it needs 7.30.1, but wrangler 4.146.0 pins 7.29.1 through miniflare. wrangler 4.154.0 exists; check whether it lifts the pin (likely the security lane).

## Entries

### 2026-10-27 · Failed coverage slices had no reason in the run log
- Tried: went through every failure this week: ingest 40132072964, ci 40234125943, 3 Dependabot runs, gateway analytics, and the latest ingest's per-cycle slice tallies. Traced the docs-test requests locally (all on 127.0.0.1) and ran the suite under load; the test took 334 ms. Tried to read the saved state for the failed jobs' reasons: HTTP 403 on the draft release.
- Found: new slices failed 100% in three cycles (15/15, 10/10, 21/21); the run log carried only `coverage_stages` and `registry_poll` events, so the reasons were invisible. The `failed` count stayed flat at 127–133: the same jobs being retried on the backoff, by design. wrangler's "Read N files" includes more than it uploads (876+19008 = 19884, the same as `find`), so the file count did not cause the 507.
- Chosen: a `slice_failed` event per failed or stopped slice, with a regression test; PR #175. Review: ingest logs are public, so the event names the job via `logName` (requested, not admitted = hash) and logs a bounded `failureClass` (HTTP status, failure kind, type name), never the message; the model client's `HttpError(0)` (no response) is `timeout` or `network`, not `HTTP 0`. A stopped slice keeps the kind it started with (`interrupted.first`).
- Outcome: failure reasons are now in the ingest logs; next qa run should rank and fix the top reason.
