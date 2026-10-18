// The pipeline labels only the records its ingest loop will take: a key already ingested, or a later record with a key
// the loop takes first, is skipped there, so labelling it would be a model call whose answer is discarded.
import { describe, expect, test } from "vitest";
import type { Labels } from "../src/pipeline/classify/labels.ts";
import type { Incoming } from "../src/pipeline/extract.ts";
import { labelPending } from "../src/pipeline/pipeline.ts";

const inc = (key: string, summary = key): Incoming => ({ key, summary }) as Incoming;
const labels = (inc: Incoming): Labels => ({ change_type: "feature", surface: "api", breaking: inc.summary.includes("!"), benefit: ["none"] }) as unknown as Labels;

/** A labeller that counts its calls. */
function labeller() {
  const asked: string[] = [];
  return { asked, fn: async (i: Incoming) => (asked.push(i.key), labels(i)) };
}

describe("labelPending", () => {
  test("already-ingested records are not sent to the classifier", async () => {
    const l = labeller();
    const order = [inc("next@1.0.0#0.0"), inc("next@1.0.0#0.1"), inc("next@1.1.0#0.0")];
    const got = await labelPending(order, { "next@1.0.0#0.0": "next:a", "next@1.1.0#0.0": "next:b" }, l.fn);
    expect(l.asked).toEqual(["next@1.0.0#0.1"]);
    expect([...got.keys()]).toEqual([order[1]]);
    expect(got.get(order[1]!)).toEqual(labels(order[1]!));
  });

  test("a fully ingested run makes no classifier call", async () => {
    const l = labeller();
    const got = await labelPending([inc("a"), inc("b")], { a: "x", b: "y" }, l.fn);
    expect(l.asked).toEqual([]);
    expect(got.size).toBe(0);
  });

  test("of records sharing a key, only the first in ingest order is labelled (the loop skips the rest)", async () => {
    const l = labeller();
    const order = [inc("a", "first!"), inc("a", "second"), inc("b")];
    const got = await labelPending(order, {}, l.fn);
    expect(l.asked.sort()).toEqual(["a", "b"]);
    expect(got.get(order[0]!)!.breaking).toBe(true);
    expect(got.has(order[1]!)).toBe(false);
  });

  test("the labels of the records it takes are those a classify-everything pass gives them", async () => {
    const l = labeller();
    const order = Array.from({ length: 20 }, (_, i) => inc(`k${i}`, i % 3 ? `s${i}` : `s${i}!`));
    const ingested = Object.fromEntries(order.filter((_, i) => i % 2).map((x) => [x.key, "r"]));
    const got = await labelPending(order, ingested, l.fn);
    const everything = new Map(order.map((x) => [x, labels(x)]));
    for (const x of order.filter((x) => !ingested[x.key])) expect(got.get(x)).toEqual(everything.get(x));
    expect(l.asked.length).toBe(10);
  });
});
