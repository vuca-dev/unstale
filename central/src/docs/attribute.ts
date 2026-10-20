// Version attribution for a documentation change. Per changed section, strongest first:
//   marker     the added lines name the version ("Added in v15.2", `versionadded:: 5.1`, Node's `added: v22.3.0`)
//   guide      the page is the upgrade guide to major N: version N.0.0, as the pipeline dates guides. Only the
//              current or previous major: an edit to an older guide is upkeep, and a guide to a major not yet released
//              (Drizzle's v1, Hono's v5) has no version a record can carry yet; both are held. An edit made after the
//              line moved past N.0 (a minor release of N exists) may describe any release of the line up to its newest
//              (TanStack's v5 guide gaining `queryClient.query`, a later 5.x API): it carries that newest release as its
//              bound (`noLaterThan`), so no record from it claims the change at a version inside the range
//   namespace  the page sits in a version namespace (`/docs/orm/v7/`): the release line only
//   unknown    observed on a date, version unknown
// Only `marker` and `guide` give a version a record can carry; the rest are held centrally until the schema decision.
import type { SectionChange } from "../collector/sections.ts";
import { isStable } from "../pipeline/lines.ts";
import { compareVersions } from "../pipeline/util.ts";

export type Attribution =
  | { by: "marker"; version: string; marker: string }
  | { by: "guide"; version: string; noLaterThan?: string }
  | { by: "old-guide"; version: string }
  | { by: "unreleased-guide"; version: string }
  | { by: "namespace"; line: string }
  | { by: "unknown" };

export const publishable = (a: Attribution): a is Extract<Attribution, { by: "marker" | "guide" }> => a.by === "marker" || a.by === "guide";

const V = String.raw`v?(\d+\.\d+(?:\.\d+)?)`;
const MARKERS: RegExp[] = [
  new RegExp(String.raw`\b(?:added|introduced|available|new|deprecated|removed|changed)\s+in\s+(?:version\s+)?${V}\b`, "i"),
  new RegExp(String.raw`\b(?:since|starting (?:with|from|in))\s+(?:version\s+|v)(\d+\.\d+(?:\.\d+)?)\b`, "i"),
  new RegExp(String.raw`\b(?:version(?:added|changed)|deprecated)::\s*${V}`, "i"),
  new RegExp(String.raw`^\s*-?\s*(?:added|deprecated|removed|version):\s*${V}\b`, "i"),
];

/** x.y becomes x.y.0, so a marker compares with registry versions. */
const full = (v: string) => (v.split(".").length === 2 ? `${v}.0` : v);

export interface AttributionContext {
  /** Major of the upgrade guide this page is, when it is one. */
  guideMajor?: string | undefined;
  /** Major of the page's version namespace, when it has one. */
  namespaceMajor?: string | undefined;
  /** The technology's released versions: a marker naming any other version (another product's, a typo) is ignored. */
  versions?: ReadonlySet<string> | undefined;
  /** The technology's current major: a marker above it names something else (a runtime, another product). */
  maxMajor?: string | undefined;
}

/**
 * A version marker added by this change. The marker must be new (a reworded line that keeps "since v3.0" adds
 * nothing), and must name the current or previous major: above it is a runtime or another product, and far below it
 * is another product's version or history the release notes already carry (both seen in NestJS's docs).
 */
export function markerIn(hunks: string, versions?: ReadonlySet<string>, maxMajor?: string): { version: string; marker: string } | undefined {
  const lines = hunks.split("\n");
  const removed = lines.filter((l) => l.startsWith("-")).join("\n").toLowerCase();
  for (const line of lines) {
    if (!line.startsWith("+")) continue;
    for (const re of MARKERS) {
      const m = re.exec(line.slice(1));
      if (!m) continue;
      const version = full(m[1]!);
      const major = Number(version.split(".")[0]);
      if (versions && !versions.has(version)) continue;
      if (maxMajor && (major > Number(maxMajor) || major < Number(maxMajor) - 1)) continue;
      if (removed.includes(m[0].trim().toLowerCase())) continue;
      return { version, marker: m[0].trim() };
    }
  }
  return undefined;
}

/**
 * What a moving page (served from `latest` or an unversioned URL) can describe of major `major`: up to the newest stable
 * release of that major, once the line has a minor release past `major`.0; undefined while it is still at `major`.0.x,
 * where the page's text is the x.0 release's.
 */
export function lineBound(major: string, versions: Iterable<string>): string | undefined {
  const own = [...versions].filter((v) => isStable(v) && v.split(".")[0] === major).sort(compareVersions);
  const newest = own.at(-1);
  return newest && Number(newest.split(".")[1] ?? 0) > 0 ? newest : undefined;
}

export function attribute(s: SectionChange, ctx: AttributionContext): Attribution {
  const m = s.status === "removed" ? undefined : markerIn(s.hunks, ctx.versions, ctx.maxMajor);
  if (m) return { by: "marker", ...m };
  if (ctx.guideMajor) {
    const version = `${ctx.guideMajor}.0.0`;
    const [g, max] = [Number(ctx.guideMajor), Number(ctx.maxMajor)];
    if (ctx.maxMajor && g > max) return { by: "unreleased-guide", version };
    if (ctx.maxMajor && g < max - 1) return { by: "old-guide", version };
    const bound = ctx.versions ? lineBound(ctx.guideMajor, ctx.versions) : undefined;
    return bound ? { by: "guide", version, noLaterThan: bound } : { by: "guide", version };
  }
  if (ctx.namespaceMajor) return { by: "namespace", line: ctx.namespaceMajor };
  return { by: "unknown" };
}

/**
 * The major an upgrade guide is for, from its URL (`version-16`, `upgrading-to-prisma-7`, `/v7`) or, for an
 * unnumbered guide (`/migration`), from its opening text ("from version 11 to version 12").
 */
/** A guide segment, not any page about migrations (`prisma-migrate`, `migrations`) nor a folder of guides from other
 * tools (`migration-guides/migrate-from-miniflare-2`). A guide numbered by its release (`migration-guide-7-0`, the
 * AI SDK's) is a major's guide only at `<major>-0` or `<major>`: `migration-guide-5-1` is a minor's, and
 * `migration-guide-5-0-data` a part of one. */
const GUIDE_SEGMENT = /^(upgrad(e|ing)|migration$|migration-guide(-v?\d{1,3}(-0)?)?$|migrating-to|migrate-to)/;

/** The URL ends in a guide segment, so the page may be an unnumbered guide whose major only its text names. */
export function guideCandidate(url: string): boolean {
  return GUIDE_SEGMENT.test(new URL(url).pathname.toLowerCase().split("/").filter(Boolean).at(-1) ?? "");
}

export function guideMajor(url: string, text?: string): string | undefined {
  const segs = new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  const at = segs.findIndex((s) => GUIDE_SEGMENT.test(s));
  if (at < 0) return undefined;
  const rest = segs.slice(at).join("/");
  const numbered = /^migration-guide-v?(\d{1,3})(?:-0)?$/.exec(segs[at]!)?.[1];
  if (numbered) return numbered;
  const n = /(?:version-|to-(?:[a-z-]+-)?v?|\bv|-)(\d{1,3})(?:\.x)?$/.exec(rest)?.[1] ?? /(?:version-|\bv)(\d{1,3})(?:\D|$)/.exec(rest)?.[1];
  if (n) return n;
  if (at !== segs.length - 1) return undefined; // a page under a guide section (codemods), not the guide itself
  const head = (text ?? "").slice(0, 3000);
  return /\bto\s+(?:[\w.]+\s+)?(?:version\s+|v)(\d{1,3})\b/i.exec(head)?.[1];
}
