// Closed sets and their definitions, as the classifier and the extraction prompt see them: data in
// schema/prompts/labels.json (read by prompts.ts), in the file's order. Sets: the catalog's `benefit` field;
// definitions ported from ~/ati-slice0/harness/benefit_label.py (PROMPT_V2) and ~/ati-slice2/harness/dm_breaking.py
// (rubric). test/prompts.test.ts checks the sets against the catalog schema.
import type { CapabilityRecord } from "../schema/catalog.ts";
import { labelsText, optionRecord } from "./prompts.ts";

export type ChangeType = CapabilityRecord["change_type"];
export type Surface = CapabilityRecord["surface"];

export const CHANGE_TYPES = optionRecord(labelsText.change_types) as Record<ChangeType, string>;

export const SURFACES = optionRecord(labelsText.surfaces) as Record<Surface, string>;

export const BENEFITS = ["security", "correctness", "performance", "cost", "maintainability"] as const;
export type BenefitValue = (typeof BENEFITS)[number];

export const BENEFIT_DEFS = optionRecord(labelsText.benefits) as Record<BenefitValue, string>;

export const BENEFIT_RULE = labelsText.benefit_rule;

export const BREAKING_RUBRIC = labelsText.breaking_rubric;
