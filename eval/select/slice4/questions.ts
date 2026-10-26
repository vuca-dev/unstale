// Slice 4 compression arms (RESULTS-compress.md): question-block variants for step D with the pipeline's answer space
// unchanged (same question ids, same option keys). "base" is the pipeline's labelQuestions(). Designed on dev only.
import { labelQuestions } from "../../../central/src/pipeline/classify/labels.ts";
import type { Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import { BENEFITS, BENEFIT_DEFS, BENEFIT_RULE, BREAKING_RUBRIC, CHANGE_TYPES, SURFACES } from "../../../central/src/pipeline/vocab.ts";

const yn = (yes: string, no: string) => ({ yes, no });

/** V1: the pipeline's text with the redundancy removed (yes/no options that restate the instruction). */
function v1(): Questions {
  const q: Questions = {
    change_type: { instructions: "What kind of change is this? Pick the one type that fits best.", options: { ...CHANGE_TYPES } },
    surface: { instructions: "Where does a project that uses this technology meet this change? Pick the one surface that fits best.", options: { ...SURFACES } },
    breaking: { instructions: `Is this change breaking?\n${BREAKING_RUBRIC}`, options: yn("Breaking.", "Not breaking.") },
  };
  for (const b of BENEFITS) q[`benefit_${b}`] = { instructions: `Does this change bring a ${b} benefit? ${b}: ${BENEFIT_DEFS[b]} ${BENEFIT_RULE}`, options: yn("Yes.", "No.") };
  return q;
}

/** V2: definitions and rubric condensed, every decision boundary kept. */
const CT2: Record<keyof typeof CHANGE_TYPES, string> = {
  new_api: "New function, class, component, hook, module, command or file convention.",
  new_option: "New option, flag, parameter or config key on something existing.",
  behavior_change: "Existing code or config now behaves differently (not a default change, not a bug fix).",
  default_change: "An existing option's default changed.",
  fix: "Bug fix restoring intended behaviour.",
  deprecation: "Still works, marked for future removal.",
  removal: "Removed or no longer works, incl. dropped runtime/platform support.",
  stability_change: "Moved between experimental, beta and stable.",
  performance: "Faster or lighter, nothing new to write.",
  security: "Closes a vulnerability or hardens against misuse.",
  tooling: "CLI, build, codemods, dev server, type generation, test or editor tooling.",
  other: "None of the above.",
};
const SF2: Record<keyof typeof SURFACES, string> = {
  code_api: "Application code calls, imports or extends it.",
  configuration: "Config file or object, setting, env variable.",
  file_convention: "A file or directory name or location the framework recognises.",
  command_line: "A terminal command, subcommand, flag or package.json script.",
  schema_or_migration: "Database schema, data model or migration.",
  types_only: "TypeScript types only, no run-time change.",
  runtime_internal: "Behaves differently at run time; nothing for a project to write.",
  build_tooling: "Build, bundler, compiler or dev server output.",
  other: "None of the above.",
};
const RUBRIC2 =
  "Yes if a project that worked before, upgraded with no change to its code, config, scripts or tooling, then fails " +
  "(error, failed build or type check, missing command) or behaves noticeably differently. Raised minimum runtime or " +
  "dependency versions and removals are breaking. No for: new optional features, deprecations that still work, " +
  "recommendations or optional new defaults, fixes restoring documented behaviour, docs. If the source does not show " +
  "existing code stops working or changes, no.";
const BEN2: Record<(typeof BENEFITS)[number], string> = {
  security: "closes a vulnerability or hardens against misuse",
  correctness: "prevents wrong results, data loss, crashes or hangs",
  performance: "faster, or less memory, CPU, network, queries or bundle size",
  cost: "lowers running cost (compute, storage, paid APIs)",
  maintainability: "a supported built-in replaces code or a package the project maintains itself, named by the record or its `replaces`; not a new capability or a rename",
};
const RULE2 = "Yes only if the summary or evidence states it or it is the feature's documented purpose; not conveniences, naming, types-only changes or new capabilities without it.";
function v2(): Questions {
  const q: Questions = {
    change_type: { instructions: "Kind of change?", options: { ...CT2 } },
    surface: { instructions: "Where does a project meet this change?", options: { ...SF2 } },
    breaking: { instructions: `Breaking? ${RUBRIC2}`, options: yn("Breaking.", "Not breaking.") },
  };
  for (const b of BENEFITS) q[`benefit_${b}`] = { instructions: `${b[0]!.toUpperCase()}${b.slice(1)} benefit (${BEN2[b]})? ${RULE2}`, options: yn("Yes.", "No.") };
  return q;
}

/** V3: glosses of a few words; the rubric in one sentence. */
const CT3: Record<keyof typeof CHANGE_TYPES, string> = {
  new_api: "New API, command or file convention.",
  new_option: "New option on something existing.",
  behavior_change: "Existing behaviour changed.",
  default_change: "A default changed.",
  fix: "Bug fix.",
  deprecation: "Deprecated, still works.",
  removal: "Removed or support dropped.",
  stability_change: "Stability level changed.",
  performance: "Faster or lighter.",
  security: "Security fix or hardening.",
  tooling: "Developer tooling.",
  other: "Other.",
};
const SF3: Record<keyof typeof SURFACES, string> = {
  code_api: "Application code.",
  configuration: "Configuration.",
  file_convention: "File or directory convention.",
  command_line: "Command line.",
  schema_or_migration: "Schema or migration.",
  types_only: "Types only.",
  runtime_internal: "Run-time behaviour only; nothing to write.",
  build_tooling: "Build output.",
  other: "Other.",
};
function v3(): Questions {
  const q: Questions = {
    change_type: { instructions: "Kind of change?", options: { ...CT3 } },
    surface: { instructions: "Where does a project meet this change?", options: { ...SF3 } },
    breaking: {
      instructions: "Breaking: would an unchanged project that worked before fail or behave noticeably differently after upgrading (removals and raised minimum versions count; deprecations, new options and fixes do not)?",
      options: yn("Yes.", "No."),
    },
  };
  for (const b of BENEFITS) q[`benefit_${b}`] = { instructions: `Does the source state a ${b} benefit (${BEN2[b]})?`, options: yn("Yes.", "No.") };
  return q;
}

/** H (dev only, added after the held-out looks): v3's change_type, surface and breaking with v1's benefit questions,
 * because dev already showed v3's benefit recall at 0.5 falling (0.70 against 0.78). Not scored on held-out. */
function h(): Questions {
  const a = v3();
  const b = v1();
  return { change_type: a.change_type!, surface: a.surface!, breaking: a.breaking!, ...Object.fromEntries(BENEFITS.map((x) => [`benefit_${x}`, b[`benefit_${x}`]!])) };
}

/** Slice 14 round 2 (slice14/PREREG.md addendum). X1: the pipeline's questions with only runtime_internal reworded. */
function x1(): Questions {
  const q = labelQuestions();
  q.surface = {
    ...q.surface!,
    options: {
      ...q.surface!.options,
      runtime_internal:
        "Running code behaves differently and a project has nothing to write, configure, run or change for it. Not this surface when existing code, configuration or tooling must adapt, pin or opt back because the change breaks it or changes what it receives.",
    },
  };
  return q;
}

/** X2: the pipeline's questions plus actionable asked directly. */
function x2(): Questions {
  return {
    ...labelQuestions(),
    actionable: {
      instructions:
        "Is there anything for a project that uses this technology to write, configure, run or change for this record? Yes also when the change breaks existing code or changes what it receives without opt-in, since the project must adapt, pin or opt back. No only when running code behaves differently and the project has nothing to do.",
      options: yn("Yes.", "No."),
    },
  };
}

export const VARIANTS: Record<string, () => Questions> = { base: labelQuestions, v1, v2, v3, h, x1, x2 };

/** Record-state variants: "base" is recordState() unchanged; "lean" drops fields the questions do not use. */
export function stateVariant(name: string, s: Record<string, unknown>): Record<string, unknown> {
  if (name === "base") return s;
  if (name === "lean") {
    const { technology: _t, source: _s, release: _r, ...rest } = s;
    return rest;
  }
  throw new Error(`unknown state variant ${name}`);
}
