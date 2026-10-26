# Type-stub deprecations

Known bugs 2.7 (QA 2026-10-19, mui/material-ui attempt 33). DefinitelyTyped packages (`@types/react`) publish no
release notes or changelog, so their deprecations were never covered. They live as `@deprecated` JSDoc tags in the
published `.d.ts` files, where editors strike them through and `no-deprecated` lint fails on them. The mui maintainers
replaced `React.FormEvent` and `React.MutableRefObject` by hand (#49369) while unstale said nothing.

## Rule (central `type-stubs.ts`, no model call)

- For each npm package of a technology, the stub `@types/<name>` (`@types/<scope>__<name>` for a scoped package) is
  read from the registry. A missing stub, or one whose latest version is deprecated (a stub kept only to say the
  package ships its own types), is skipped.
- Per release line, each stable release in the catalog window is compared with the line's previous release. The last
  release before the window is the baseline, so a line that begins in the window adds nothing. A declaration whose
  JSDoc gains `@deprecated` becomes a deprecation record of the typed technology. It is released in the stub package
  (`pkg:npm/%40types/react`), with `replaces` and `terms` set to the name, and the tag's text as the quote. The
  evidence is the declaration file on unpkg.
- A name with an overload that is not deprecated is skipped: its other uses are not deprecated.
- Each tarball is read once, and its deprecations are cached by version. The packument is cached for 12 hours.

The edge needed no change: it places a stub-released record by the stub's installed version (funnel.rs, new test
`a_type_stubs_deprecation_is_in_effect_at_the_installed_stub_version`).

## Measured (full-store copy, `npm run catalog -- type-stubs --all`)

| | |
|---|---|
| Technologies | 2,703 |
| Stub lookups (npm packages of those technologies) | 2,043; 154 stubs live, the rest missing or stub-deprecated |
| Tarballs read | 242 |
| Records added | 5: react `FormEvent`, `FormEventHandler` (@types/react 19.2.10); serverless `lambdaHashingVersion`, `tenant`, `variablesResolutionMode` |
| Model calls | none |

`MutableRefObject` was deprecated in @types/react 19.0.0, before the window, so it is out of scope like any
pre-window release note.

## Release gate (`GATE_K=0`, full-store catalog plus these records, main client 0.2.7)

DEV 27/72, HELD-OUT 6/22, the same as the #147 full-store reference. No key's rank changes, and the match maps were
reused (the event technologies' windows are unchanged).
