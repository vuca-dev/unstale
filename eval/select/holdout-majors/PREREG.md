# Held-out set 2 (upgrade guides and major-version notes): pre-registration (16 October 2026)

Written at 2026-10-16T17:05Z, before any document of a candidate technology was fetched or read, and before the
exclusion search below was run. The rules are run by `select_majors.py` (selection: registry metadata, release-body
lengths and heading lines, repository file paths and sizes only) and `fetch_docs.py` (the documents) exactly as
stated. Any deviation is listed under "Deviations" at the end, with its reason, never silently.

Seed string everywhere: `SEED = "unstale-majors-v1"`. "Hash order" means ascending
`sha256(SEED + ":" + <kind> + ":" + <id>)` as lowercase hex.

**Why this set exists** (`eval/select/slice3/RESULTS.md`): the first held-out set (`eval/select/holdout/`) has no
upgrade guides and no major-version notes, and every candidate's dev and gate losses sit there. This set holds only
those two kinds of document, from technologies disjoint from every other set.

What I had seen before writing this: the names of the stored technologies (`.store/central/records/`), the first
held-out set's files, `eval/select/splits.json`'s dev and held-out lists, and the top-level layout of `eval/`. No
document of any candidate below, no registry data, no release list.

## 1. Candidate pools (fixed now)

Each entry: registry package, code repository, docs source repository (where the official docs' source files live;
`=` means the code repository). Packages marked *calver* are versioned by year and follow the 0.x rule (§2.3).

### npm (main pool)

| Package | Code repository | Docs source |
|---|---|---|
| `vite` | vitejs/vite | = |
| `vitest` | vitest-dev/vitest | = |
| `eslint` | eslint/eslint | = |
| `typescript` | microsoft/TypeScript | microsoft/TypeScript-Website |
| `storybook` | storybookjs/storybook | = |
| `mongoose` | Automattic/mongoose | = |
| `astro` | withastro/astro | withastro/docs |
| `@angular/core` | angular/angular | = |
| `react-router` | remix-run/react-router | = |
| `svelte` | sveltejs/svelte | = |
| `@sveltejs/kit` | sveltejs/kit | = |
| `tailwindcss` | tailwindlabs/tailwindcss | tailwindlabs/tailwindcss.com |
| `express` | expressjs/express | expressjs/expressjs.com |
| `nx` | nrwl/nx | = |
| `pnpm` | pnpm/pnpm | pnpm/pnpm.io |
| `ai` | vercel/ai | = |
| `@tanstack/react-query` | TanStack/query | = |
| `drizzle-orm` | drizzle-team/drizzle-orm | drizzle-team/drizzle-orm-docs |
| `typeorm` | typeorm/typeorm | = |
| `msw` | mswjs/msw | mswjs/mswjs.io |
| `webpack` | webpack/webpack | webpack/webpack.js.org |
| `electron` | electron/electron | = |
| `jest` | jestjs/jest | = |
| `prettier` | prettier/prettier | = |
| `uuid` | uuidjs/uuid | = |

### PyPI (main pool)

| Package | Code repository | Docs source |
|---|---|---|
| `pytest` | pytest-dev/pytest | = |
| `django` | django/django | = |
| `pandas` | pandas-dev/pandas | = |
| `langchain` | langchain-ai/langchain | langchain-ai/docs |
| `transformers` | huggingface/transformers | = |
| `huggingface-hub` | huggingface/huggingface_hub | = |
| `pillow` | python-pillow/Pillow | = |
| `redis` | redis/redis-py | = |
| `websockets` | python-websockets/websockets | = |
| `sqlalchemy` | sqlalchemy/sqlalchemy | = |
| `pydantic` | pydantic/pydantic | = |
| `httpx` | encode/httpx | = |
| `starlette` | encode/starlette | = |
| `celery` | celery/celery | = |
| `black` (*calver*) | psf/black | = |
| `ruff` | astral-sh/ruff | = |
| `mypy` | python/mypy | = |
| `aiohttp` | aio-libs/aiohttp | = |
| `psycopg` | psycopg/psycopg | = |
| `sphinx` | sphinx-doc/sphinx | = |
| `setuptools` | pypa/setuptools | = |
| `openai` | openai/openai-python | = |
| `numpy` | numpy/numpy | = |
| `marshmallow` | marshmallow-code/marshmallow | = |
| `flask` | pallets/flask | = |

### Reserve pools (used only if a main pool yields fewer than 2 technologies, in hash order, same rules)

npm: `mocha` (mochajs/mocha), `chai` (chaijs/chai), `yargs` (yargs/yargs), `commander` (tj/commander.js),
`sequelize` (sequelize/sequelize), `koa` (koajs/koa), `three` (mrdoob/three.js), `undici` (nodejs/undici).
PyPI: `scikit-learn` (scikit-learn/scikit-learn), `matplotlib` (matplotlib/matplotlib), `polars` (pola-rs/polars),
`apache-airflow` (apache/airflow), `alembic` (sqlalchemy/alembic), `jinja2` (pallets/jinja), `click` (pallets/click),
`werkzeug` (pallets/werkzeug).

## 2. Selection

### 2.1 Exclusion (before anything else)

1. Named: `next`, `prisma`, `nestjs`, `nuxt`, `laravel`, `node`, `fastify`, `posthog-js`, `zod`, `uvicorn`, `typer`.
2. **Named anywhere in `eval/` outside `eval/select/`**, plus `eval/select/splits.json` and the `technologies.json`
   of every held-out set: a candidate is excluded when its package name, the bare name of a scoped package
   (`@angular/core` → `angular`), or its code repository `owner/repo` occurs in any text file there
   (case-insensitive, whole-word: not preceded or followed by a letter, digit, `-`, `_` or `.` other than a
   trailing sentence period). A name shorter than 4 characters is searched only as `pkg:npm/<name>`,
   `pkg:pypi/<name>` and as its repository. Unlike the first set, `eval/repos` and `eval/rarity-sample*` are **not**
   exempt (the brief says "anything named in eval/ outside select/"); this excludes more, never less. Binary and
   gzip files are skipped. Every hit (file, term) is written to `out/holdout-majors/exclusion.json`.
3. A candidate sharing its code repository with an excluded one is excluded.

### 2.2 The major release (stable semver projects)

- Versions and dates from the registry: npm `https://registry.npmjs.org/<pkg>` (`time`), PyPI
  `https://pypi.org/pypi/<pkg>/json` (the earliest `upload_time_iso_8601` of a version's files). Pre-releases
  (any version with a letter in it, `rc`, `a`, `b`, `dev`, `-`) are ignored; yanked PyPI versions are ignored.
- A **major** is a version `X.0.0` (PyPI: `X.0` or `X.0.0`) with `X ≥ 1` and X greater than every earlier stable
  major. It is **in window** when published on or after 2025-10-15.
- The technology's major is the **latest** in-window major (its upgrade guide is what the docs source holds now).

### 2.3 0.x and calver projects

For a project whose latest stable version is 0.x, or marked *calver*: a candidate release is a stable `0.Y.0` (calver:
the first stable release of a year, `YY.1.0`/`YY.1` or `YYYY.1.0`), in window, whose notes document (§2.4) has a
**heading line** matching `/breaking/i` **and** a heading line matching `/migrat|upgrad/i`. The latest such release is
the technology's major. A 0.x project's `1.0.0` is a major under §2.2.

### 2.4 The two documents

**Major notes** (`kind: major_notes`), the first that exists with at least 3,000 characters:

1. the GitHub release (`gh api repos/<repo>/releases/tags/<tag>`, not draft) whose tag is, in this order, one of
   `v<V>`, `<V>`, `<name>@<V>`, `<name>==<V>`, `<name>-v<V>`, `<name>-<V>`, `<name>/v<V>` (`<name>`: the package
   name, then its bare name; `<V>`: `X.0.0`, and for PyPI also `X.0`): its body after the pipeline's release `clean`
   (style `github_release`);
2. else the version's section in a changelog file at the code repository's default-branch HEAD (paths matching
   `/(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS)[^/]*\.(md|rst|txt)$/i`, outside test/fixture directories; for a monorepo
   the file in the package's own directory first): from the heading line whose text contains the version as a whole
   token to the next heading of the same or a higher level (style `changelog_section`);
3. else a docs release-notes page in the docs source whose file name names the version (`6.0.txt`, `v3.0.0.rst`,
   `12.0.0.rst`, `version-5.md`) under a path matching `/(release|whatsnew|changelog|news)/i` (style `docs_page`).

**Upgrade guide** (`kind: guide`): in the docs source at default-branch HEAD, files with extension
`md|mdx|markdown|rst|txt` whose path matches `/(upgrad|migrat)/i`, outside translations (a path segment that is a
language code other than `en`, or `i18n`, `translations`, `locales`), tests, fixtures, blog archives and versioned
archives of older docs (`versioned_docs`, `/v\d+/` directories for a version below X), and:

- whose **file name or parent directory** names the major (`X`, `vX`, `X.0`, `X.x` as a whole token, e.g.
  `migrating_to_9.md`, `upgrade-to/v6.mdx`, `MIGRATION_GUIDE_V5.md`), taken whole; or, if none does,
- a multi-version migration file (`MIGRATION.md`, `UPGRADING.md`, `migration-guide.md`, …) with a **heading line**
  naming the major as its target (`to X`, `X.0`, `vX`, `X.x`), from that heading to the next heading of the same or
  a higher level.

Several candidates: the one whose name names the major, then the largest. At least 3,000 characters, else no guide.
A source that is a docs-site page with no public source file is not fetched (no HTML scraping) and counts as no guide.

The text is the source file as committed (Markdown, MDX or reStructuredText), pinned to the commit SHA read at fetch
time; nothing is rewritten. GitHub release bodies are saved as returned by the API.

### 2.5 Eligibility and pick

- **Eligible:** not excluded, has an in-window major (§2.2 or §2.3), and at least one of its two documents exists
  with ≥ 3,000 characters.
- **Style** of a technology: its notes style (`github_release`, `changelog_section`, `docs_page`, or `none`) and
  whether it has a guide.
- **Pick, per ecosystem, in hash order** (kind `npm` or `pypi`, id = the package name):
  1. the first eligible technology **with a guide**; if none has a guide, the first eligible;
  2. then the first eligible technology after pick 1 in hash order whose notes style differs from pick 1's; if none
     differs, the next eligible one in hash order.
- If a main pool yields fewer than 2, its reserve pool is evaluated the same way and appended after it in hash order.
- Every other pool candidate sharing a code repository with a pick is declared held-out with it.

## 3. Documents and the size cap

- Per technology: the guide and the major notes (whichever exist, ≥ 3,000 characters each).
- **Cap ~60,000 characters per technology.** If the two together exceed 60,000: a document of ≤ 30,000 characters
  is taken whole and the other is capped at 60,000 minus its length; if both exceed 30,000, each is capped at 30,000.
- **Capping** keeps whole top-level sections in order: the text before the first top-level heading, then top-level
  sections until the next one would pass the cap. *Top-level* is the highest heading level that occurs at least twice
  (Markdown `#` depth; reStructuredText underline/overline style, levels in order of first appearance). If the first
  top-level section alone passes the cap, the same rule is applied inside it one level down. What was cut is recorded
  per document (`notes.json`: `full_chars`, `kept_sections`, `dropped_sections`).
- A changelog section or a guide extracted from a multi-version file is cut at its own boundaries first, then capped.
- **No cleaning** beyond that: the pipeline's release `clean` drops only a trailing `Credits` section of GitHub release
  bodies; it is applied to `github_release` bodies (as the pipeline would), and to nothing else.
- Files: `extraction/notes/<package-slug>@<version>.<kind>.<ext>` (slug: `@` and `/` → `-`, leading `-` dropped; ext
  the source's: `md`, `mdx` or `rst`; release bodies `md`). Metadata in `extraction/notes.json`: technology,
  ecosystem, kind, version, date, url (the human page), source (repo, path, sha or release id), style, chars,
  full_chars, chunks (`chunk()` from `central/src/pipeline/extract.ts`, `MAX_CHUNK` 30,000, run on the saved text),
  and the cap record. Raw fetches (whole files, release JSON, registry JSON) go to `eval/select/out/holdout-majors/`.

## 4. Labels and scoring

I write no reference labels and open no model output. Labelers work from `extraction/PACKET.md`, which adds one field
to the first set's: `required` (a step a project upgrading to this major must take). The scorer is
`eval/select/holdout/score.py extraction --notes <this notes.json>`; its headline adds **required-group recall**
(a group is required when any of its items is `required: true`; `unsure` required items are reported separately)
next to group recall, breaking recall and precision, per technology and per kind (guide vs major_notes).

## Outcome (run 2026-10-16, `select_majors.py`, then `fetch_docs.py` and `chunks.mts`)

- Exclusion: 248 eval files searched. Excluded 19 of 25 npm main-pool candidates, 8 of 25 PyPI candidates, and 2 of 8
  npm reserves. Hits are in `out/holdout-majors/exclusion.json`; most come from `eval/docs-sources` and
  `eval/rarity-sample-2`.
- Eligible (npm, in hash order): react-router 8.0.0, electron 44.0.0, storybook 10.0.0, **@sveltejs/kit 3.0.0**
  (guide), **msw 3.0.0** (guide).
- Eligible (PyPI, in hash order): pandas 3.0.0, pillow 12.0.0, **transformers 5.0.0** (guide), huggingface-hub
  2.0.0, **mypy 2.0.0**, pytest 9.0.0, setuptools 84.0.0, websockets 17.0. No 0.x or calver project qualified under
  §2.3.
- Picks: npm **@sveltejs/kit** (the first with a guide), then **msw**. msw is the only eligible technology after kit
  in hash order; its notes style is the same (`github_release`), so it is taken as the next eligible. PyPI:
  **transformers** (the first with a guide), then **mypy** (the first after it whose notes style differs:
  `changelog_section`). The reserve pools were not needed.
- Source styles in the set: guides from a docs-site source file in the code repository (kit), in a separate docs
  repository (msw, mswjs.io), and a repository-root guide (transformers). Notes from GitHub release bodies (kit,
  msw, transformers) and a CHANGELOG section (mypy).
- Caps (§3): msw and mypy whole. kit: guide 29,984 whole; notes capped at 30,016, keeping Major and Minor Changes and
  dropping Patch Changes. transformers: both documents over 30,000, so each was capped at 30,000. The guide kept 6
  of 14 top-level sections, the notes 10 of 17. Every document is one `chunk()`.

## Deviations

1. **Exclusion search terms for scoped packages (code fix, no effect on the outcome).** The first run searched a
   scoped package whose bare name is under 4 characters (`@sveltejs/kit` → `kit`) only as `pkg:npm/…` and its
   repository, not as the full name `@sveltejs/kit` that §2.1 names. This was fixed before any document was fetched
   and the selection rerun, with identical picks. A manual `grep` of `eval/` (outside `select/`) for svelte, sveltejs,
   sveltekit, msw, mswjs, mypy, transformers and huggingface finds nothing.
2. **Rule details settled in code, not stated above.**
   - Heading detection skips fenced code blocks, so a `#` comment in a code sample is not a heading.
   - "After pick 1 in hash order" does not wrap around.
   - `chars` counts Unicode code points (Python). `chunk_chars` in `notes.json` is the pipeline's `chunk()` lengths
     in UTF-16 units, so it differs by 2 on the transformers documents, which contain emoji.
3. **Document heads are pinned** to the commit SHAs read at selection time (`notes.json` `source.sha`).
   `fetch_docs.py` refuses to run if HEAD has moved since then, because its reads come from the selection's cache.

## Addendum (orchestrator, before any labels or model output exist)

- **Resampling unit for `compare`: top-level sections, not documents.** With only 7 documents a document-level bootstrap is
  too coarse. A section is the text under one top-level heading of its document (`#`/`##`, whichever is the document's
  top level; text before the first heading is its own section). Groups are assigned to the section holding their first
  anchor. Decided before labelling, so it cannot be chosen by its effect on any candidate.
- **The decision uses both held-out sets.** A candidate must pass the floor on this set (required-group recall and
  breaking recall) AND on the first held-out set (`eval/select/holdout/`); a pass on one alone is not a pass.
