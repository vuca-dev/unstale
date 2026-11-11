# WS9: No-key mode eval

## Question
With no key and no Codex, the client passes deterministic signals (versions, advisories, deprecations) and the raw
change events (unparsed release-note chunks, sometimes duplicated) to the agent. Is a coding agent using unstale in
this mode more accurate and more efficient than the same agent alone?

## Method
`eval/beat-naive`'s harness and its frozen pool (19 repos at pinned commits, labels at freeze). The agent-alone arm is
reused from the 24 October run (pool v3); the new arm is the same agent (`claude -p`) with unstale installed in no-key
mode. Pre-register before running.

## Pass rule (ship no-key mode only if all hold)
- Real finds (recall) at least the agent alone's, interval over repo resamples.
- Client tokens per act-now find below the agent alone's.
- Precision is reported, not gated: it is expected to fall.
- The token spend relative to a keyed run is measured; it becomes the "≈ N× tokens" figure on the picker line.

## Stopping rule
One run. At most one revision of the deterministic rules, decided from the first run's per-repo misses, then one
final run. No further tuning: if it fails, no-key mode ships as "a key or Codex is needed" and the result is recorded.

## Cost
No API spend. Agent runs bill the CEO's Claude plan: roughly 100–400K tokens per repo per run. Run it when the plan's
window has room, not alongside other heavy work.

## Owner
One agent, after WS2 (events). It builds the no-key report path behind the README's one switch (events and
deterministic signals into the report), then runs the eval. The run is resumable per repo. On a pass it flips WS5's
constant and supplies the "≈ N× tokens" figure; on a fail it records the result and changes nothing.
