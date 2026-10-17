// The label questions asked of the classifier for each incoming record, and how answers become labels
// (thresholds: ../thresholds.ts). One request of eight choice questions per record. Wording: slice 4's "v1"
// (eval/select/slice4/RESULTS-compress.md, RESULTS-confirm.md): restated options removed, −7.5% Jev input, answers held
// on both held-out sets; shorter blocks lost removal/deprecation or benefit recall.
import type { Classification as PublishedClassification, CapabilityRecord } from "../../schema/catalog.ts";
import type { Incoming } from "../extract.ts";
import { BENEFIT_P, BREAKING_P, CHOICE_CONFIDENCE, isBorderline } from "../thresholds.ts";
import { BENEFIT_DEFS, BENEFIT_RULE, BENEFITS, BREAKING_RUBRIC, CHANGE_TYPES, SURFACES, type ChangeType, type Surface } from "../vocab.ts";
import type { Classification, Questions } from "./adapter.ts";

export function recordState(name: string, r: Incoming): Record<string, unknown> {
  return {
    technology: name,
    source: r.kind === "upgrade_guide" ? "upgrade guide" : r.kind === "docs" ? "official documentation change" : "release notes",
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

export function labelQuestions(): Questions {
  const q: Questions = {
    change_type: {
      instructions: "What kind of change is this? Pick the one type that fits best.",
      options: { ...CHANGE_TYPES },
    },
    surface: {
      instructions: "Where does a project that uses this technology meet this change? Pick the one surface that fits best.",
      options: { ...SURFACES },
    },
    breaking: {
      instructions: `Is this change breaking?\n${BREAKING_RUBRIC}`,
      options: { yes: "Breaking.", no: "Not breaking." },
    },
  };
  for (const b of BENEFITS) {
    q[`benefit_${b}`] = {
      instructions: `Does this change bring a ${b} benefit? ${b}: ${BENEFIT_DEFS[b]} ${BENEFIT_RULE}`,
      options: { yes: "Yes.", no: "No." },
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
