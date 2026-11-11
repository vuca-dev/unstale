| Cell | Step | Route | Metric | Central | Client | Band | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | extraction | gpt-6-luna, gateway | recall, pooled | 66.3 | 75.6 | client − central +9.3 [-2.5, +16.1] | pass |
| 1 | extraction | gpt-6-luna, gateway | recall, mean per technology | 91.9 | 90.4 | client − central -1.6 [-8.0, +3.6] | pass |
| 1 | extraction | gpt-6-luna, gateway | recall, breaking | 82.9 | 74.3 | client − central -8.6 [-28.6, +3.1] | pass |
| 1 | extraction | gpt-6-luna, gateway | precision | 82.0 | 78.8 | client − central -3.2 [-7.7, +3.6] | pass |
| 2 | extraction | gpt-6-luna, gateway | recall, required | 88.7 | 87.3 | client − central -1.4 [-4.7, +1.1] | pass |
| 2 | extraction | gpt-6-luna, gateway | recall, breaking | 86.4 | 85.7 | client − central -0.7 [-4.0, +2.0] | pass |
| 2 | extraction | gpt-6-luna, gateway | precision | 84.8 | 82.8 | client − central -2.1 [-6.1, +2.3] | pass |
| 9 | extraction | Codex, batched 8 | recall, pooled | 75.6 | 53.5 | client − central -22.1 [-33.9, -1.8] | FAIL |
| 9 | extraction | Codex, batched 8 | recall, mean per technology | 90.4 | 82.7 | client − central -7.7 [-16.7, +1.5] | pass |
| 9 | extraction | Codex, batched 8 | recall, breaking | 74.3 | 68.6 | client − central -5.7 [-22.7, +10.3] | pass |
| 9 | extraction | Codex, batched 8 | precision | 78.8 | 88.3 | client − central +9.5 [-4.9, +16.6] | pass |
| 3 | labels | labelling service (stored answers replayed) | breaking recall / benefit recall / actionable recall / change type acc | 82.8 / 85.1 / 84.9 / 82.0 | 82.8 / 85.1 / 84.9 / 82.0 | exact: 233 of 233 records labelled as central | pass |
| 4 | labels | labelling service (stored answers replayed) | breaking recall / breaking precision | 90.0 / 94.5 | 90.0 / 94.5 | exact: 347 of 347 records labelled as central | pass |
| 7 | matching | labelling service (stored answers replayed) | merge recall; false merges per 100 | 171/197 = 86.8; 1.4 | 171/197 = 86.8; 1.4 | exact: 236 of 236 items decided as central | pass |
| 5 | labels | gpt-6-luna by choice, gateway | breaking recall | 86.2 | 89.7 | client − central +3.4 [-10.3, +17.2] | pass |
| 5 | labels | gpt-6-luna by choice, gateway | benefit-vs-none recall | 96.7 | 98.3 | client − central +1.7 [+0.0, +4.1] | pass |
| 5 | labels | gpt-6-luna by choice, gateway | actionable recall (yes) | 89.0 | 87.7 | client − central -1.4 [-4.1, +0.0] | pass |
| 5 | labels | gpt-6-luna by choice, gateway | change_type accuracy | 85.0 | 83.3 | client − central -1.7 [-5.6, +2.1] | pass |
| 6 | labels | gpt-6-luna by choice, gateway | breaking recall | 92.6 | 92.6 | client − central +0.0 [-3.9, +3.0] | pass |
| 6 | labels | gpt-6-luna by choice, gateway | breaking precision | 92.2 | 93.4 | client − central +1.2 [-0.6, +3.7] | pass |
| 8 | matching | gpt-6-luna by choice, production rule | merge recall | 142/197 = 72.1 | 124/197 = 62.9 | client − central -9.1 [-14.2, -4.6], McNemar p 0.000534 | FAIL |
| 8 | matching | gpt-6-luna by choice, production rule | false merges per 100 merges | 0.0 | 0.0 | McNemar p 1 (0 central only, 0 client only) | pass |
