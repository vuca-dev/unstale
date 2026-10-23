import { describe, expect, test } from "vitest";
import { interpret, labelQuestions, sizeQuestions } from "../src/pipeline/classify/labels.ts";
import { labelSize } from "../src/pipeline/classify/size.ts";
import { Jev, type Classification, type Questions } from "../src/pipeline/classify/adapter.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import { shardLine } from "../src/pipeline/publish.ts";

const answer = (q: Questions, pick: Record<string, string> = {}): Classification => ({
  classifier: "jev",
  model: "jev-test",
  answers: Object.fromEntries(
    Object.entries(q).map(([id, x]) => {
      const choice = pick[id] ?? Object.keys(x.options).at(-1)!;
      return [id, { choice, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(x.options).map((o) => [o, o === choice ? 0.9 : 0.1 / (Object.keys(x.options).length - 1)])) }];
    }),
  ),
});

const record = (over: Partial<StoredRecord> = {}): StoredRecord => ({
  id: "x:feature", technology: "x-0123abcd", status: "active", revision: 1, label_version: 1, change_type: "new_api", breaking: false,
  surface: "code_api", subject: "feature", subject_kind: "literal", summary: "Adds feature.", benefit: ["none"],
  releases: [{ component: "pkg:npm/x", version: "2.0.0", date: "2026-10-01", line: "2" }], prerequisites: [], conditions: [], requires: [],
  introduces: ["feature"], terms: ["feature"], replaces: [], evidence: [{ kind: "release_notes", url: "https://example.org", quote: "Adds feature.", snapshot: "sha256:00" }],
  related: [], sources: [], history: [], ...over,
});

describe("magnitude and maturity", () => {
  test("are asked in the record's one labelling request and published", () => {
    const q = labelQuestions();
    expect(Object.keys(q)).toHaveLength(10);
    expect(new Jev({ apiKey: () => "k" }).batches({ technology: "x", summary: "s" }, q)).toHaveLength(1);
    const l = interpret(answer(q, { change_type: "new_api", surface: "code_api", breaking: "no", magnitude: "headline", maturity: "beta" }));
    expect([l.magnitude, l.maturity, l.classifier.magnitude]).toEqual(["headline", "beta", 0.9]);
    const line = shardLine(record({ magnitude: "headline", maturity: "beta" })) as { magnitude?: string; maturity?: string };
    expect([line.magnitude, line.maturity]).toEqual(["headline", "beta"]);
    expect(shardLine(record())).not.toHaveProperty("magnitude");
  });

  test("label-size asks only the two questions, of feature records without them, and bumps label_version", async () => {
    const s: TechStore = {
      technology: "x-0123abcd",
      ingested: {},
      records: {
        a: record({ id: "a" }),
        b: record({ id: "b", change_type: "fix" }),
        c: record({ id: "c", magnitude: "minor", maturity: "ga" }),
      },
    };
    const asked: string[][] = [];
    const r = await labelSize(s, async (_st, q) => (asked.push(Object.keys(q)), answer(q, { magnitude: "moderate", maturity: "ga" })));
    expect(r).toEqual({ labelled: 1, failed: 0 });
    expect(asked).toEqual([Object.keys(sizeQuestions())]);
    expect([s.records.a!.magnitude, s.records.a!.maturity, s.records.a!.label_version]).toEqual(["moderate", "ga", 2]);
    expect(s.records.b!.magnitude).toBeUndefined();
  });
});
