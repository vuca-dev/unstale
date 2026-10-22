# Beat-naive: unstale against an unaided coding agent (22 October 2026)

**Question.** Does unstale beat an unaided coding agent at finding the dependency changes a repository should act on,
once client cost is counted? Standing target: at least 10x fewer client tokens per tier-A (act-now) find than naive, at
equal or better precision, on 8 or more comparison repos. Method decisions and open questions live in the vault note
"Beat-Naive Eval" (not in git).

## Data and arms

**Repos.** 10 public OSS repos (scout attempts 27, 28, 31, 33–38, 40), each pinned at a commit (table below). Every
arm works on a blind copy of the repo at that commit. Same model (Opus) in every agent arm.

**Budgets** are multiples of a median naive run (about $1.21, about 1.29M tokens), passed in the prompt.

| Arm | Prompt | What it measures |
|---|---|---|
| `unstale_raw` | none | unstale's onboarding report as it stands (build 0.2.2; Effect from 0.2.2-a45), scored on its ranked items |
| `naive+unstale@Nx` | `ab-naive-sweep.md` + unstale note | the coached agent, also given unstale's report and review skills as leads to verify. Arm of record |
| `naive@Nx` | `ab-naive-sweep.md` | coached exhaustive whole-repo search, verified against file:line and lockfile, re-prompted until the budget is spent |
| `naive-plain@3x` | `ab-naive-plain.md` | the plain ask, "What dependency updates have I missed for this repo?". One turn, no re-prompt, no budget in the prompt; 3x is only a ceiling and no run neared it |
| `naive` | `ab-naive.md` | first naive baseline: up to 8 most consequential changes (7 of 10 repos) |
| `agent_unstale` | scout session | the scout session's own top 8 after reading unstale (7 of 10 repos) |
| `naive-opps@1x`, `naive+unstale-opps@Nx`, `unstale_raw-opps` | `ab-naive-opps.md` | opportunities track: top 5 new capabilities worth an architect's attention |

**Scoring.** The judge tiers each item A (act now) = 3, B (plan) = 1, C (nit) = 0; dev-tool EOL and dev-only breaking
changes are tier B. Recall is pooled: no answer key exists, so the pool is the real changes any arm found, matched by
same change, frozen as **v1** (22 October: 100 items, 37 tier-A over 18 attempts; 33 tier-A on the 10 comparison
repos). A find matching no frozen item is pending, listed and never in a denominator (0 pending in this run).
p@8 (A+B) is the share of an arm's top 8 that is tier A or B. Only client tokens count in the ratio, including reading
the report and skill files; operator (central) cost is reported separately.

## Results (frozen pool v1)

### Curve, 10 comparison repos

| Arm | Repos | Tier-A recall | Weighted recall | p@8 (A+B) | Client tokens / run | Client tokens / tier-A find | $ / run |
|---|---|---|---|---|---|---|---|
| unstale_raw | 10 | 0.27 (9/33) | 0.29 | 0.29 | 23.5K | **26.1K** | 0.023 |
| naive+unstale@0.1x | 9 | 0.27 (8/30) | 0.21 | **0.60** | 51.1K | 57.5K | 0.243 |
| naive@0.1x | 10 | 0.03 (1/33) | 0.03 | 0.40 | 60.9K | 609.2K | 0.160 |
| naive+unstale@0.3x | 10 | 0.27 (9/33) | 0.25 | 0.42 | 210.9K | 234.3K | 0.521 |
| naive@0.3x | 10 | 0.12 (4/33) | 0.10 | 0.57 | 263.6K | 659.1K | 0.513 |
| naive-plain@3x | 10 | 0.24 (8/33) | 0.24 | 0.38 | 476.9K | 596.2K | 0.558 |
| naive@1x | 10 | 0.21 (7/33) | 0.18 | 0.48 | 965.1K | 1.38M | 1.575 |
| naive+unstale@1x | 10 | 0.39 (13/33) | 0.37 | 0.51 | 977.4K | 751.8K | 1.541 |
| naive | 7 | 0.20 (5/25) | 0.23 | 0.43 | 1.38M | 1.94M | 1.250 |
| agent_unstale | 7 | 0.15 (4/27) | 0.20 | 0.29 | 2.04M | 3.58M | 1.168 |
| naive@3x | 10 | 0.42 (14/33) | 0.44 | 0.49 | 4.09M | 2.92M | 4.754 |
| naive@10x | 8 | 0.45 (14/31) | 0.47 | 0.47 | 10.08M | 5.76M | 14.511 |

Read-outs (judge-limited; see caveats):
- **Equal spend** (about 0.1x of a naive run): naive+unstale 0.27 tier-A recall against naive's 0.03, at about 10x
  fewer tokens per tier-A find (57.5K vs 609.2K).
- **Report alone vs the plain ask:** about 23x fewer tokens per tier-A find (26.1K vs 596.2K) at similar recall
  (0.27 vs 0.24); the plain ask has the higher p@8 (A+B) (0.38 vs 0.29).
- **Report alone vs coached naive:** about 53x fewer tokens per tier-A find than naive@1x, about 220x than naive@10x.
- **Recall ceiling:** no arm passes 0.45 tier-A recall, including naive@10x.

### Tier-A finds per repo and arm

`n+u` = naive+unstale; – = arm not run on that repo.

| Repo (attempt, commit) | Pool A | unstale_raw | n+u@0.1x | n+u@0.3x | n+u@1x | naive@0.1x | naive@0.3x | naive@1x | naive@3x | naive@10x | naive-plain@3x | naive | agent_unstale |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ComposioHQ/composio (27, `231122de19`) | 3 | 0 | – | 0 | 0 | 0 | 0 | 2 | 1 | 1 | 2 | – | – |
| faker-js/faker (28, `dc60fc2e50`) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | – |
| Kong/insomnia (31, `25c20ce0c3`) | 3 | 0 | 0 | 1 | 1 | 0 | 1 | 1 | 1 | 2 | 0 | – | – |
| mui/material-ui (33, `f24a0dfc9c`) | 2 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 1 | 0 | 1 | 0 |
| mikro-orm/mikro-orm (34, `d12e730d12`) | 2 | 1 | 1 | 1 | 1 | 0 | 1 | 2 | 1 | 1 | 1 | 0 | 1 |
| Significant-Gravitas/AutoGPT (35, `8d4a965b7b`) | 8 | 2 | 2 | 2 | 4 | 0 | 1 | 0 | 3 | 4 | 1 | 1 | 2 |
| enisdenjo/graphql-ws (36, `7281f1b8f0`) | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | – | 0 |
| Effect-TS/effect (37, `1b740862e3`) | 11 | 5 | 5 | 5 | 5 | 0 | 0 | 1 | 5 | 4 | 4 | 1 | 1 |
| dolanmiu/docx (38, `0132938894`) | 2 | 0 | 0 | 0 | 2 | 0 | 1 | 1 | 2 | – | 0 | 2 | 0 |
| pydantic/logfire (40, `b9378daa5f`) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | – | 0 | 0 | 0 |
| **Total** | 33 | 9 | 8 | 9 | 13 | 1 | 4 | 7 | 14 | 14 | 8 | 5 | 4 |

Effect (11) and AutoGPT (8) hold 19 of the 33 tier-A items; two repos have none.

### Only-this-arm tier-A finds and leave-one-out

13 of the 33 tier-A items were found by one arm only: naive-plain@3x 3, naive@10x 3, naive@1x 2, naive@3x 2,
naive@0.1x 1, naive+unstale@1x 1 (jose, which unstale's report carried at #15), unstale_raw 1 (graphql 16 → 17).

`ab-report --loo` drops each arm's only-this-arm finds from the pool and re-scores. On v1 the tier-A recall order and
the tokens-per-find order **change**:
- **Holds under every leave-out:** the equal-spend result (naive+unstale@0.1x and unstale_raw ahead of naive@0.1x on
  recall and tokens per tier-A find).
- **Flips:** close recall gaps, naive+unstale@1x vs naive@3x and vs naive@10x; naive-plain@3x against naive and
  naive@1x; unstale_raw against naive+unstale@0.1x/0.3x and naive-plain@3x. Treat these as ties.
- naive@0.1x's single tier-A find is unique, so dropping it leaves naive@0.1x no tier-A find and reorders it against
  every arm on tokens per find.

### Blind spots: tier-A changes no unstale arm found

Tier-A items found only by naive or naive-plain arms (no `unstale_raw`, `naive+unstale` or `agent_unstale` run).
Cause from `ab-gaps --summary` and the per-attempt gap notes, classified by the harness rules.

| Repo | Package | Change | Found by | Why unstale missed it |
|---|---|---|---|---|
| composio | @anthropic-ai/claude-agent-sdk | eleven pending patch releases change behaviour the provider config's `permissionMode` relies on | naive-plain | **identity**: the report carried a record (`crosssessioninbound`) labelled nit; the judge keyed it as a different change |
| composio | google-cloud-aiplatform | Vertex AI SDK generative module deprecated; migrate to google-genai | naive@1x, @3x, @10x, plain | **coverage**: no record names `vertexai.generative_models`; docs not found |
| composio | langchain | v1 moved `AgentExecutor`-era APIs to `@langchain/classic` | naive@1x | **coverage**: no record names the moved APIs; docs not found |
| insomnia | @faker-js/faker | 10.1.0 deprecated `image.urlLoremFlickr`, still used by template tags | naive@10x | **matcher/filter**: a record (`faker.image.url`) exists but did not reach the report |
| insomnia | marked | `headerIds`/`mangle` options deprecated, removed in 8.0.0, still passed to `setOptions` | naive@0.3x–@10x | **coverage**: no record names `setOptions`/`headerIds` (docs monitored) |
| material-ui | @babel/core | 7.29 is Babel 7's last; Babel 8 replaces the API | naive, @3x, @10x | **coverage**: covered via @babel/preset-env; no record names the `babel.transform*` APIs |
| material-ui | react-transition-group | 4.4.5 falls back to a deprecated path still used at runtime | naive@0.1x | **ranking**: in the report ("Start here") but below the top 8 |
| mikro-orm | mongodb | driver 7.6.0 drops MongoDB server 4.2 (docs use a 4.2 replica set) | naive@1x, @3x, @10x | **matcher/filter**: the matched records are for other drivers (Java); docs refresh did not finish |
| AutoGPT | graphiti-core | FalkorDB 6.x index syntax needs graphiti-core 0.31 | naive@3x | **coverage**: technology registered, coverage still queued |
| AutoGPT | openai | 1.97.1 range keeps the backend two majors behind; custom httpx client | naive-plain | **matcher/filter**: record `binary-request-streaming` (`httpx`) not in the report |
| AutoGPT | prisma (Python client) | maintainer stopped developing Prisma Client Python | naive@0.3x, @3x, @10x | **coverage**: blocked from monitoring (no release in 365 days), so no lifecycle record |
| AutoGPT | todoist-api-python | 3.0.0 moves to Todoist API v1 after REST v2 shutdown | naive@10x | **coverage**: registered, coverage still queued |
| graphql-ws | @fastify/websocket | 11.3.1 routes raw socket errors to the plugin handler first | naive@10x | **matcher/filter**: record exists (2 records so far) but not in the report |
| effect | @opentelemetry/resources | 3.0.0 removes platform detectors | naive-plain | **matcher/filter**: covered via semantic-conventions; record not in the report |
| effect | @opentelemetry/sdk-metrics | 3.0.0 built with tsdown and an `exports` map; deep `build/` import breaks | naive-plain, @3x, @10x | **coverage**: no record names the deep path |
| effect | doctrine | archived and unmaintained, still the JSDoc parser | naive@3x | **coverage**: blocked from monitoring (no release in 365 days) |
| effect | redis | node-redis 6 makes RESP3 the default | naive@1x | **matcher/filter**: record (`sendCommand`) not in the report |

17 items: coverage 9, matcher/filter 6, ranking 1, identity 1. Two patterns repeat: parked or archived packages are
blocked from monitoring, so lifecycle findings (prisma, doctrine) never get a record; and records that exist but do
not reach the report (faker, openai, fastify, redis, resources). Across all 15 gap attempts and every gap kind,
`ab-gaps --summary` counts ranking 21, coverage 18, precision 15, matcher/filter 14, identity 10, unclassified 2.

### Opportunities (separate track and pool)

| Arm | Repos | O1 recall | Weighted | p@5 (O1+O2) | Client tokens / run | Tokens / O1 find |
|---|---|---|---|---|---|---|
| unstale_raw-opps | 10 | 0.28 (29/102) | 0.31 | 0.85 | 23.5K | 8.1K |
| naive+unstale-opps@0.1x | 5 | 0.22 (12/54) | 0.21 | 0.88 | 69.5K | 28.9K |
| naive+unstale-opps@0.3x | 10 | 0.29 (30/102) | 0.31 | 0.94 | 236.5K | 78.8K |
| naive-opps@1x | 10 | **0.43 (44/102)** | **0.40** | **0.98** | 658.0K | 149.5K |

Against naive-opps@1x: naive+unstale-opps@0.1x 5.17x, @0.3x 1.90x fewer tokens per O1 find, both with recall below
naive, so not a win at matched recall.

### Operator cost

Over the comparison repos: onboarding $3.640, monitoring $11.375/year, against the free-tier budget. Not in the ratio.

### Judge

- Test-retest: 59/73 agree (0.81), below the 0.85 stability bar: **judge unstable**. Gaps of a few points are noise.
- Tier rule vs the user's labels (directional, unsure excluded): 9/14 agree; off on eslint-plugin-unicorn, yargs,
  react, @opentelemetry/sdk-trace-web, tsconfck.

### Verdict (as the harness prints it)

```
beat-naive target: 1/3 comparison repos meet it (naive+unstale vs naive: client tokens per tier-A find at matched weighted recall, p@8(A+B); need >= 8): not proven
beat-naive, opportunities dimension (naive+unstale-opps vs naive-opps@1x, client tokens per O1 find at matched weighted recall): naive+unstale-opps@0.1x: naive 5.17x (recall below naive), naive+unstale-opps@0.3x: naive 1.90x (recall below naive)
judge test-retest: 59/73 agree (judge unstable)
```

## Decisions

- **Frozen pool.** Score against a versioned frozen pool (v1 here). Without it every new arm grew the denominator and
  moved every arm's recall. Bump the version deliberately, before a restated result, never mid-comparison; before and
  after numbers must share a version.
- **Client tokens only** in the ratio, report and skill reads included; operator cost reported apart.
- **Equal spend is the defensible claim.** It is the only comparison that survives every leave-out. Close recall gaps
  (naive+unstale@1x vs naive@3x/@10x) are ties.
- **Not met:** the per-repo 10x test holds on 1 of the 3 repos where it can be checked, against 8 needed.

## Caveats

- No answer key: recall is against what some arm found, so changes no arm found are invisible, and the ceiling (0.45)
  is a ceiling of the pool as well as of the arms.
- Judge unstable (0.81 test-retest); one judge model tiers every item.
- Uneven arm coverage: naive@10x on 8 repos, `naive` and `agent_unstale` on 7, naive+unstale@0.1x on 9.
- Tier-A items are concentrated: Effect and AutoGPT hold 19 of 33.

## Reproduce

The harness is the private local scout (`bin/scout.py`, `bin/ab-judge.py`, `bin/ab-opps.py`, prompts
`prompts/ab-naive-sweep.md`, `ab-naive-plain.md`, `ab-naive-opps.md`, `ab-naive.md`), not in this repo. Repo commits
are pinned per attempt (table above); the pool is frozen as v1.

```
python3 bin/scout.py ab-report --line          # curve, opportunities, operator cost, judge, verdict (frozen v1)
python3 bin/scout.py ab-report --line --loo    # plus leave-one-out
python3 bin/scout.py ab-report                 # per-attempt detail (JSON)
python3 bin/scout.py ab-gaps --summary         # gap causes; --attempt N writes the per-attempt note
```
