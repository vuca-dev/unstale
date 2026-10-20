// Slice 9 probe 2 (dev only): where Jev's input tokens go. One call per line.
import { join } from "node:path";
const SELECT = join(import.meta.dirname, "..");
process.env.UNSTALE_CENTRAL_DIR = join(SELECT, "out", "slice9", "central");
const { jevClassifier, jevStats } = await import("../jev.ts");
const { labelQuestions } = await import("../../../central/src/pipeline/classify/labels.ts");
const S = await import("../states.ts");
const G = await import("./grouped.ts");
const V = await import("../../../central/src/pipeline/vocab.ts");

const u = S.benefitUnits().units[0]!;
const cls = jevClassifier({ step: "slice9:probe2", usageLog: join(SELECT, "out", "slice9", "usage.jsonl") });
const yn = (i: string) => ({ instructions: i, options: { yes: "Yes.", no: "No." } });
const one = async (label: string, state: Record<string, unknown>, q: Record<string, { instructions: string; options: Record<string, string> }>) => {
  const before = jevStats.input_tokens;
  try {
    await cls.classify(state, q);
    console.log(`${label}: ${jevStats.input_tokens - before}`);
  } catch (e) {
    console.log(`${label}: ERROR ${e instanceof Error ? e.message : e}`);
  }
};
const tiny = { technology: "x" };
await one("tiny state, 1 y/n", tiny, { a: yn("Is it?") });
await one("tiny state, 2 y/n", tiny, { a: yn("Is it?"), b: yn("Is it?") });
await one("tiny state, 8 y/n", tiny, Object.fromEntries([..."abcdefgh"].map((k) => [k, yn("Is it?")])));
await one("record state, 1 y/n", u.state, { a: yn("Is it?") });
await one("record + rubric(all), 1 y/n", { ...u.state, rubric: G.rubric([...G.FIELDS]) }, { a: yn("Is it?") });
await one("tiny, change_type full", tiny, { a: labelQuestions().change_type! });
await one("tiny, change_type keys=key", tiny, { a: { instructions: "Kind?", options: Object.fromEntries(Object.keys(V.CHANGE_TYPES).map((k) => [k, k])) } });
await one("tiny, change_type keys=''", tiny, { a: { instructions: "Kind?", options: Object.fromEntries(Object.keys(V.CHANGE_TYPES).map((k) => [k, ""])) } });
await one("tiny, change_type keys=ref", tiny, { a: { instructions: "Kind?", options: Object.fromEntries(Object.keys(V.CHANGE_TYPES).map((k) => [k, `rubric.change_type.types.${k}`])) } });
await one("tiny, today's 8", tiny, labelQuestions());
