# WS1: Prompts as shared data

## Scope
Move every model-facing text into one set of data files that central (TypeScript) and the client (Rust) both read:
the extraction prompt and its structured-output schema (`extract.ts`), the label questions, rubrics and definitions
(`classify/labels.ts`, `vocab.ts`), and the judge prompt and rules (`match.ts`). Central keeps working unchanged.

## Pre-conditions
None.

## Acceptance criteria
- [ ] One directory (proposed `schema/prompts/`) holds every prompt, question and rubric as data; each file has a version.
- [ ] Central reads them from there; the TypeScript string constants are gone.
- [ ] **Byte-identical requests:** for a fixed set of states, central's built requests are identical before and after
      (Jev's cache key hashes the question text, so any change empties the cache). A test asserts the cache keys of a
      fixture set are unchanged.
- [ ] The Rust side can load the same files (include them in the binary at build time) and exposes them to WS4.
- [ ] Central tests and `check:schema` pass.

## Callsite map (best effort; verify)
`central/src/pipeline/extract.ts` (EXTRACT_PROMPT, output schema), `classify/labels.ts` (labelQuestions, recordState),
`classify/adapter.ts` (cache key), `vocab.ts` (SURFACES, BENEFIT_DEFS, BREAKING_RUBRIC), `match.ts` (judge rules,
ADVISORY_RULE), `eval/select/*` (imports these; keep them working).

## Test plan
Snapshot the canonical request bodies and cache keys for about 20 fixture states before the move; assert equality
after.

## Risks and rollback
A whitespace change silently invalidates the Jev cache (a cost, not a correctness bug). The snapshot test is the guard.
Rollback: revert the PR.
