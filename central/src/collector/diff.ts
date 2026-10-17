// Changes-only line diff between two normalized snapshots.
import { diffLines } from "diff";
import type { LineDiff } from "./schema.ts";

export function lineDiff(before: string, after: string): LineDiff {
  const added: string[] = [];
  const removed: string[] = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.replace(/\n$/, "").split("\n");
    (part.added ? added : removed).push(...lines);
  }
  return { added, removed };
}
