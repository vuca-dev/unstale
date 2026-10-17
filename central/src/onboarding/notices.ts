// One record for a package its registry marks deprecated (scope study #6: park deprecated packages, but first tell
// the user's agent, since the deprecation is itself a change it needs). Deterministic, like an advisory's own record
// (advisories.ts): no model call, no classifier provenance; evidence kind `other` points at the registry page.
import type { Verdict } from "../pipeline/admission.ts";
import type { Labels } from "../pipeline/classify/labels.ts";
import type { Incoming } from "../pipeline/extract.ts";
import { withTechLock } from "../pipeline/lock.ts";
import { create } from "../pipeline/match.ts";
import { catalogDir } from "../pipeline/paths.ts";
import { publishTechnology } from "../pipeline/publish.ts";
import { loadStore, saveStore } from "../pipeline/store.ts";
import type { Technology } from "../pipeline/technologies.ts";
import { releaseLine, sha256 } from "../pipeline/util.ts";
import { packageIdentity, type PublicTechnology } from "./discovery.ts";

const DEPRECATION_LABELS = {
  change_type: "deprecation",
  surface: "code_api",
  breaking: false,
  benefit: ["none"],
} as const satisfies Omit<Labels, "classifier">;

/** The registry's deprecation message when admission reports one: `notice: "deprecated"` with `message`, or
 * `notice: { kind: "deprecated", message }`. Undefined otherwise. */
export function deprecationOf(verdict: Verdict): string | undefined {
  const v = verdict as Verdict & { notice?: unknown; message?: unknown };
  if (v.notice === "deprecated") return typeof v.message === "string" && v.message.trim() ? v.message : verdict.why;
  if (v.notice && typeof v.notice === "object" && (v.notice as { kind?: unknown }).kind === "deprecated") {
    const m = (v.notice as { message?: unknown }).message;
    return typeof m === "string" && m.trim() ? m : verdict.why;
  }
  return undefined;
}

export function deprecationIncoming(t: PublicTechnology, message: string, at: string): Incoming {
  const name = packageIdentity(t.purl);
  const url = t.purl.startsWith("pkg:pypi/") ? `https://pypi.org/project/${name}/` : `https://www.npmjs.com/package/${name}`;
  const quote = message.trim().replace(/\s+/g, " ").slice(0, 500) || "This package is deprecated.";
  return {
    key: `${t.id}@${t.latest}+deprecated.${sha256(quote).slice(0, 8)}`,
    kind: "other",
    technology: t.id,
    version: t.latest,
    date: at.slice(0, 10),
    line: releaseLine(t.latest),
    url,
    snapshot: `sha256:${sha256(quote)}`,
    subject: name,
    subject_kind: "literal",
    summary: `${name} is deprecated on its registry: ${quote}`.slice(0, 300),
    introduces: [],
    quote,
    grounded: true,
    terms: [name],
    replaces: [],
    requires: [],
    prerequisites: [],
    conditions: [],
  } as unknown as Incoming;
}

/** Publishes the deprecation record once (keyed by the message); false when it already exists. */
export async function publishDeprecation(tech: Technology, t: PublicTechnology, message: string, at = new Date().toISOString()): Promise<boolean> {
  return withTechLock(tech.id, "onboarding", () => {
    const store = loadStore(tech.id);
    const inc = deprecationIncoming(t, message, at);
    if (store.ingested[inc.key]) return false;
    const r = create(store, inc, DEPRECATION_LABELS as unknown as Labels, tech.components);
    delete r.classifier;
    store.ingested[inc.key] = r.id;
    saveStore(store);
    publishTechnology(store, at, catalogDir());
    return true;
  });
}
