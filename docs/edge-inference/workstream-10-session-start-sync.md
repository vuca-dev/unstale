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

## Later levers (not in this sprint)
Ingest more often once central has no model calls (hourly or better), then registry-event triggers (npm's change
feed, PyPI's release feeds) to collect only technologies that changed.

## Risks and rollback
A repo-level hook may need the user's trust approval in Codex; the skill explains it in one line. Rollback: remove
the hook entries; the agent-run sync still works.
