# No-key mode eval: results

**Verdict: fail.** No-key mode does not ship; with no provider the client keeps offering advisories and deprecations
only. Run on 12 November 2026 against the rule in `PREREGISTRATION.md`, written before the run.

## Question

With no key and no Codex, should the client hand the user's agent the raw release-note text of newer releases
(unparsed, sometimes repeated) beside its deterministic signals? Only if an agent with that does better than the same
agent alone: more real finds, and fewer tokens per find to act on now.

## Result

19 repos at pinned commits, the same agent (Claude Code headless, `claude-opus-5-5`), the same plain ask, the frozen
pool v3 and its judge. The agent-alone arm is the one run on 22 and 23 October.

| | Agent alone | Agent with no-key unstale | Difference, 5th to 95th percentile over repo resamples |
|---|---|---|---|
| Real finds (tier A or B) | 40 | **51** | +11, from −5 to +28 |
| Act-now finds (tier A) | 18 | 20 | |
| Client tokens per repo | 409K | 661K | |
| Client tokens per act-now find | **432K** | 628K | alone ÷ no-key 0.69, from 0.43 to 1.35 |
| Risk lines listed (capability lines left out, as scored) | 82 | 117 | |
| Top-8 precision (A+B) | 0.39 | 0.36 | |

Against the two gates:

1. **Real finds: not met.** The total is higher (51 against 40), but the 5th percentile of the difference is −5, so
   the lead is within noise. By repo: more on 7, fewer on 7, the same on 5. Two repos (insomnia +8, composio +4) carry
   the lead.
2. **Tokens per act-now find: not met.** The no-key arm spends 1.45 times as much per act-now find (628K against
   432K) and 1.6 times as much per repo. It was cheaper on 6 of the 19 repos.

Reported, not gated:

- **Precision** fell slightly, as expected: 0.36 against 0.39 in the top 8.
- **Reading matter against a keyed report:** 5.7 times the bytes (the no-key report plus the release-note file,
  against the keyed report for the same commit), over the 15 repos whose keyed report completed. The release-note file
  averaged 178 KB a repo under its 240 KB cap; the no-key report itself averaged 16 KB.
- **Where the finds came from:** of the no-key arm's real finds that match a pool item by key (40 of the 51), 30
  (75%) name a package that the report already lists in a section built from deterministic signals alone (publisher
  deprecations, unmaintained packages, lockfile advisories). The raw release notes added about a quarter of the finds
  and most of the extra tokens.
- **Share of a full report that needs no model:** of the keyed report's 154 real finds on pool v3 (24 October, build
  0.2.5), **39 (25%)** have a line in a section built from deterministic signals alone: 22 under publisher
  deprecations, 9 under unmaintained packages, 8 under lockfile advisories. Of the act-now ones, 18 of 73 (25%).
  `deterministic_share.py` computes this with the harness's own links between report lines and pool items; a find
  counts when any line tied to it sits in one of the three sections, once, under the first of them. It is a share of
  a full report's real findings for a repository as installed; it was not measured on new releases only. The
  pre-registration quotes 42 (27%): that was a hand count on a looser key match, made before this script existed,
  and the script's number replaces it.
- **Pending:** 6 of the no-key arm's lines match no item of the frozen pool and are in no count.

## Per repo

"Technologies without events" counts those of the repo's technologies with catalog records for which the catalog
had no release text to give (not yet refreshed, or no source text): the new arm had nothing raw to read for them.

| Repo | Real changes in pool | Finds: alone | Finds: no-key | Act-now: alone | Act-now: no-key | Tokens: alone | Tokens: no-key | Pending | Technologies without events |
|---|---|---|---|---|---|---|---|---|---|
| ComposioHQ/composio | 15 | 1 | 5 | 1 | 3 | 495K | 1185K | 0 | 6 of 122 |
| faker-js/faker | 3 | 2 | 1 | 0 | 0 | 628K | 543K | 0 | 2 of 21 |
| Kong/insomnia | 31 | 3 | 11 | 0 | 4 | 529K | 1089K | 0 | 6 of 121 |
| mui/material-ui | 11 | 0 | 2 | 0 | 1 | 596K | 698K | 1 | 12 of 111 |
| mikro-orm/mikro-orm | 3 | 1 | 2 | 1 | 1 | 315K | 687K | 0 | 1 of 38 |
| Significant-Gravitas/AutoGPT | 38 | 5 | 5 | 3 | 2 | 734K | 1635K | 0 | 6 of 211 |
| enisdenjo/graphql-ws | 11 | 2 | 1 | 0 | 0 | 208K | 276K | 0 | 0 of 24 |
| Effect-TS/effect | 16 | 4 | 4 | 4 | 4 | 503K | 472K | 0 | 7 of 75 |
| dolanmiu/docx | 6 | 0 | 0 | 0 | 0 | 395K | 341K | 0 | 2 of 38 |
| pydantic/logfire | 16 | 0 | 0 | 0 | 0 | 367K | 481K | 1 | 5 of 74 |
| graphile/crystal | 25 | 7 | 5 | 6 | 3 | 443K | 202K | 0 | 0 of 98 |
| BrianPugh/cyclopts | 0 | 0 | 0 | 0 | 0 | 188K | 423K | 0 | 0 of 18 |
| prowler-cloud/prowler | 18 | 1 | 4 | 0 | 1 | 451K | 585K | 1 | 8 of 201 |
| capricorn86/happy-dom | 10 | 4 | 3 | 1 | 0 | 318K | 200K | 0 | 1 of 36 |
| video-dev/hls.js | 14 | 5 | 4 | 0 | 0 | 267K | 902K | 2 | 1 of 43 |
| wevm/vocs | 11 | 2 | 1 | 0 | 0 | 752K | 494K | 0 | 0 of 48 |
| bitwarden/clients | 16 | 1 | 2 | 1 | 1 | 202K | 652K | 1 | 8 of 100 |
| opral/paraglide-js | 11 | 2 | 0 | 1 | 0 | 135K | 896K | 0 | 1 of 69 |
| Automattic/mongoose | 5 | 0 | 1 | 0 | 0 | 246K | 796K | 0 | 3 of 31 |

## Changes to the scoring script after the first results

Two, neither of which touches a gate (finds, act-now finds and tokens come from the harness's report unchanged):

- Keyed reports under 1 KB are left out of the reading-matter multiple. On three large repos the keyed report was the
  stub a run writes at its time limit, which would have inflated the multiple.
- A block on every model call inside scoring was narrowed to the judge only. The harness asks a small model, once per
  repo, whether two items its rules cannot settle are the same change, and caches the answer; scoring could not
  finish without it. This is the harness's standard matching step, the same for both arms.

The agent alone's 82 lines here are risk lines; the 94 in the pre-registration and in `eval/beat-naive/RESULTS.md`
count its capability lines too (12 of them), which the risk scoring leaves out for every arm (5 of the no-key arm's
122).

## Revision

None. The stopping rule allowed one revision of the deterministic rules and a final run. It was not taken: the token
gate fails on the point estimate, not only on the interval, and three quarters of the arm's finds come from the
deterministic sections, which a smaller or reordered release-note file would not change. A second run would cost
the same again for a result that would need both gates to move outside their intervals. The first run is the verdict.

## Method, in short

- **What the new arm had.** The client path that writes the raw release notes into the report was built for this eval
  and is not merged: it is `local/cli/src/nokey.rs` on branch `ws9/no-key-mode` (pull request #231, closed). At each
  pinned commit, that client (built at `9a93191`) ran with the
  edge-inference switch on and no provider, on a catalog cut to the day the agent-alone arm ran: change events up to
  that day, no records, no advisory APIs (`freeze_catalog.py`). Its report and `.unstale/change-events.md` were placed
  in the blind copy; the prompt (`prompt.md`) is the plain ask plus one line naming those two files.
- **Scoring.** The harness's judge and tier rule, unchanged; a find is real when it matches a frozen pool v3 item of
  tier A or B. `score.py` applies the gates: 2,000 resamples of the 19 repos, seed 20261023, the same draw for both
  arms.
- **Not controlled.** Claude Code was 2.1.322 for the new arm and 2.1.303 to 2.1.308 in October. Registry
  deprecations, OSV advisories and the agent's web access are read live, 20 days later for the new arm; finds from
  after the freeze are pending, so this can only cost the new arm. 69 of 1,479 repo-technology pairs with records had
  no release text.
- **Caveats carried from the pool.** Labels come from a model judge; recall is against what some arm found; n = 19.

## Cost

No API spend. The new arm's 19 sessions used 12.6M client tokens on a Claude plan (46 minutes of sessions); judging
used 3.1M Codex tokens on a plan. The harness, the frozen pool and its labels live outside this repository, so these
numbers cannot be regenerated from the repository alone.
