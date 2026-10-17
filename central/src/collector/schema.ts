// Types shared by the collector: what to watch, what a check produced, and what is persisted.
import { z } from "zod";
import type { SectionChange } from "./sections.ts";

/** What the watch expects the response to be. A mismatch is a failure, not a change. */
export const Format = z.enum(["markdown", "html", "json", "feed", "text"]);
export type Format = z.infer<typeof Format>;

/** Line-level normalization applied before hashing. The stored snapshot is the normalized text. */
export const NormalizeRules = z.object({
  /** Regular expressions; a line matching any is dropped. */
  dropLines: z.array(z.string()).default([]),
  /** Regular expressions with a replacement, applied to every line in order. */
  replace: z.array(z.object({ pattern: z.string(), with: z.string() })).default([]),
  /** Strip a leading YAML front matter block. */
  dropFrontMatter: z.boolean().default(false),
  /** Sort lines, for unordered content such as model catalogs. */
  sortLines: z.boolean().default(false),
  /**
   * Rewrite Markdown to one canonical form before hashing: list markers, table cell padding and
   * separators, backslash escapes. For generated Markdown copies, whose renderer can change
   * formatting site-wide without any content change. Off for raw Git sources.
   */
  canonicalMarkdown: z.boolean().default(false),
});
export type NormalizeRules = z.infer<typeof NormalizeRules>;

export const WatchSpec = z.object({
  id: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  format: Format,
  /** CSS selector for the content element of an HTML page. Missing element is a failure. */
  selector: z.string().optional(),
  /** CSS selectors removed before the content selector is applied. */
  remove: z.array(z.string()).default([]),
  /** Pinned request headers. Merged over the collector defaults. */
  headers: z.record(z.string(), z.string()).default({}),
  normalize: NormalizeRules.default({ dropLines: [], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: false }),
});
export type WatchSpec = z.infer<typeof WatchSpec>;
export type WatchSpecInput = z.input<typeof WatchSpec>;

/** Closed set of failure kinds, recorded as coverage state. */
export const FailureKind = z.enum([
  "network", // connection refused, reset, DNS failure
  "timeout",
  "http_status", // non-2xx/304 final status
  "blocked_url", // private, reserved or non-http(s) target, including via redirect
  "too_many_redirects",
  "too_large",
  "format_mismatch", // e.g. HTML returned where Markdown was expected
  "selector_not_found",
  "empty_text", // content present but no text after extraction
  "parse", // malformed JSON or feed
]);
export type FailureKind = z.infer<typeof FailureKind>;

export type Outcome =
  | { status: "not_modified" } // 304
  | { status: "unchanged" } // fetched, same normalized text (or same raw bytes)
  | { status: "first_seen"; snapshot: string }
  | { status: "rebaseline"; snapshot: string } // watch config changed; new baseline, not a content change
  | {
      status: "changed";
      snapshot: string;
      previous: string;
      diff: LineDiff;
      /** Section-scoped diff, for Markdown and HTML watches. */
      sections?: SectionChange[];
      /** Set when the new snapshot equals an earlier one in history: likely flapping (CDN edges serving different deploys) or a rollback. */
      revertsTo?: string;
    }
  | { status: "failed"; failure: FailureKind; detail: string; httpStatus?: number };

export interface LineDiff {
  added: string[];
  removed: string[];
}

export interface CheckResult {
  id: string;
  url: string;
  finalUrl?: string;
  outcome: Outcome;
  ms: number;
  bytes: number;
}

export const HistoryEntry = z.object({ at: z.string(), snapshot: z.string() });

export const WatchState = z.object({
  configHash: z.string(),
  etag: z.string().optional(),
  lastModified: z.string().optional(),
  rawHash: z.string().optional(),
  snapshot: z.string().optional(), // blob hash of the current normalized text
  lastCheckedAt: z.string().optional(),
  lastChangedAt: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative().default(0),
  lastFailure: z.object({ kind: FailureKind, detail: z.string(), at: z.string() }).optional(),
  history: z.array(HistoryEntry).default([]),
});
export type WatchState = z.infer<typeof WatchState>;
