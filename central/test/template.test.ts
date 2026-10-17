import { expect, test } from "vitest";
import type { CheckResult } from "../src/collector/schema.ts";
import { findTemplateChanges } from "../src/collector/template.ts";

const changed = (id: string, url: string, added: string[], removed: string[]): CheckResult => ({
  id, url, ms: 1, bytes: 1, outcome: { status: "changed", snapshot: "s", previous: "p", diff: { added, removed } },
});

test("identical diffs on three pages of one host form one template event; others stay page changes", () => {
  const footer = [["Was this helpful?"], ["Rate this page"]] as const;
  const results = [
    changed("a", "https://d.x/a", [...footer[0]], [...footer[1]]),
    changed("b", "https://d.x/b", [...footer[0]], [...footer[1]]),
    changed("c", "https://d.x/c", [...footer[0]], [...footer[1]]),
    changed("d", "https://d.x/d", ["CPU limit is 30 s"], ["CPU limit is 10 s"]),
    changed("e", "https://other.x/e", [...footer[0]], [...footer[1]]),
  ];
  const events = findTemplateChanges(results);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ host: "d.x", ids: ["a", "b", "c"] });
});

test("fewer than three pages is not a template event", () => {
  expect(findTemplateChanges([changed("a", "https://d.x/a", ["x"], []), changed("b", "https://d.x/b", ["x"], [])])).toHaveLength(0);
});
