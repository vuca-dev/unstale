# central

The central pipeline: the **collector**, which checks upstream docs, feeds and pricing pages and reports what changed, and the **catalog pipeline**, which turns official release notes into published capability records.

```sh
npm install
npm test                      # unit and local-server tests
npm run typecheck
npm run collect -- test/fixtures/live-sources.json --store .store   # check 103 live sources
npm run replay:node           # acceptance test (needs the Slice 2 corpus in ~/Library/Caches/ati-slice2)
```

## Catalog pipeline

```sh
npm run pipeline                         # fetch → extract → label → classify → match → publish, all technologies
npm run pipeline -- --tech next --limit 3   # smoke run: one technology, its 3 oldest releases in the window
npm run pipeline -- --refresh            # re-list GitHub releases even inside the 12-hour freshness window
npm run catalog -- show <id>
npm run catalog -- correct <id> change_type=removal replaces=a,b [--claim] [--note text]
npm run catalog -- merge <from-id> <into-id>
npm run catalog -- retract <id> [--note text]
npm run catalog -- publish [--tech next]
npm run catalog -- dedupe [--tech next | --all]   # merge records cut from one release-note item, and one change named in two parts of a release body
npm run catalog -- type-stubs [--tech next | --all]   # backfill deprecations from the type stubs' declarations
