// Closed sets and their definitions, as the classifier and the extraction prompt see them.
// Sets: the catalog's `benefit` field; definitions ported from
// ~/ati-slice0/harness/benefit_label.py (PROMPT_V2) and ~/ati-slice2/harness/dm_breaking.py (rubric).
import type { CapabilityRecord } from "../schema/catalog.ts";

export type ChangeType = CapabilityRecord["change_type"];
export type Surface = CapabilityRecord["surface"];

export const CHANGE_TYPES: Record<Exclude<ChangeType, never>, string> = {
  new_api: "A new function, class, component, hook, module, command or file convention that did not exist before.",
  new_option: "A new option, flag, parameter, argument or configuration key on something that already exists.",
  behavior_change: "Existing code or configuration now behaves differently at run time or build time (not only a default value, not a bug fix).",
  default_change: "The default value of an existing option, setting or mode changed.",
  fix: "A bug fix: wrong results, crashes, errors or regressions corrected, restoring intended or documented behaviour.",
  deprecation: "Something still works but is marked for future removal (a warning, a deprecation notice).",
  removal: "Something that existed was removed or no longer works, including dropped support for a runtime or platform version.",
  stability_change: "An API or feature moved between experimental, preview, beta, unstable and stable.",
  performance: "Faster, or less memory, CPU, network, queries or bundle size, with nothing new to write.",
  security: "Closes a vulnerability or hardens a default or an API against misuse or attack.",
  tooling: "Developer tooling: the CLI, build tooling, codemods, dev server, type generation, test or editor tooling.",
  other: "None of the above.",
};

export const SURFACES: Record<Surface, string> = {
  code_api: "Application code calls, imports, implements or extends it (functions, classes, components, decorators, hooks).",
  configuration: "A configuration file or object, a setting, an environment variable.",
  file_convention: "A file or directory name or location the framework recognises (proxy.ts, app/ routes, schema.prisma location).",
  command_line: "A command, subcommand or flag typed in a terminal or a package.json script.",
  schema_or_migration: "A database schema, a data model definition, or a migration.",
  types_only: "TypeScript types only; nothing changes at run time.",
  runtime_internal: "Running code behaves differently; there is nothing for a project to write.",
  build_tooling: "The build, bundler, compiler or dev server output and behaviour.",
  other: "None of the above.",
};

export const BENEFITS = ["security", "correctness", "performance", "cost", "maintainability"] as const;
export type BenefitValue = (typeof BENEFITS)[number];

export const BENEFIT_DEFS: Record<BenefitValue, string> = {
  security: "Closes a vulnerability, or hardens a default or an API against misuse or attack.",
  correctness: "Prevents wrong results, data loss, crashes, hangs or other bugs in a project that uses this.",
  performance: "Makes a project faster, or use less memory, CPU, network, queries or bundle size.",
  cost: "Lowers what running the project costs (compute, storage, paid API usage, infrastructure).",
  maintainability:
    "Replaces code a project would otherwise write and maintain itself (a hand-rolled helper, workaround or wrapper, or a third-party package used for the same job) with a supported built-in. Only when the record names, or `replaces` lists, what it supersedes; not for a new capability, and not for a rename.",
};

export const BENEFIT_RULE =
  "Answer yes only where the record's summary or evidence states this benefit, or it is the documented purpose of the feature. " +
  "Do not infer gains the source does not claim. New conveniences, ergonomics, naming, style, type-only changes, tooling " +
  "preferences, optional modernisation and new capabilities without this benefit are no.";

export const BREAKING_RUBRIC =
  "BREAKING (yes) means: a project that worked on the previous version, upgraded to this release with no change to its code, " +
  "configuration, scripts or tooling, then fails (an error, a failed build or type check, a command that no longer exists) or " +
  "behaves differently in a way its users or developers would notice. Raising a minimum supported version of a runtime or " +
  "dependency is breaking. A removal is breaking.\n" +
  "NOT BREAKING (no) includes: a new optional feature or option; a deprecation that still works (a warning only); a " +
  "recommendation or optional modernisation (\"we recommend\", \"you may\", \"not required\", new project defaults that existing " +
  "projects need not adopt); a fix that restores documented behaviour; documentation changes.\n" +
  "Judge what the change does to existing code, not where it is listed. If the source does not show that existing code stops " +
  "working or changes behaviour, answer no.";
