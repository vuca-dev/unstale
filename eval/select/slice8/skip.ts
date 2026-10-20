// Slice 8 candidate: a chunk whose every line is release boilerplate is not sent to the extraction model. Extends
// central's contentFree (which it calls first) with line classes that carry no change of the technology itself.
// Generic by construction: no technology, package or repository names; only the shapes changelog generators write.
import { contentFree } from "../../../central/src/pipeline/extract.ts";

export interface SkipOptions {
  /** Lines saying the release is a version bump only (lerna, conventional-changelog). */
  bump?: boolean;
  /** Generic changelog section headings (Bug Fixes, Features, Thank You, …) and credit lists under credit headings. */
  sections?: boolean;
  /** Dependency-update lists: "Updated dependencies" in any form, bare `pkg@version` items, workspace dependency lists. */
  deps?: boolean;
  /** Dependency bump items: "bump X from A to B", "update dependency X to vY", items scoped `deps`/`deps-dev`. */
  bumps?: boolean;
  /** Markup without text: HTML comments, anchors, rules, table rules, fences. */
  markup?: boolean;
  /** Pointer lines that send the reader elsewhere ("See the changelog for details", "You can view the changelog here"). */
  pointers?: boolean;
  /** Release mechanics: "Release v1.2.3", "Version 1.2.3", "Initial release", "No updates", a heading that is one token. */
  release?: boolean;
  /** Items whose conventional-commit type is internal: chore, ci, build, test, style, docs (any scope). */
  chores?: boolean;
  /** Called with the first line that is content (analysis only). */
  onContent?: (line: string) => void;
}

/** Section labels changelog generators write (after emoji, :shortcodes:, counts and versions are removed). */
const SECTION = /^(?:(?:patch|minor|major) changes|what'?s changed|changelog|release notes|bug ?fix(?:es)?|fix(?:es)?|features?|new features|enhancements?|improvements?|chores?|miscellaneous(?: chores)?|misc|other changes|others?|internal|maintenance|refactor(?:ing)?|documentation|docs|dependencies|dependency updates|deps|build(?: system)?|ci|tests?|performance(?: improvements)?|thank you|thanks|authors?|committers?|contributors|new contributors|credits|install(?:ation)?|reverts?)$/i;
const CREDITS = /^(?:thank you|thanks|authors?|committers?|contributors|new contributors|credits)$/i;

const label = (heading: string): string =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/:[a-z_+-]+:/g, " ")
    .replace(/@?[\w./-]*@\d[\w.+-]*|\bv?\d[\w.+-]*/g, " ")
    .replace(/[^\p{L}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function boilerplate(notes: string, o: SkipOptions): boolean {
  if (!notes.trim() || contentFree(notes)) return true;
  let credits = false;
  let fence = false;
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const text = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/&nbsp;/g, "").trim();
    if (o.markup && /^(`{3,}|~{3,})[\w-]*$/.test(line)) {
      // An empty fence pair carries nothing; a fence with content is content (its lines are not boilerplate).
      fence = !fence;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*:?$/.exec(text);
    if (bold && o.sections && SECTION.test(label(bold[1]!))) {
      credits = CREDITS.test(label(bold[1]!));
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(text);
    if (h && !fence) {
      const l = label(h[1]!);
      if (o.sections && (SECTION.test(l) || !l)) {
        credits = CREDITS.test(l);
        continue;
      }
      if (!l) continue;
      if (o.release && !/\s/.test(h[1]!.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").trim())) continue;
      o.onContent?.(line);
      return false;
    }
    if (o.sections && credits && /^[-*+]\s/.test(line)) continue;
    credits = false;
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    if (/^\**\s*Full Changelog\**:?\s*\S*\s*$/i.test(text)) continue;
    if (/^[*_\s]*No (significant )?changes[.!]?[*_\s]*$/i.test(text)) continue;
    if (o.bump && /\bversion bump only\b/i.test(text)) continue;
    if (o.markup && (/^<!--.*-->$/.test(line) || /^<a\s+(name|id)=[^>]*>\s*<\/a>$/i.test(line) || /^[-|:\s]+$/.test(line))) continue;
    if (o.deps) {
      if (/^[-*+]?\s*(?:[0-9a-f]{7,40}:?\s*)?Updated dependencies\b/i.test(text)) continue;
      if (/^[-*+]\s*`?@?[\w./-]+@[\w.^~+-]+`?,?\s*$/.test(text)) continue;
      if (/^[-*+]?\s*The following workspace dependencies were updated\s*$/i.test(text)) continue;
      if (/^[-*+]?\s*(?:dev|peer)?[Dd]ependencies\s*$/.test(text)) continue;
    }
    // The item itself: no list marker, commit hash, changesets "#123 `abc1234` Thanks @user! -" lead, or trailing
    // "by @user in <url>", "(#123)", "(abc1234)" references.
    const item = text
      .replace(/^[-*+]\s*/, "")
      .replace(/^(?:#\d+\s+)?`?[0-9a-f]{7,40}`?:?\s*(?:Thanks\s+@[\w-]+!?\s*-\s*)?/, "")
      .replace(/\s+by\s+@[\w[\]-]+(?:\s+in\s*#?\d*)?\s*$/, "")
      .replace(/(?:\s*\((?:#\d+|[0-9a-f]{7,40})\))+\s*$/g, "")
      .replace(/\s*#\d+\s*$/, "")
      .trim();
    if (o.bumps) {
      // A dependency moved to a version and nothing else said: "bump x from 1 to 2", "update dependency x to v3",
      // optionally under a deps scope ("**deps:**", "chore(deps):", "build(deps-dev):").
      const bare = item.replace(/^(?:\*\*)?(?:(?:chore|build|fix)\()?deps(?:-dev)?\)?:?(?:\*\*)?:?\s*/i, "").replace(/^(?:chore|build)(?:\([^)]*\))?:\s*/i, "");
      if (/^bump(?:ed|s)?\s+`?[@\w./-]+`?\s+(?:from\s+`?v?\d[\w.+-]*`?\s+)?to\s+`?v?\d[\w.+-]*`?$/i.test(bare)) continue;
      if (/^update(?:d|s)?\s+(?:dependency\s+)?`?[@\w./-]+`?\s+(?:from\s+`?v?\d[\w.+-]*`?\s+)?to\s+`?v?\d[\w.+-]*`?$/i.test(bare)) continue;
    }
    if (o.chores && /^(?:\*\*)?(?:chore|ci|build|test|tests|style|docs)(?:\([^)]*\))?!?:(?:\*\*)?\s/i.test(item)) continue;
    if (o.pointers && /^(?:please\s+)?(?:see|refer to|check|read|view|you can (?:view|read|find|see))\b.{0,80}\b(?:changelog|release notes|releases|details|more information|here)\b[^.]{0,40}\.?$/i.test(item) && !/`/.test(item)) continue;
    if (o.release && /^(?:(?:release|version|v)\s*:?\s*v?\d[\w.+-]*|(?:initial|first) release|no updates|nothing to (?:see|report)|no (?:significant |notable |user[- ]facing )?changes(?: in this (?:release|version))?)[.!]?$/i.test(item)) continue;
    o.onContent?.(line);
    return false;
  }
  return true;
}
