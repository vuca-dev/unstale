# Held-out sets: pre-registration (16 October 2026)

Written before any note text of a candidate technology was read. The selection and sampling below are run by
`build.mts` (technologies, notes, records) exactly as stated; any deviation is listed under "Deviations" at the end,
with its reason, and never silently. Seed string everywhere: `SEED = "unstale-holdout-v1"`. "Hash order" means
ascending `sha256(SEED + ":" + <kind> + ":" + <id>)` as lowercase hex.

What I had seen before writing this: active record counts, purls, repositories and release-file counts per stored
technology, and which eval directories mention which candidate names. No note body, no record content.

## 1. Held-out technologies

### npm (2)

1. **Pool:** every technology with a file in `.store/central/records/` whose onboarding job (`.store/central/onboarding/jobs/*.json`) has a `pkg:npm/` purl.
2. **Excluded:** `next`, `prisma`, `nestjs`, `nuxt`, `laravel`, `node`, `fastify`; and any technology whose package
   name, store id or GitHub `owner/repo` occurs (case-insensitive) in any file under `eval/` other than `eval/select`,
   `eval/repos` and `eval/rarity-sample*` (those three are tooling and repository dependency lists, not labelled
   sets). A package name shorter than 4 characters is searched only as `pkg:npm/<name>` and as its repository, so
   that a two-letter name does not match every file. A technology that shares a GitHub repository with an excluded
   one is excluded too.
3. **Eligible:** at least 150 active records whose creating source (the record's first `sources` key) is a
   release-notes extraction (a key with no `+guide`/docs tag), and at least 10 stored release files.
4. **Format, from heading lines only** (lines matching `^#{1,6}\s`): a release file is *changesets* when it has a
   heading `Major Changes`, `Minor Changes` or `Patch Changes`. A technology is **changesets-style** when at least
   80% of its release files are changesets, **prose/GitHub-generated** when at most 20% are.
5. **Pick:** in each of the two styles, the eligible technology first in hash order (kind `npm`, id = store id).
6. **Feasibility (not a content look):** the pipeline's records must be rebuildable without a model call, i.e. the
   store's Codex cache answers every chunk of at least 90% of the technology's release files. If not, the next one in
   hash order of the same style is taken.
7. Every other stored technology that shares a GitHub repository with a pick is declared held-out with it
   (`technologies.json`), so no dev set may use it.

### PyPI (2)

1. **Pool, fixed now** (repository): `pydantic/pydantic`, `pytest-dev/pytest`, `encode/httpx`,
   `sqlalchemy/sqlalchemy`, `fastapi/fastapi`, `encode/starlette`, `encode/uvicorn`, `Textualize/rich`,
   `fastapi/typer`, `python-attrs/attrs`, `psf/requests`, `celery/celery`.
2. **Stable in-window releases:** GitHub Releases (`gh api repos/<repo>/releases`), not draft, not prerelease,
   published on or after 2025-10-15, tag matching `^v?(\d+(?:\.\d+){1,3})$` or `^rel_(\d+)_(\d+)_(\d+)$`.
3. **Eligible:** 8 to 60 such releases (the upper bound caps the Codex calls of step 3), and a median body of at
   least 300 characters (a body that only links to an external changelog is not release notes).
4. **Style, from heading lines only:** per body, *generated* if a heading contains `What's Changed`; else
   *sectioned* if a heading is one of the conventional section names (list in §2); else *flat*. A technology's style
   is the majority over its in-window bodies (ties: generated > sectioned > flat).
5. **Pick:** the eligible repository first in hash order (kind `pypi`, id = `owner/repo`), then the first eligible
   one after it in hash order whose style differs.
6. Bodies are saved raw to `eval/select/out/holdout/notes/<tech>/<version>.md`; the notes used everywhere are the
   body after the onboarding service's `clean` (`pipelineTechnology`: a trailing `Credits` section dropped).

## 2. Extraction inventory set (40 notes)

- **Notes per technology:** every in-window release file (npm: `.store/central/releases/<id>/<version>.md`, cleaned by
  the pipeline's `clean`; PyPI: §1). Notes under 50 non-whitespace characters after cleaning are left out (nothing to
  label).
- **Strata:** length *short* (< 1,500 characters after cleaning) or *long*; structure *structured* when a heading
  line, after stripping emoji, punctuation and a leading number, equals (case-insensitive) one of: Major Changes,
  Minor Changes, Patch Changes, Features, New Features, Bug Fixes, Fixes, Performance Improvements, Performance,
  Reverts, Breaking Changes, Breaking, Deprecations, Deprecated, Documentation, Docs, Refactor, Refactoring, Chores,
  Miscellaneous, Tests, Build System, Continuous Integration, Dependencies, Added, Changed, Removed, Fixed,
  Security, Improvements, Enhancements, Internal; otherwise *prose*. ("What's Changed" is GitHub-generated, not
  conventional: prose unless a conventional heading is also present.)
- **Allocation, 10 per technology:** round-robin over the cells in the order long-structured, long-prose,
  short-structured, short-prose, each cell yielding its notes in hash order (kind `note`, id = `<tech>@<version>`),
  skipping exhausted cells, until 10. This balances the cells as far as each technology allows; the natural
  distribution is reported next to it (the store is 80% short), so pooled numbers are cell-balanced, not natural.
- Files: `extraction/notes/<tech>@<version>.md`.

## 3. Classifier set (240 records)

- **npm (80 per technology):** units are active records whose creating source is a release-notes extraction. The
  unit's state is `recordState(<technology name>, <that incoming record>)`, the incoming record rebuilt by
  `extractRelease`'s exact two calls answered from the store's Codex cache (no model call); a unit counts as faithful
  when the state hits the store's classifier cache (the pipeline asked exactly this request).
- **PyPI (40 per technology):** units are incoming records from running the current two-call extraction
  (`EXTRACT_PROMPT` then `LABEL_PROMPT`, `toIncoming`) with Luna through Codex over **all** in-window notes. There is
  no matching step (it would need the judge), so a unit is an incoming record, the request the classifier is asked.
- **Stratification by the extraction hint `hint_change_type` only** (never by a classifier label): stratum *O* =
  removal, deprecation, behavior_change, default_change; stratum *R* = the rest (a missing hint is R). Per
  technology, n_O = max(round(0.40·n), round(natural_O·n)), capped at what O holds; the rest from R. Within a
  stratum, hash order (kind `rec`, id = record id or incoming key). The natural O rate is reported per technology.
- Units with a state identical to an earlier unit's (same JSON) are skipped as duplicates.

## 4. Labels

I write no reference labels. Packets carry no model or classifier label; the extraction packet carries no record.

## Deviations

1. **§1 npm step 6 (feasibility), reworded before any note or record content was read.** As written it counted every
   stored release file, but the store's onboarding job ingested only 147 of posthog-js's 531 in-window releases (job
   state `partial`), so release files the pipeline never extracted cannot be in its cache whatever the rule. The check
   that matches the intent (the pipeline's records rebuild without a model call) is over the releases the store
   ingested: extraction answered for 147/147 (posthog-js) and 23/23 (zod). Label calls (`LABEL_PROMPT`) are
   unanswered for 18 and 10 of those chunks; the pipeline keeps the records of a failed label call with empty labels
   (`extractRelease`), and the rebuild does the same. The arbiter is the classifier cache: **all 485 active
   release-notes records of the two technologies rebuild, and all 160 sampled states are byte-identical to requests
   the pipeline asked** (`records.json` `faithful`). Under the literal rule there would be no changesets-style
   technology at all (posthog-js is the only one), so the literal rule is not kept.
2. **Structure detection and CRLF.** The first run of `build.mts` missed headings in bodies with `\r\n` line endings
   (the PyPI bodies), classing every typer note as prose although `select_tech.py` (which strips `\r`) had classed
   typer as sectioned. Fixed before sampling; the strata are those of the fixed code.
3. **typer yields 33 records, not 40.** Luna's extraction over all 27 in-window typer notes (96 Codex calls for both
   PyPI technologies, none failed) produced 33 incoming records (uvicorn: 61). All 33 are taken (16 O, 17 R), so the
   classifier set is 233 records, not 240. Not topped up from another technology, which would break the rule.
