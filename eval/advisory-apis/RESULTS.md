# Per-advisory affected APIs

Known bugs 3.3. A lockfile advisory with no record was located only by identifiers in OSV's one-line summary. When
the summary named none, the report said "affected path not checked", even when the advisory's text named the API.
zod's CVE-2023-54404 names `z.array()` only in its details. A record made from an advisory alone had no terms, so
its "affected path not found" was really unchecked.

## Rule

- Central (`advisory-apis.ts`, advisories stage): one extraction-model call per advisory of the technology's
  packages. The model reads the summary, the details, and the details of the advisory's other OSV entries, and names
  the package's own APIs, options, flags or files that code must use to be affected. Mitigations, the fix, internal
  functions and built-ins are left out. A name is kept only if the text writes it verbatim, and at most 6 are kept.
  An advisory naming none is read once more with its aliases' own OSV entries (`GET /v1/vulns/<id>`, cached), when the
  package query returned only the GHSA entry. zod's GHSA-mrhx-c7xc-m3w5 says "an array schema"; its CVE record names
  `z.array()`.
- Published per technology as `TechIndex::advisory_apis` (ids and aliases, APIs). A record made from an advisory alone
  with no terms gets them as terms.
- Edge (`onboarding.rs affected_names`): for a lockfile advisory, central's APIs replace the summary's identifiers
  when any index names the advisory. They are looked for the same way: in production files that import the package,
  as identifiers, with short bare names as calls.

## Cost (gpt-6-luna, flex tier, low effort)

Seeded sample of 200 of the store's 3,355 distinct advisories (`measure.mts`):

| | |
|---|---|
| First read | 200 calls; 626 input and 114 output tokens per call (reasoning included); $0.0000625 per call |
| Second read (named none, alias entries add text) | 86 calls; 620 input and 91 output tokens per call |
| Per advisory, both reads | about 1.4 calls and **$0.00009** |
| Named at least one API | 128 of 200 (64%) |
| Full store, once | about 4,775 advisory entries, about $0.43; afterwards only new or changed advisories |

Calls are cached by request, so a rerun costs nothing. The token-free first pass at registration (`apis: false`) makes
no call.
