// The central pipeline's command line.
//
//   npm run pipeline -- [--tech next] [--limit 3] [--refresh] [--offline] [--no-guides] [--no-docs] [--no-publish] [--sample] [--no-budget]
// (--sample: draw a rarity sample for a technology that has none, off by default; an existing sample still counts;
// --no-sample is accepted and is the default;
//      --offline: use the stored release lists whatever their age; --no-docs: no docs pass and no docs section notes)
//   npm run catalog -- show <id>
//   npm run catalog -- correct <id> <field>=<value>... [--claim] [--note text] [--no-publish]
//   npm run catalog -- merge <from-id> <into-id> [--note text] [--no-publish]
//   npm run catalog -- retract <id> [--note text] [--no-publish]
//   npm run catalog -- publish [--tech next]
//   npm run catalog -- dedupe [--tech next | --all] [--no-chunks] [--no-publish]   (records cut from one release-note item, and
//     the same change in two parts of one release body, merged; match.ts mergeSplitRecords, mergeChunkDuplicates)
//   npm run catalog -- type-stubs [--tech next | --all] [--offline] [--no-publish]   (deprecations from the technology's
//     type stubs' declarations; type-stubs.ts. The pipeline and the onboarding service run it after ingest)
