# Held-out set 2: upgrade guides and major-version notes (model selection)

This set covers what the first held-out set (`../holdout/`) lacks: long upgrade guides and major-version release notes,
which is where required migrations are documented (`../slice3/RESULTS.md`, "Evalism concerns" 1). It is a
technology-disjoint extraction inventory with 7 documents from 4 technologies. The rules are in `PREREG.md` (written
before any document was fetched, seed `unstale-majors-v1`; the outcome and deviations are at its end). Power is in
`POWER.md`.

**Labels:** independent labelers fill `extraction/labels/<labeler>.json` from `extraction/PACKET.md`. An adjudicated
`extraction/labels/adjudicated.json` (first set's schema plus `required`) is what the scorer reads. No labels exist yet.

## Technologies (held out from every dev set, prompt hill-climb and threshold fit: `technologies.json`)

| Technology | Ecosystem | Major | Published | Guide | Major notes |
|---|---|---|---|---|---|
| `@sveltejs/kit` | npm | 3.0.0 | 2026-10-01 | docs source in the code repository, 29,984 chars | GitHub release body (changesets), 15,407 of 45,631 kept |
| `msw` | npm | 3.0.0 | 2026-09-28 | mswjs.io docs repository, 10,476 | GitHub release body, 3,319 |
| `transformers` | PyPI | 5.0.0 | 2026-01-26 | `MIGRATION_GUIDE_V5.md`, 28,059 of 44,657 kept | GitHub release body, 29,986 of 103,891 kept |
| `mypy` | PyPI | 2.0.0 | 2026-05-06 | none found by the rule | CHANGELOG section, 14,923 |

## Files

| File | What |
|---|---|
| `PREREG.md` | Pools, exclusion, major and document rules, pick, cap, outcome, deviations |
| `majors_lib.py` | Cached HTTPS and `gh api` reads, headings for Markdown and reStructuredText, sections |
| `select_majors.py` | Selection. Writes `out/holdout-majors/{exclusion,selection}.json` |
| `fetch_docs.py`, `chunks.mts` | Documents: cut, cap, save, `notes.json`. Chunks come from the pipeline's own `chunk()`: `python3 -I fetch_docs.py && (cd ../../../central && npx tsx ../eval/select/holdout-majors/chunks.mts)` |
| `extraction/notes/`, `extraction/notes.json` | The 7 documents as saved, and their metadata (technology, ecosystem, kind, version, date, url, source with commit SHA or release id, style, chars, full_chars, cap, kept and dropped sections, chunks) |
| `extraction/PACKET.md` | Labelling instructions, with the `required` field |
| `technologies.json`, `POWER.md` | Held-out declaration; expected group counts and MDD |

Raw whole documents, the registry and API cache, and the selection tables are in `eval/select/out/holdout-majors/`
(gitignored).

## Scoring

```
python3 ../holdout/score.py extraction <incoming.json | {note_file: [quote]}> --labels extraction/labels/adjudicated.json --notes extraction/notes.json
python3 ../holdout/score.py compare <a> <b> --labels extraction/labels/adjudicated.json --notes extraction/notes.json --kind extraction
```

- The matching, group and precision rules are those of the first set (`../holdout/README.md`).
- **Headline: REQUIRED-group recall.** A group is required when any of its items has `required: true` (or
  `"unsure"`). It is also reported excluding unsure. Group recall, breaking recall and precision follow.
- Every metric is reported by technology, by ecosystem, by kind (guide vs major_notes), and by technology × kind.
  `compare` adds paired rows for required, required excluding unsure, guides and major notes.
- **Records must reach the right document.** A guide and the release notes share a technology and version. An
  incoming record goes to the guide when its `key` carries the pipeline's `+guide.<snap>` tag or its `kind` is
  `guide`/`upgrade_guide`; a record may also name `note_file` directly. Technology names match by package name in
  either form (`@sveltejs/kit` or `sveltejs-kit`), not by a store id with a hash suffix.
- Only 7 documents form the clusters, so the note-level bootstrap is coarse. Choose the CI of record before scoring
  (`POWER.md`).
