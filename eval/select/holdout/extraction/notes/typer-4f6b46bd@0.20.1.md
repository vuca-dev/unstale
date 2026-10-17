### Features

* ✨ Add support for standard tracebacks via the env `TYPER_STANDARD_TRACEBACK`. PR [#1299](https://github.com/fastapi/typer/pull/1299) by [@colin-nolan](https://github.com/colin-nolan).

### Fixes

* 🐛 Ensure that `options_metavar` is passed through correctly. PR [#816](https://github.com/fastapi/typer/pull/816) by [@gar1t](https://github.com/gar1t).
* 🐛 Ensure an optional argument is shown in brackets, even when `metavar` is set. PR [#1409](https://github.com/fastapi/typer/pull/1409) by [@svlandeg](https://github.com/svlandeg).
* 🐛 Ensure that the default `rich_markup_mode` is interpreted correctly. PR [#1304](https://github.com/fastapi/typer/pull/1304) by [@svlandeg](https://github.com/svlandeg).

### Refactors

* ♻️ Refactor the handling of `shellingham`. PR [#1347](https://github.com/fastapi/typer/pull/1347) by [@nathanjmcdougall](https://github.com/nathanjmcdougall).

### Docs

* 📝 Ensure that bold letters are rendered correctly in `printing.md`. PR [#1365](https://github.com/fastapi/typer/pull/1365) by [@svlandeg](https://github.com/svlandeg).
* 🩺 Update test badge to only reflect pushes to `master`. PR [#1414](https://github.com/fastapi/typer/pull/1414) by [@svlandeg](https://github.com/svlandeg).
* 📝 Update console output on the Rich help formatting page. PR [#1430](https://github.com/fastapi/typer/pull/1430) by [@svlandeg](https://github.com/svlandeg).
* 📝 Update emoji used in Rich help formatting tutorial. PR [#1429](https://github.com/fastapi/typer/pull/1429) by [@svlandeg](https://github.com/svlandeg).
* 📝 Remove duplicate explanation how the path is resolved. PR [#956](https://github.com/fastapi/typer/pull/956) by [@dennis-rall](https://github.com/dennis-rall).
* 📝 Update docs to use `Typer()` more prominently. PR [#1418](https://github.com/fastapi/typer/pull/1418) by [@svlandeg](https://github.com/svlandeg).
* 💄 Use font 'Fira Code' to fix display of Rich panels in docs in Windows. PR [#1419](https://github.com/fastapi/typer/pull/1419) by [@tiangolo](https://github.com/tiangolo).

### Internal

* 🔨  Add `--showlocals` to `test.sh`. PR [#1169](https://github.com/fastapi/typer/pull/1169) by [@rickwporter](https://github.com/rickwporter).
* ⬆ Bump ruff from 0.14.6 to 0.14.8. PR [#1436](https://github.com/fastapi/typer/pull/1436) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1434](https://github.com/fastapi/typer/pull/1434) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ✅ Update tests to use `mod.app` . PR [#1427](https://github.com/fastapi/typer/pull/1427) by [@svlandeg](https://github.com/svlandeg).
* ⬆ Bump actions/checkout from 5 to 6. PR [#1426](https://github.com/fastapi/typer/pull/1426) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1425](https://github.com/fastapi/typer/pull/1425) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump ruff from 0.14.5 to 0.14.6. PR [#1423](https://github.com/fastapi/typer/pull/1423) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump actions/checkout from 5 to 6. PR [#1417](https://github.com/fastapi/typer/pull/1417) by [@dependabot[bot]](https://github.com/apps/dependabot).
* 👷 Upgrade `latest-changes` GitHub Action and pin `actions/checkout@v5`. PR [#1424](https://github.com/fastapi/typer/pull/1424) by [@tiangolo](https://github.com/tiangolo).
* 🔧 Upgrade Material for MkDocs and remove insiders. PR [#1416](https://github.com/fastapi/typer/pull/1416) by [@tiangolo](https://github.com/tiangolo).
* ⬆ Bump mkdocs-material from 9.6.23 to 9.7.0. PR [#1404](https://github.com/fastapi/typer/pull/1404) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump mkdocs-macros-plugin from 1.4.1 to 1.5.0. PR [#1406](https://github.com/fastapi/typer/pull/1406) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump ruff from 0.14.4 to 0.14.5. PR [#1407](https://github.com/fastapi/typer/pull/1407) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1413](https://github.com/fastapi/typer/pull/1413) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump ruff from 0.14.3 to 0.14.4. PR [#1402](https://github.com/fastapi/typer/pull/1402) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1403](https://github.com/fastapi/typer/pull/1403) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump ruff from 0.14.2 to 0.14.3. PR [#1396](https://github.com/fastapi/typer/pull/1396) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1399](https://github.com/fastapi/typer/pull/1399) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump mkdocs-material from 9.6.22 to 9.6.23. PR [#1398](https://github.com/fastapi/typer/pull/1398) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1394](https://github.com/fastapi/typer/pull/1394) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump ruff from 0.14.1 to 0.14.2. PR [#1383](https://github.com/fastapi/typer/pull/1383) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump actions/upload-artifact from 4 to 5. PR [#1388](https://github.com/fastapi/typer/pull/1388) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump mkdocs-macros-plugin from 1.4.0 to 1.4.1. PR [#1389](https://github.com/fastapi/typer/pull/1389) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ Bump actions/download-artifact from 5 to 6. PR [#1391](https://github.com/fastapi/typer/pull/1391) by [@dependabot[bot]](https://github.com/apps/dependabot).
* 🔧 Add PEP-639 license metadata. PR [#1387](https://github.com/fastapi/typer/pull/1387) by [@svlandeg](https://github.com/svlandeg).
* ⬆ Bump mypy from 1.11.2 to 1.14.1. PR [#1375](https://github.com/fastapi/typer/pull/1375) by [@dependabot[bot]](https://github.com/apps/dependabot).
* ⬆ [pre-commit.ci] pre-commit autoupdate. PR [#1380](https://github.com/fastapi/typer/pull/1380) by [@pre-commit-ci[bot]](https://github.com/apps/pre-commit-ci).
* ⬆ Bump ruff from 0.14.0 to 0.14.1. PR [#1379](https://github.com/fastapi/typer/pull/1379) by [@dependabot[bot]](https://github.com/apps/dependabot).