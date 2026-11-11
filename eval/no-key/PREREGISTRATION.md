# No-key mode eval: pre-registration

Written and committed before any agent run of the new arm. Nothing below changes after the first run except the one
revision the stopping rule allows, which is written here before the final run.

## Question

With no key and no Codex, the client gives the user's agent its deterministic signals (versions, lockfile advisories,
registry deprecations) and the raw change events: release-note text as published upstream, not extracted, labelled or
merged. Does a coding agent with unstale in that mode find more of what a repository should act on, for fewer tokens
per find, than the same agent alone?

## Arms

Both arms: Claude Code headless (`claude -p --model claude-opus-5-5`), the tools Bash, Read, Grep, Glob, WebSearch and
WebFetch, a blind copy of the repository at its pinned commit, one round, the same budget ceiling (3x a median
unaided run, never neared), the same deny rules. The harness is the one behind `eval/beat-naive/RESULTS.md`; it lives
outside this repository, so the numbers cannot be regenerated from the repository alone.

| Arm | What the agent has | Runs |
|---|---|---|
| Agent alone | Nothing from unstale. The plain ask: "What dependency updates have I missed for this repo?" plus a JSON answer format | **Reused** from 22 and 23 October 2026 (arm `naive-plain@3x`), 19 repos |
| Agent with no-key unstale | The same ask, plus one line saying unstale is installed without a model provider and naming `.unstale/onboarding-report.md` and `.unstale/change-events.md` as leads to verify. The files come from this branch's build with `UNSTALE_EDGE_INFERENCE=1`, no provider chosen, on the frozen catalog below. Running the binary is denied | New |

**Repos and commits.** The 19 of pool v3, as pinned in `eval/beat-naive/RESULTS.md`.

**Reused arm, checked on 11 November.** Recomputed from the stored runs against pool v3: 40 real finds (tier A or B),
18 act-now (tier A) finds, 94 lines, 409K client tokens a repo, 432K per act-now find, top-8 precision 0.39. These
match the published table.

**Model and tooling.** The October runs recorded `claude-opus-5-5` on Claude Code 2.1.303 to 2.1.308. The same model
id still runs today (checked with one call) on Claude Code 2.1.322. So the model is the same and the reuse stands;
the agent harness is 14 to 19 patch versions newer, which is not controlled for. Had the model id no longer been
served, the reused arm would not be a fair comparison and the eval would have stopped for a decision on re-running
it (doubling the cost).

## Frozen view

The agent alone ran on 22 or 23 October. The new arm must not be handed anything published later.

- **Change events:** `freeze_catalog.py` builds, from a client cache synced on the live catalog, a catalog holding
  only events dated on or before the day that repo's agent-alone run happened, with the release index cut at the same
  day. The script is deterministic and calls no model.
- **Records:** removed, with the advisory APIs central's model step writes. The client's rule is that catalog records
  win where they exist, and the live catalog still has records for all of October, so on the live catalog this mode
  would show almost no raw text. Removing them measures the steady state: every newer release is events only.
- **Not frozen, and why it is acceptable:** registry deprecations, OSV advisories and the agent's own web access are
  read live, so both can surface changes published after the freeze. Such finds match no item of the frozen pool:
  they are listed as pending and never counted, while their tokens are. The bias is against the new arm.

**Data gate.** The run starts only when every technology of the 19 repos that has catalog records was last checked
by an ingest on the change-events code (index `checked` after 2026-11-11T00:48Z). On 11 November 05:02Z that held
for 315 of 846, so no run was started. At 10:24Z, after four runs, it held for 783 of 846; the other 63 were last
checked between 18 October and 10 November and none moved in those runs, so still no run was started.

## Scoring

Unchanged from the October run: the same judge, the same tier rule (A act now, B plan, C nit), the frozen pool v3 and
its labels. A find is real when it matches a frozen pool item of tier A or B; a find matching none is pending and in
no count. Client tokens are the whole agent session, reading unstale's files included. Intervals are 5th to 95th
percentiles over 2,000 resamples of the 19 repos with replacement, seed 20261023, the same repos drawn for both arms.

## Pass rule (no-key mode ships only if both gates hold)

1. **Real finds.** Pooled over the 19 repos, the new arm's real finds are at least the agent alone's (40), and the
   5th percentile of the paired difference (new minus alone) is at least 0.
2. **Tokens per act-now find.** The new arm's pooled client tokens per tier-A find are below the agent alone's
   (432K), and the 5th percentile of the ratio (alone over new) is at least 1. No tier-A find at all fails this gate.

The workstream document asks for "at least" with an interval; the design document says the mode ships only if it
"beats" the agent alone. The interval is read as the stricter of the two: a tie within noise does not ship.

Reported, not gated:
- Precision: top-8 precision (A+B) and lines listed. It is expected to fall.
- **Token multiple against a keyed run:** bytes of the no-key report plus `change-events.md`, over bytes of the keyed
  report for the same commit from the same build on the live catalog, pooled over the 19 repos. This is what the
  agent is given to read, and it is deterministic. A keyed agent arm on the plain ask was not run in October and is
  not run here (19 more sessions), so the multiple is of reading matter, not of session tokens.
- Share of real finds that need no release-note text: of the keyed report's 154 real finds on pool v3 (24 October),
  42 (27%) sit in the sections built from deterministic signals alone (publisher deprecations, unmaintained
  packages, lockfile advisories) and 35 more (23%) are advisory lines that the report places with model-written
  data. For the new arm, each real find is tagged by whether its package appears in those sections of the no-key
  report.
- Pending finds per arm, tokens and wall time per repo.

## Stopping rule

A 2-repo smoke first (harness check and per-repo tokens; stop and report if a repo costs more than 800K tokens, twice
the top of the 100K to 400K estimate). Then one full run. At most one revision of the deterministic rules in
`local/cli/src/nokey.rs` (what is shown, in what order, under what cap), decided from the first run's per-repo misses
and written into this file before the second run. One final run, whose result is the verdict. Nothing further: on a
fail the client keeps saying a key or Codex is needed, and the result is recorded.

## Cost

No API spend. Agent sessions bill a Claude plan: 19 repos a run, 2 smoke repos, at most 2 full runs. Judging new
items uses the harness's judge (`gpt-6-luna` through Codex, plan-billed): 18K to 138K tokens a repo when nothing is
new, more for each new change. Repos run one at a time, each result is stored as it finishes, finished repos are
skipped on restart, and a usage limit stops the run cleanly.
