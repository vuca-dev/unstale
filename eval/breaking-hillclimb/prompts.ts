// The breaking-question variants of the hill-climb (PLAN.md). Every classifier gets the same instructions and option
// texts; only the transport differs (Jev/Luna: one choice question; Codex: the same text in a batch prompt).
import type { ChoiceQuestion } from "../../central/src/pipeline/classify/adapter.ts";
import { labelQuestions } from "../../central/src/pipeline/classify/labels.ts";
import { BREAKING_RUBRIC } from "../../central/src/pipeline/vocab.ts";

export type Variant = "P0" | "P1" | "P2" | "P3" | "P4";

/** P0: exactly the catalog's breaking question (labels.ts). */
const P0: ChoiceQuestion = labelQuestions().breaking!;

/** P1: the same criteria, reworded. */
const P1: ChoiceQuestion = {
  instructions:
    "Would this change BREAK an existing project?\n" +
    "Answer yes when: take a project that ran correctly on the prior version and upgrade it to this release without " +
    "touching its code, configuration, scripts or tooling; it then fails (it throws an error, its build or type check " +
    "fails, or a command it relies on no longer exists) or it behaves in a different way that its developers or users " +
    "would notice. A higher minimum supported version of a runtime or a dependency counts as breaking. Removing " +
    "something counts as breaking.\n" +
    "Answer no for: a new feature or option that is optional; a deprecation that keeps working (only a warning); a " +
    "recommendation or an optional modernisation (\"we recommend\", \"you may\", \"not required\", defaults for new " +
    "projects that existing projects do not have to adopt); a fix that brings back documented behaviour; changes to " +
    "documentation.\n" +
    "Base the answer on what the change does to existing code, not on the section it appears in. Unless the source " +
    "shows existing code ceasing to work or changing behaviour, answer no.",
  options: { yes: "It breaks existing projects, per these criteria.", no: "It does not break existing projects, per these criteria." },
};

/** P2: obligation semantics (breaking by P0, or a deprecation/rename/replacement the upgrade expects projects to act on). */
const P2: ChoiceQuestion = {
  instructions:
    "Does this change OBLIGE existing projects to act when they upgrade to this release?\n" +
    "Answer yes in either case:\n" +
    "(a) It is BREAKING: a project that worked on the previous version, upgraded to this release with no change to its " +
    "code, configuration, scripts or tooling, then fails (an error, a failed build or type check, a command that no " +
    "longer exists) or behaves differently in a way its users or developers would notice. Raising a minimum supported " +
    "version of a runtime or dependency is breaking. A removal is breaking.\n" +
    "(b) It deprecates, renames or replaces something existing projects use, and the source states a planned removal " +
    "or the old form now gives a warning: the upgrade expects existing projects to migrate, even though the old form " +
    "still works for now.\n" +
    "Answer no for: a new optional feature or option; a recommendation or optional modernisation (\"we recommend\", " +
    "\"you may\", \"not required\", new project defaults that existing projects need not adopt) with no warning and no " +
    "stated removal; a fix that restores documented behaviour; documentation changes.\n" +
    "Judge what the change does to existing projects, not where it is listed. If the source shows neither a break nor " +
    "a deprecation, rename or replacement with a warning or a stated removal, answer no.",
  options: {
    yes: "Breaking, or a deprecation, rename or replacement existing projects are expected to act on.",
    no: "Neither breaking nor an expected migration.",
  },
};

/**
 * P4 (hill-climb, PLAN.md "P4"): P0's rubric plus one paragraph naming the breaking changes P0 misses when the source
 * has no "breaking" wording, and the opt-in cases it over-calls; asked with P3's richer state.
 */
const P4: ChoiceQuestion = {
  instructions:
    `Is this change BREAKING?\n${BREAKING_RUBRIC}\n` +
    "The source need not say \"breaking\". It is breaking when, for an existing project that changes nothing: a default " +
    "or an observable result changes (a bundler or build tool, an output directory or format, a cache lifetime, an ID " +
    "format, a status code, a return value, which listeners or migrations load), unless the source says existing " +
    "projects keep the old behaviour; a class, export, option, flag or command is renamed or removed without the old " +
    "name still working; or implementations of an interface or contract must add or change a method. It is not breaking " +
    "when it only applies to projects that opt in to something new or optional (a new major version of an optional " +
    "dependency, a new output option, moving their own code to a new module format), or when the old form still works " +
    "with a deprecation warning.",
  options: P0.options,
};

export function question(v: Variant): ChoiceQuestion {
  const q = { P0, P1, P2, P3: P0, P4 }[v];
  if (!q) throw new Error(`variant ${v} has no question yet`);
  return q;
}
