// Labels each replay answer-key change required or optional with the central classifier adapter (Jev first, Codex
// fallback, cached; keys are read inside the adapter only). A classifier label, not ground truth.
// Rubric: vault Capability Synthesis, "Breaking labels (15 October 2026)", reframed for a maintainer's change.
//
//   cd ~/unstale/central && npx tsx ../eval/replay/label_keys.mts <work>/replay ../eval/replay/key_labels.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageStats, type Questions } from "../../central/src/pipeline/classify/adapter.ts";
import { makeClassifier } from "../../central/src/pipeline/pipeline.ts";
import { BREAKING_RUBRIC } from "../../central/src/pipeline/vocab.ts";

const EVENTS = ["workout-next16", "invoicerr-prisma7", "invoicerr-nest12"];
const NAMES: Record<string, string> = { next: "Next.js", prisma: "Prisma", nestjs: "NestJS" };

const QUESTIONS: Questions = {
  required: {
    instructions:
      "A project's maintainers made the change below while upgrading a library. Was the change REQUIRED by the upgrade, " +
      "or OPTIONAL?\nREQUIRED means: had they upgraded without this change, the project would fail (an error, a failed " +
      "build, type check or test run, a command that no longer exists) or behave differently in a way its users or " +
      "developers would notice. Judge with the same strict rubric used for breaking changes:\n" +
      BREAKING_RUBRIC +
      "\nOPTIONAL means: adopting a new feature or option, a recommended or optional modernisation, replacing a " +
      "deprecated API that still works, documentation, or tidying. If the description does not show that the project " +
      "would fail or change behaviour without it, answer optional.",
    options: {
      required: "The upgrade breaks the project, or changes its behaviour noticeably, without this change.",
      optional: "The project would keep working as before without this change.",
    },
  },
};

const [workReplay, outPath] = process.argv.slice(2);
if (!workReplay || !outPath) throw new Error("usage: label_keys.mts <work>/replay <out.json>");
const cls = makeClassifier();
const labels: Record<string, Record<string, unknown>> = {};
for (const ev of EVENTS) {
  const k = JSON.parse(readFileSync(join(workReplay, ev, "key.json"), "utf8")) as {
    info: { tech: string; old: string; new: string };
    items: Array<{ id: string; files?: string[]; change: string; responds_to?: string }>;
  };
  labels[ev] = {};
  for (const it of k.items) {
    const state = {
      technology: NAMES[k.info.tech] ?? k.info.tech,
      upgrade: `${k.info.old} -> ${k.info.new}`,
      change: it.change,
      files: (it.files ?? []).slice(0, 12),
      responds_to: it.responds_to ?? "",
    };
    const c = await cls.classify(state, QUESTIONS);
    const a = c.answers.required!;
    labels[ev]![it.id] = { label: a.choice, p_required: a.probabilities.required, confidence: a.confidence, classifier: c.classifier, model: c.model };
    console.log(ev, it.id, a.choice, a.probabilities.required?.toFixed(2), c.classifier);
  }
}
const out = { note: "classifier label, not ground truth", questions: QUESTIONS, labels, uncached_calls: usageStats, cache_hits: cls.cacheHits(), by_classifier: cls.counts };
writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ uncached_calls: usageStats, cache_hits: cls.cacheHits(), by_classifier: cls.counts, fallbacks: cls.fallbacks }));
