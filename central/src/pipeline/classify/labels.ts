// The label questions asked of the classifier for each incoming record, and how answers become labels
// (thresholds: ../thresholds.ts). One request of eight choice questions per record. Wording: slice 4's "v1"
// (eval/select/slice4/RESULTS-compress.md, RESULTS-confirm.md): restated options removed, −7.5% Jev input, answers held
// on both held-out sets; shorter blocks lost removal/deprecation or benefit recall.
import type { Classification as PublishedClassification, CapabilityRecord } from "../../schema/catalog.ts";
import type { Incoming } from "../extract.ts";
import { fill, labelsText, optionRecord } from "../prompts.ts";
import { BENEFIT_P, BREAKING_P, CHOICE_CONFIDENCE, isBorderline } from "../thresholds.ts";
import { BENEFIT_DEFS, BENEFIT_RULE, BENEFITS, BREAKING_RUBRIC, CHANGE_TYPES, SURFACES, type ChangeType, type Surface } from "../vocab.ts";
import type { Classification, Questions } from "./adapter.ts";

export function recordState(name: string, r: Incoming): Record<string, unknown> {
  return {
    technology: name,
    source: labelsText.sources[r.kind === "upgrade_guide" ? "upgrade_guide" : r.kind === "docs" ? "docs" : "release_notes"],
    release: r.version,
    subject: r.subject,
    ...(r.facet ? { facet: r.facet } : {}),
    summary: r.summary,
    evidence: r.quote,
    ...(r.section ? { section: r.section } : {}),
    introduces: r.introduces,
    replaces: r.replaces,
  };
}

/** The questions' text is data (schema/prompts/labels.json). */
export function labelQuestions(): Questions {
  const t = labelsText.questions;
  const q: Questions = {
    change_type: { instructions: t.change_type, options: { ...CHANGE_TYPES } },
    surface: { instructions: t.surface, options: { ...SURFACES } },
    breaking: { instructions: fill(t.breaking, { RUBRIC: BREAKING_RUBRIC }), options: optionRecord(t.breaking_options) },
  };
  for (const b of BENEFITS) {
    q[`benefit_${b}`] = {
      instructions: fill(t.benefit, { BENEFIT: b, DEFINITION: BENEFIT_DEFS[b], RULE: BENEFIT_RULE }),
      options: optionRecord(t.benefit_options),
    };
  }
  return q;
}

export interface Labels {
  change_type: ChangeType;
  surface: Surface;
  breaking: boolean;
  benefit: CapabilityRecord["benefit"];
  classifier: PublishedClassification;
}

export function interpret(c: Classification): Labels {
  const a = c.answers;
  const borderline: string[] = [];
  const ct = a.change_type!;
  const sf = a.surface!;
  if (ct.confidence < CHOICE_CONFIDENCE) borderline.push("change_type");
  if (sf.confidence < CHOICE_CONFIDENCE) borderline.push("surface");
  const pBreaking = a.breaking!.probabilities.yes!;
  if (isBorderline(pBreaking)) borderline.push("breaking");
  const scores = BENEFITS.map((b) => ({ benefit: b, p: a[`benefit_${b}`]!.probabilities.yes! }));
  for (const s of scores) if (isBorderline(s.p)) borderline.push(`benefit:${s.benefit}`);
  const present = scores.filter((s) => s.p >= BENEFIT_P).map((s) => s.benefit);
  return {
    change_type: ct.choice as ChangeType,
    surface: sf.choice as Surface,
    breaking: pBreaking >= BREAKING_P,
    benefit: present.length ? present : ["none"],
    classifier: {
      classifier: c.classifier,
      model: c.model,
      change_type: ct.confidence,
      surface: sf.confidence,
      breaking: pBreaking,
      benefit: scores,
      borderline,
    },
  };
}
