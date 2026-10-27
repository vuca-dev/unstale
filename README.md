# agent-memory

Running logs of the weekly agents (`.github/workflows/agents.yml`), one per lane: `security.md`, `performance.md`,
`cost.md`, `qa.md`, and `state.json` (the commit each lane last reviewed). Written only by the agents' publish job;
pruned by `.github/scripts/agents/prune.mjs` (full entries 30 days, outcomes to 90 days).
