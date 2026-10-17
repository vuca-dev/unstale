// Held-out matching run (docs/match-audit-heldout.md): Nuxt through the committed pipeline into a side store, never
// published and never added to TECHNOLOGIES. Run from an export of the committed tree so uncommitted work in the
// working tree cannot change the measurement:
//
//   git archive HEAD central/src | tar -x -C $EXPORT && ln -s ~/unstale/central/node_modules $EXPORT/central/
//   UNSTALE_SRC=$EXPORT/central/src UNSTALE_CENTRAL_DIR=~/unstale/.store/central-trust-nuxt \
//     npx tsx eval/heldout/nuxt.mts [--offline]
const SRC = process.env.UNSTALE_SRC;
if (!SRC) throw new Error("set UNSTALE_SRC to an exported central/src");
const { runTechnology, makeClassifier } = await import(`${SRC}/pipeline/pipeline.ts`);
const { codexStats } = await import(new URL("../lib/codex.ts", import.meta.url).href);

export const NUXT = {
  id: "nuxt",
  name: "Nuxt",
  repo: "nuxt/nuxt",
  components: ["pkg:npm/nuxt"],
  tag: /^v(\d+\.\d+\.\d+)$/,
  // Contributor credits are not changes (as `noCredits` for Next.js).
  clean: (b: string) => b.replace(/\n#+\s*❤️\s*Contributors[\s\S]*$/, ""),
};

const cls = makeClassifier();
const report = await runTechnology(NUXT, { offline: process.argv.includes("--offline"), publish: false, sample: false, guides: true }, cls);
console.log(JSON.stringify({ ...report, classifier: cls.counts, codex: codexStats }));
