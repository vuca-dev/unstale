# Labelling packet: extraction inventory, upgrade guides and major-version notes (held-out set 2)

You list every change in each document below that qualifies, so that extraction can be scored for recall (did a
model find each change, and above all each required migration step?) and precision (is each of its records one of
these changes?). Work from the document text only. Do not look at any model's records, the unstale catalog, the
project's other documentation or other labelers' files.

There are 7 documents from 4 technologies: 3 **upgrade guides** (`kind: guide`) and 4 **major-version release
notes** (`kind: major_notes`). Where a technology has both, the two overlap; label each document on its own.

## Which changes qualify

The pipeline's extraction prompt (`EXTRACT_PROMPT`) states the criterion. Apply it as written:

> Emit one record for each distinct change in these notes that could alter what a developer using this technology
> writes, configures, runs or decides. Skip internal refactors, documentation, examples, tests, build chores, dependency
> bumps of the project's own repository and contributor news. If nothing qualifies, output [].

So: list a change if it could alter what a developer using this technology writes, configures, runs or decides.
Leave out what the skip list names. Nothing else is added to this criterion. In a guide, a step or a described change
qualifies under the same test; background, motivation and "why we did this" paragraphs do not, unless they state a
change. When unsure whether an entry qualifies, include it and set `"unsure": true`; the adjudicator decides.

## One item per distinct change

- One item per distinct change. A bullet or sentence that announces several changes gives several items, and they
  may share the same anchor.
- The same change mentioned twice in one document (a summary at the top and a section below; a heading and the
  paragraph under it) is **one** item; anchor it on the most specific line.
- Documents are judged one by one: a change in both the guide and the release notes of one technology is an item in
  each.
- A step shown only as a code block (a before/after diff, a command): anchor the prose sentence that introduces or
  states it; if there is none, the heading of its section.

## Fields

- **`anchor`**: copy the line of the document that states the change, **verbatim**: the whole bullet or the sentence,
  without the leading `-`/`*`, keeping backticks and punctuation. If a line is longer than about 300 characters,
  copy the one sentence that carries the change. Do not paraphrase, merge two lines or shorten below about 30
  characters unless the line itself is that short (a heading may be). Do not anchor inside a code block. (The scorer
  matches a record's evidence quote to the anchor by containment or similarity, so the anchor has to be text the
  document really contains.)
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

- **`breaking`**: `true` if the change is breaking under the pipeline's rubric (`BREAKING_RUBRIC`, verbatim), else
  `false`:

> BREAKING (yes) means: a project that worked on the previous version, upgraded to this release with no change to its code, configuration, scripts or tooling, then fails (an error, a failed build or type check, a command that no longer exists) or behaves differently in a way its users or developers would notice. Raising a minimum supported version of a runtime or dependency is breaking. A removal is breaking.
> NOT BREAKING (no) includes: a new optional feature or option; a deprecation that still works (a warning only); a recommendation or optional modernisation ("we recommend", "you may", "not required", new project defaults that existing projects need not adopt); a fix that restores documented behaviour; documentation changes.
> Judge what the change does to existing code, not where it is listed. If the source does not show that existing code stops working or changes behaviour, answer no.

- **`required`** (new in this set): `true` if the item is a **required migration step** for a project upgrading from
  the previous major to this one, else `false`.
  - **`true`**: the document tells the upgrader to do something (change code, configuration, scripts, dependencies,
    runtime version or tooling) for the project to keep working or keep its behaviour: "replace X with Y", "rename",
    "you must", "update your …", "X is removed, use Y", "the minimum Node.js / Python / TypeScript version is now N".
    In a **guide**, this is a step the guide says to do. In **release notes**, it is a change that leaves the
    upgrader something they must do (most `breaking: true` items; a removal or a raised minimum always is).
  - **Conditional steps are required**: "if you use `X`, replace it with `Y`" is `true` (the condition is part of the
    item; a project not using `X` simply has no step).
  - **`false`**: new features and options, optional modernisation, recommendations ("we recommend", "you can",
    "optionally", "not required"), deprecations that still work, fixes, performance, and a behaviour change the
    document does not ask the upgrader to act on.
  - A codemod or migration command that performs required steps: the steps it performs keep their own `required`
    value; the command itself is `true` only if the document says to run it.
  - **Unsure**: when the text does not settle whether the step is required (it names a change but neither says to act
    nor makes clear that unchanged code fails), give your best `true`/`false` and set `"unsure": true`. `unsure` covers
    any doubt about the item (whether it qualifies or whether it is required); optionally say which in
    `"unsure_about": "qualifies" | "required" | "breaking"`.
  - `required` and `breaking` differ: a breaking behaviour change the document asks no action for can be
    `required: false`; a step needed only to keep a deprecation warning quiet is `false`.

## Output

One file per labeler, `extraction/labels/<labeler>.json`, with every document below as a key:

```json
{
  "msw@3.0.0.guide.md": [
    {"anchor": "<verbatim line>", "change_type": "removal", "breaking": true, "required": true},
    {"anchor": "<verbatim line>", "change_type": "new_option", "breaking": false, "required": false, "unsure": true, "unsure_about": "qualifies"}
  ],
  "mypy@2.0.0.major_notes.md": []
}
```

The adjudicated file (`extraction/labels/adjudicated.json`, built from the documents and the labeler files only) uses
the first set's schema plus `required`: `{note_file: [{id, group, anchors: [..], change_type, breaking, required,
unsure?}]}`. Items split out of one bullet or sentence share a `group`; a group is required when any of its items is.

## Documents (7; the text is in `extraction/notes/`)

| File | Technology | Ecosystem | Kind | Version | Date | Source style | Chars | Chunks | Cut |
|---|---|---|---|---|---|---|---|---|---|
| `sveltejs-kit@3.0.0.guide.md` | @sveltejs/kit | npm | guide | 3.0.0 | 2026-10-01 | docs source file | 29,984 | 1 | whole |
| `sveltejs-kit@3.0.0.major_notes.md` | @sveltejs/kit | npm | major_notes | 3.0.0 | 2026-10-01 | GitHub release body | 15,407 | 1 | Major and Minor Changes kept; Patch Changes dropped (cap) |
| `msw@3.0.0.guide.md` | msw | npm | guide | 3.0.0 | 2026-09-28 | docs source file (mswjs.io) | 10,476 | 1 | whole |
| `msw@3.0.0.major_notes.md` | msw | npm | major_notes | 3.0.0 | 2026-09-28 | GitHub release body | 3,319 | 1 | whole |
| `transformers@5.0.0.guide.md` | transformers | pypi | guide | 5.0.0 | 2026-01-26 | repository file (`MIGRATION_GUIDE_V5.md`) | 28,059 | 1 | first 6 top-level sections kept, last 8 dropped (cap) |
| `transformers@5.0.0.major_notes.md` | transformers | pypi | major_notes | 5.0.0 | 2026-01-26 | GitHub release body | 29,986 | 1 | first 10 top-level sections kept, last 7 dropped (cap) |
| `mypy@2.0.0.major_notes.md` | mypy | pypi | major_notes | 2.0.0 | 2026-05-06 | CHANGELOG section | 14,923 | 1 | whole |

Source URLs, commit SHAs and the exact kept and dropped section titles are in `extraction/notes.json`. A capped
document ends where the cap fell; label only what it contains. Every document fits one pipeline chunk (`MAX_CHUNK`
30,000 characters).
