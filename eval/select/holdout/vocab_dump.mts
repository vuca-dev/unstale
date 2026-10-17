// Prints the pipeline constants the packets quote verbatim:  cd central && npx tsx ../eval/select/holdout/vocab_dump.mts > ../eval/select/out/holdout/vocab.json
const v = await import("../../../central/src/pipeline/vocab.ts");
const e = await import("../../../central/src/pipeline/extract.ts");
const m = /Emit one record[\s\S]*?If nothing qualifies, output \[\]\./.exec(e.EXTRACT_PROMPT)![0];
console.log(JSON.stringify({ CHANGE_TYPES: v.CHANGE_TYPES, BENEFIT_DEFS: v.BENEFIT_DEFS, BENEFIT_RULE: v.BENEFIT_RULE, BREAKING_RUBRIC: v.BREAKING_RUBRIC, SURFACES: v.SURFACES, INCLUSION: m }));
