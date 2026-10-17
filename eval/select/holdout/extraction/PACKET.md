# Labelling packet: extraction inventory (held-out)

You list every change in each release note below that qualifies, so that extraction can be scored for recall (did a
model find each change?) and precision (is each of its records one of these changes?). Work from the note text only.
Do not look at any model's records, the unstale catalog, or other labelers' files.

## Which changes qualify

The pipeline's extraction prompt (`EXTRACT_PROMPT`) states the criterion. Apply it as written:

> Emit one record for each distinct change in these notes that could alter what a developer using this technology
> writes, configures, runs or decides. Skip internal refactors, documentation, examples, tests, build chores, dependency
> bumps of the project's own repository and contributor news. If nothing qualifies, output [].

So: list a change if it could alter what a developer using this technology writes, configures, runs or decides.
Leave out what the skip list names. Nothing else is added to this criterion. When unsure whether an entry qualifies, include it and set
`"unsure": true` (optional field); the adjudicator decides.

## One item per distinct change

- One item per distinct change. A bullet or sentence that announces several changes gives several items, and they
  may share the same anchor.
- The same change mentioned twice in one note (a summary at the top and a bullet below) is **one** item; anchor it on
  the most specific line.
- A note can have no qualifying change: give it `[]`.
- Notes are judged one by one: a change repeated in two notes is an item in each.

## Fields

- **`anchor`**: copy the line of the note that states the change, **verbatim**: the whole bullet or the sentence,
  without the leading `-`/`*`, keeping backticks and punctuation. If a line is longer than about 300 characters,
  copy the one sentence that carries the change. Do not paraphrase, merge two lines or shorten below about 30
  characters unless the line itself is that short. (The scorer matches a record's evidence quote to the anchor by
  containment or similarity, so the anchor has to be text the note really contains.)
- **`change_type`**: exactly one of the pipeline's types (`CHANGE_TYPES`, verbatim):

- `new_api`: A new function, class, component, hook, module, command or file convention that did not exist before.
- `new_option`: A new option, flag, parameter, argument or configuration key on something that already exists.
- `behavior_change`: Existing code or configuration now behaves differently at run time or build time (not only a default value, not a bug fix).
- `default_change`: The default value of an existing option, setting or mode changed.
- `fix`: A bug fix: wrong results, crashes, errors or regressions corrected, restoring intended or documented behaviour.
- `deprecation`: Something still works but is marked for future removal (a warning, a deprecation notice).
- `removal`: Something that existed was removed or no longer works, including dropped support for a runtime or platform version.
- `stability_change`: An API or feature moved between experimental, preview, beta, unstable and stable.
- `performance`: Faster, or less memory, CPU, network, queries or bundle size, with nothing new to write.
- `security`: Closes a vulnerability or hardens a default or an API against misuse or attack.
- `tooling`: Developer tooling: the CLI, build tooling, codemods, dev server, type generation, test or editor tooling.
- `other`: None of the above.

- **`breaking`**: `true` if the change is **required for upgrade** under the pipeline's rubric (`BREAKING_RUBRIC`,
  verbatim), else `false`:

> BREAKING (yes) means: a project that worked on the previous version, upgraded to this release with no change to its code, configuration, scripts or tooling, then fails (an error, a failed build or type check, a command that no longer exists) or behaves differently in a way its users or developers would notice. Raising a minimum supported version of a runtime or dependency is breaking. A removal is breaking.
> NOT BREAKING (no) includes: a new optional feature or option; a deprecation that still works (a warning only); a recommendation or optional modernisation ("we recommend", "you may", "not required", new project defaults that existing projects need not adopt); a fix that restores documented behaviour; documentation changes.
> Judge what the change does to existing code, not where it is listed. If the source does not show that existing code stops working or changes behaviour, answer no.

## Output

One file per labeler, `extraction/labels/<labeler>.json`, with every note file below as a key:

```json
{
  "posthog-js-bf3ade81@1.426.0.md": [
    {"anchor": "<verbatim line>", "change_type": "new_option", "breaking": false}
  ],
  "zod-6ac59393@4.3.3.md": []
}
```

## Notes (40; the text is in `extraction/notes/`)

| File | Technology | Ecosystem | Version | Date |
|---|---|---|---|---|
| `posthog-js-bf3ade81@1.426.0.md` | posthog-js | npm | 1.426.0 | 2026-09-03 |
| `posthog-js-bf3ade81@1.356.1.md` | posthog-js | npm | 1.356.1 | 2026-02-27 |
| `posthog-js-bf3ade81@1.407.0.md` | posthog-js | npm | 1.407.0 | 2026-07-22 |
| `posthog-js-bf3ade81@1.306.2.md` | posthog-js | npm | 1.306.2 | 2025-12-15 |
| `posthog-js-bf3ade81@1.411.0.md` | posthog-js | npm | 1.411.0 | 2026-08-04 |
| `posthog-js-bf3ade81@1.405.3.md` | posthog-js | npm | 1.405.3 | 2026-07-21 |
| `posthog-js-bf3ade81@1.429.0.md` | posthog-js | npm | 1.429.0 | 2026-09-09 |
| `posthog-js-bf3ade81@1.337.0.md` | posthog-js | npm | 1.337.0 | 2026-02-03 |
| `posthog-js-bf3ade81@1.379.1.md` | posthog-js | npm | 1.379.1 | 2026-06-03 |
| `posthog-js-bf3ade81@1.427.0.md` | posthog-js | npm | 1.427.0 | 2026-09-04 |
| `zod-6ac59393@4.6.0.md` | zod | npm | 4.6.0 | 2026-09-09 |
| `zod-6ac59393@4.6.6.md` | zod | npm | 4.6.6 | 2026-10-11 |
| `zod-6ac59393@4.2.0.md` | zod | npm | 4.2.0 | 2025-12-15 |
| `zod-6ac59393@4.5.4.md` | zod | npm | 4.5.4 | 2026-08-29 |
| `zod-6ac59393@4.3.0.md` | zod | npm | 4.3.0 | 2025-12-31 |
| `zod-6ac59393@4.4.2.md` | zod | npm | 4.4.2 | 2026-05-01 |
| `zod-6ac59393@4.3.4.md` | zod | npm | 4.3.4 | 2025-12-31 |
| `zod-6ac59393@4.5.0.md` | zod | npm | 4.5.0 | 2026-08-28 |
| `zod-6ac59393@4.1.13.md` | zod | npm | 4.1.13 | 2025-11-24 |
| `zod-6ac59393@4.3.3.md` | zod | npm | 4.3.3 | 2025-12-31 |
| `uvicorn-9342337b@0.53.0.md` | uvicorn | pypi | 0.53.0 | 2026-09-14 |
| `uvicorn-9342337b@0.52.2.md` | uvicorn | pypi | 0.52.2 | 2026-08-13 |
| `uvicorn-9342337b@0.39.0.md` | uvicorn | pypi | 0.39.0 | 2025-12-21 |
| `uvicorn-9342337b@0.52.0.md` | uvicorn | pypi | 0.52.0 | 2026-07-29 |
| `uvicorn-9342337b@0.51.0.md` | uvicorn | pypi | 0.51.0 | 2026-07-08 |
| `uvicorn-9342337b@0.52.4.md` | uvicorn | pypi | 0.52.4 | 2026-08-19 |
| `uvicorn-9342337b@0.50.1.md` | uvicorn | pypi | 0.50.1 | 2026-07-06 |
| `uvicorn-9342337b@0.52.1.md` | uvicorn | pypi | 0.52.1 | 2026-08-01 |
| `uvicorn-9342337b@0.50.2.md` | uvicorn | pypi | 0.50.2 | 2026-07-06 |
| `uvicorn-9342337b@0.41.0.md` | uvicorn | pypi | 0.41.0 | 2026-02-16 |
| `typer-4f6b46bd@0.20.1.md` | typer | pypi | 0.20.1 | 2025-12-19 |
| `typer-4f6b46bd@0.25.0.md` | typer | pypi | 0.25.0 | 2026-04-26 |
| `typer-4f6b46bd@0.21.2.md` | typer | pypi | 0.21.2 | 2026-02-10 |
| `typer-4f6b46bd@0.22.0.md` | typer | pypi | 0.22.0 | 2026-02-11 |
| `typer-4f6b46bd@0.27.0.md` | typer | pypi | 0.27.0 | 2026-07-15 |
| `typer-4f6b46bd@0.26.7.md` | typer | pypi | 0.26.7 | 2026-06-03 |
| `typer-4f6b46bd@0.26.8.md` | typer | pypi | 0.26.8 | 2026-06-26 |
| `typer-4f6b46bd@0.24.0.md` | typer | pypi | 0.24.0 | 2026-02-16 |
| `typer-4f6b46bd@0.27.3.md` | typer | pypi | 0.27.3 | 2026-10-06 |
| `typer-4f6b46bd@0.26.5.md` | typer | pypi | 0.26.5 | 2026-06-01 |

Notes over 30,000 characters are read by the pipeline in parts, but label them whole.
