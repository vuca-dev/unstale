## v4.18.0

**Full Changelog**: https://github.com/lodash/lodash/compare/4.17.23...4.18.0

### Security

**`_.unset` / `_.omit`**: Fixed prototype pollution via `constructor`/`prototype` path traversal ([GHSA-f23m-r3pf-42rh](https://github.com/lodash/lodash/security/advisories/GHSA-f23m-r3pf-42rh), [fe8d32e](https://github.com/lodash/lodash/commit/fe8d32eda854377349a4f922ab7655c8e5df9a0b)). Previously, array-wrapped path segments and primitive roots could bypass the existing guards, allowing deletion of properties from built-in prototypes. Now `constructor` and `prototype` are blocked unconditionally as non-terminal path keys, matching `baseSet`. Calls that previously returned `true` and deleted the property now return `false` and leave the target untouched.

**`_.template`**: Fixed code injection via `imports` keys ([GHSA-r5fr-rjxr-66jc](https://github.com/lodash/lodash/security/advisories/GHSA-r5fr-rjxr-66jc), CVE-2026-4800, [879aaa9](https://github.com/lodash/lodash/commit/879aaa93132d78c2f8d20c60279da9f8b21576d6)). Fixes an incomplete patch for CVE-2021-23337. The `variable` option was validated against `reForbiddenIdentifierChars` but `importsKeys` was left unguarded, allowing code injection via the same `Function()` constructor sink. `imports` keys containing forbidden identifier characters now throw `"Invalid imports option passed into _.template"`.

### Docs
- Add security notice for `_.template` in threat model and API docs ([#6099](https://github.com/lodash/lodash/pull/6099))
- Document `lower > upper` behavior in `_.random` ([#6115](https://github.com/lodash/lodash/pull/6115))
- Fix quotes in `_.compact` jsdoc ([#6090](https://github.com/lodash/lodash/pull/6090))

### `lodash.*` modular packages

[Diff](https://github.com/lodash/lodash/pull/6157)

We have also regenerated and published a select number of the `lodash.*` modular packages. 

These modular packages had fallen out of sync significantly from the minor/patch updates to lodash. Specifically, we have brought the following packages up to parity w/ the latest lodash release because they have had CVEs on them in the past:

- [lodash.orderby](https://www.npmjs.com/package/lodash.orderby)
- [lodash.tonumber](https://www.npmjs.com/package/lodash.tonumber)
- [lodash.trim](https://www.npmjs.com/package/lodash.trim)
- [lodash.trimend](https://www.npmjs.com/package/lodash.trimend)
- [lodash.sortedindexby](https://www.npmjs.com/package/lodash.sortedindexby)
- [lodash.zipobjectdeep](https://www.npmjs.com/package/lodash.zipobjectdeep)
- [lodash.unset](https://www.npmjs.com/package/lodash.unset)
- [lodash.omit](https://www.npmjs.com/package/lodash.omit)
- [lodash.template](https://www.npmjs.com/package/lodash.template)