Deterministic ranking-only release check (`GATE_K=0`). Agent-review arms were not run.

| Split | Class | Key | Covered | In CLI queue | CLI first 16 | First 16 as invoked | tier: found mean [min-max] | tier: do now (found) | tier: unstable | all: found mean [min-max] | all: do now (found) | all: unstable |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DEV (9) | all | 115 | 72 (-2) | 65 (+1) | 43 (-2) | 42 (-2) | - | - | - | - | - | - |
| DEV (9) | required | 72 | 48 (-1) | 46 (+3) | 27 (-1) | 26 (-1) | - | - | - | - | - | - |
| DEV (9) | optional | 43 | 24 (-1) | 19 (-2) | 16 (-1) | 16 (-1) | - | - | - | - | - | - |
| HELD-OUT (6) | all | 43 | 21 (+0) | 18 (-1) | 10 (+0) | 9 (-1) | - | - | - | - | - | - |
| HELD-OUT (6) | required | 22 | 11 (+0) | 11 (+0) | 6 (+1) | 5 (+0) | - | - | - | - | - | - |
| HELD-OUT (6) | optional | 21 | 10 (+0) | 7 (-1) | 4 (-1) | 4 (-1) | - | - | - | - | - | - |
| ALL (15) | all | 158 | 93 (-2) | 83 (+0) | 53 (-2) | 51 (-3) | - | - | - | - | - | - |
| ALL (15) | required | 94 | 59 (-1) | 57 (+3) | 33 (+0) | 31 (-1) | - | - | - | - | - | - |
| ALL (15) | optional | 64 | 34 (-1) | 26 (-3) | 20 (-2) | 20 (-2) | - | - | - | - | - | - |

| Split | Arm | Do now outside the key, per review | per run (sum) | Input tokens per key change found | Input tokens per run | Found per run (all) | sd |
|---|---|---|---|---|---|---|---|
