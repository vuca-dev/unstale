# Hosted-surface retirement tables (H7 probe)

Can provider deprecation/retirement pages be read by **one** generic extractor, with no per-provider parser?
(Onboarding hypothesis H7.)

`tables.py` reads HTML tables and keeps rows from tables whose headers name an identifier column (model, endpoint,
name, id; not price/date/status) and a retirement-date column (shutdown, retire, sunset, end of, removal; else a
deprecation/plain date that is not a release date). Replacement columns (replace, recommend, successor) are kept apart.
Identifiers are lowercase code-shaped tokens containing a digit.

```sh
curl -sL -o openai.html https://developers.openai.com/api/docs/deprecations   # and the pages below
python3 -I tables.py openai anthropic gemini azure                               # writes rows.json
```

## 15 October 2026

| Provider page | Rows | Identifiers | Rows with a retirement date |
|---|---|---|---|
| OpenAI API deprecations | 132 | 151 | 129 |
| Anthropic model deprecations | 42 | 35 | 42 |
| Gemini API deprecations | 78 | 76 | 50 (others: shutdown not yet set) |
| Azure OpenAI model retirements | 6 | 6 | 6 |

- 20 sampled rows: 18 clean (retired identifier, replacement, date); 2 OpenAI rows list a replacement in the same
  cell as the retired model. No provider-specific rule was needed.
- AuditAI hard-codes `gpt-5.4-nano`, `gpt-5.6-terra` and `gpt-5.6-sol` (OpenAI shutdown table) and `gpt-4.1`,
  `gpt-4o` (Azure retirement table): the hosted-surface signal its SDK records cannot give.
- Azure's page has 9 tables but only one qualifies; the others need a second look (headers or layout).
