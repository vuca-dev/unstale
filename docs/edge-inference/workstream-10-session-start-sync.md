# WS10: Session-start sync and freshness tracking

## Why
Today the catalog syncs only when the agent runs `unstale status` or the report. That makes the agent responsible
for knowing when to ask, which defeats the point of unstale: changes should be pushed to the agent. The sync moves
into each agent's session-start hook.

## Scope
1. **Session-start sync on every supported agent.**
   - Claude Code: extend the existing SessionStart hook (`unstale notify`, `.claude/settings.local.json`).
   - Codex: a `SessionStart` hook (stable since 0.124; inline `[[hooks.SessionStart]]` in `.codex/config.toml` or
     `.codex/hooks.json`). Check how Codex asks the user to trust a repo-level hook, and install it the way the
     existing skill install is placed (excluded from Git in local mode).
   - opencode: verify its plugin session events first; if none fits, record that and fall back to the skill.
2. **The hook never slows or breaks a session.** A quick check with a short timeout (the signed technology list,
   one conditional request; unchanged technologies cost nothing), then model work in a detached background process
   under the WS3 budget. It prints at most one line when new findings are ready, and nothing otherwise. Any failure
   is silent at session start and shows in `unstale status`. One worker per machine (WS3's lock). Opt out with one
   config line.
3. **Freshness tracking.**
   - Central: per release, registry publish time → central first seen → events published (from WS2's timestamps).
     Published as a small summary with the catalog (median and 90th percentile gap, last 30 days), so the trend is
     visible over time.
   - Client: per technology, events published → synced on this machine → records ready. Shown in `unstale status`.
     Local only: nothing is sent to central (no telemetry).
4. **Request budget:** measure catalog requests per session start against the hosted catalog's daily allowance
   before enabling it by default.

## Pre-conditions
WS2 (timestamps) and WS3 (background work under the budget). Hook installation can start earlier.

## Acceptance criteria
- [ ] Each supported agent's session start triggers a sync on a fresh install, in WS6's environment matrix (a fake
      agent session for each).
- [ ] Session start adds under 2 s in the worst case (catalog unreachable, provider down, cache corrupt), exits 0
      and prints at most one line (hold-the-line 5), measured and tested.
- [ ] `unstale status` shows the gap breakdown for this machine; central publishes its gap summary.
- [ ] Catalog requests per session start measured and within the allowance at the projected user count.

## Built (session start)

- **Hook:** `unstale notify` (`local/cli/src/session.rs`, `hook`). Everything runs under a 1.5 s deadline on a worker
  thread; it always exits 0, prints at most one line on stdout and nothing on stderr. The only catalog request is the
  conditional request for `v1/technologies.json` (0.8 s timeout); when the list and this repository's cached indexes
  agree, nothing else is asked for. Otherwise `unstale session-sync` runs detached (no inherited stdio, its own process
  group), one per repository, bounded at 120 s, then the model stage under the worker lock and the monthly budget.
- **Per agent:** Claude Code `.claude/settings.local.json` (as before); Codex `.codex/hooks.json` (`SessionStart`,
  timeout 5 s; Codex runs a project hook once the user trusts it in `/hooks`, which it points to at startup; a hooks
  file Git tracks is left alone); opencode `.opencode/plugins/unstale-session.js` on `session.created` (opencode adds
  no hook output to the agent's context, so only the sync runs there). Each names this machine's executable and is
  excluded from Git.
- **Behind the one switch until the release** (owner decision, 10 November). With it off the client behaves as before
  session-start sync: the Claude Code hook does what `notify` did (its one fix: at most one line, exit 0, within the
  deadline), no catalog request or other process at session start, no Codex or opencode file, no new state file,
  exclude line or status line. With it on, records sync at session start, change events and the model stage as
  before. `"session_sync": false` in `.unstale/config.json` turns it off. A repository set up while the switch was
  on keeps its Codex and opencode hook files after the switch goes off; they are inert then (the hook does only what
  `notify` did), and `unstale uninstall` removes them.
- **Hosts contacted:** the hook asks the catalog only. The background stage's sync contacts what `unstale status`
  contacts (the catalog, and the public registries for unpinned dependencies). Its model stage, with a provider
  chosen, also contacts that provider (and only it), sending public release-note text; `unstale status` never does.
- **Installers** keep the user's bytes: our entry is inserted as text and removed exactly; it is recognised by its
  exact command, never a substring; the executable is quoted so no shell expands it; a file Git tracks, a read-only
  or linked file, and a Codex repository with hooks inline in `.codex/config.toml` are left alone (`unstale status`
  says why for Codex, including a `hooks.json` that is not plain JSON with a `hooks` object).
- **Deadline:** 1.2 s from the process's start, covering every blocking step (a read that never finishes included).
  Worst measured: 1.23 s.
- **Output:** one line, the most important first. A warning when the sync failed or the model stage could not run,
  said once when that begins (compared by kind of trouble, recorded only after it is printed), with no raw error or
  path; otherwise records new to this repository since the last report (or the shared-coverage line, or a catalog
  notice); nothing otherwise. `unstale status` shows the detail, and a later successful session start clears a
  failure.

## Request budget (measured)

| Session start | Requests (signed catalog) | Worker requests |
|---|---|---|
| Catalog unchanged | 1 (`technologies.json`, 304) | 0 |
| Catalog changed | 1 + 4 (root, list, signatures) + 2 per changed stack technology + new shards | 0 |
| First on a machine | 0 at the hook; the background stage is a full first sync | 0 |

Tests: `sync::tests::session_start_requests_on_a_signed_catalog`, `tests/session.rs`. The hosted catalog serves `/v1/*`
as Workers static assets (`gateway/wrangler.jsonc`: not in `run_worker_first`), which are free and unlimited; root,
list, indexes, their signatures and current shards rank first to stay unpacked (`gateway/scripts/pack.ts`). Only a
packed file or a 404 runs the Worker (free plan: 100,000 requests a day).

Projection, 10,000 users at 20 session starts a day: 200,000 static requests a day unchanged; the list changes at most
8 times a day (ingest every 3 hours), so at most 8 changed starts per user a day, about 14 requests each with 3 changed
technologies: at most 1.12M static requests a day. Worker requests: 0. Within the allowance; off until the release with the rest of the switch. Watch: if current
files are ever packed (past 20,000 deployed files), changed starts would spend Worker requests.

## Built (freshness)

- **Central:** `v1/freshness.json`, signed, written at export (`central/src/pipeline/freshness.ts`). Median and 90th
  percentile, in minutes, of registry publish to first seen, first seen to events published, and end to end, over the
  30 days up to the newest release published, plus one entry per day for the trend. Backfilled sources are left out.
  It is computed from the change events the exported indexes name, so it is deterministic and the same catalog gives
  the same bytes. The deploy check verifies it.
- **Client:** `unstale status`, with model steps on, prints two short lines for this repository's technologies over
  the last 30 days: registry to catalog, and catalog to this machine, each as a median and the slowest tenth; none
  when no release arrived. When each event first reached this machine is kept
  in `.synced.json` beside the cached events. What a technology's first sync finds counts as already published. It is
  local only: nothing is sent anywhere.

## Later levers (not in this sprint)
Ingest more often once central has no model calls (hourly or better), then registry-event triggers (npm's change
feed, PyPI's release feeds) to collect only technologies that changed.

## Risks and rollback
A repo-level hook may need the user's trust approval in Codex; the skill explains it in one line. Rollback: remove
the hook entries; the agent-run sync still works.
