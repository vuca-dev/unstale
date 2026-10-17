// Env-gated extraction variants from slice 3c (eval/select/slice3/RESULTS-3c.md), none of them the default: evidence by
// unit id, one call with a strict records-first schema, the output diet. The defaults must stay byte-for-byte unchanged.
import { afterEach, describe, expect, test } from "vitest";
import {
  dietPrompt,
  EXTRACT_PROMPT,
  EXTRACT_PROMPT_IDS,
  extractDiet,
  extractEvidence,
  extractStructure,
  numberUnits,
  parseIdsAnswer,
  parseSchemaAnswer,
  SCHEMA_PROMPT,
  SCHEMA_RESPONSE_FORMAT,
  unitQuote,
  UNIT_MAX,
} from "../src/pipeline/extract.ts";

afterEach(() => {
  delete process.env.UNSTALE_EXTRACT_EVIDENCE;
  delete process.env.UNSTALE_EXTRACT_STRUCTURE;
  delete process.env.UNSTALE_EXTRACT_DIET;
});

describe("defaults", () => {
  test("every switch defaults to the published behaviour", () => {
    expect(extractEvidence()).toBe("quote");
    expect(extractStructure()).toBe("two-call");
    expect(extractDiet()).toBeUndefined();
  });
  test("switches parse", () => {
    process.env.UNSTALE_EXTRACT_EVIDENCE = "ids";
    process.env.UNSTALE_EXTRACT_STRUCTURE = "one-call-schema";
    process.env.UNSTALE_EXTRACT_DIET = "compact";
    expect([extractEvidence(), extractStructure(), extractDiet()]).toEqual(["ids", "one-call-schema", "compact"]);
    process.env.UNSTALE_EXTRACT_DIET = "1";
    expect(extractDiet()).toBe("full");
  });
});

describe("evidence by unit id", () => {
  const notes = "# Changes\n\n- Removed `foo()`.\n" + "This sentence is long enough to matter here. ".repeat(8).trim();
  test("numbers lines, splits a long line into sentences, skips blank lines", () => {
    const n = numberUnits(notes);
    expect(n.units[0]).toBe("# Changes");
    expect(n.units[1]).toBe("- Removed `foo()`.");
    expect(n.units.length).toBe(2 + 8);
    expect(n.units.every((u) => u.length <= UNIT_MAX)).toBe(true);
    expect(n.text.split("\n")[1]).toBe("");
    expect(n.text).toContain("2| - Removed `foo()`.");
  });
  test("ids name units in reading order, at most three; ranges count from their start", () => {
    const u = ["a", "b", "c", "d", "e"];
    expect(unitQuote([4, 1], u)).toBe("a d");
    expect(unitQuote("2-5", u)).toBe("b c d");
    expect(unitQuote([1, 2, 3, 4], u)).toBe("a b c");
    expect(unitQuote(9, u)).toBe("");
    expect(unitQuote("nope", u)).toBe("");
  });
  test("an ids answer becomes records with rebuilt quotes", () => {
    const { units } = numberUnits(notes);
    const recs = parseIdsAnswer('[{"subject":"foo","summary":"Removed.","evidence":[2]}]', units);
    expect(recs?.[0]?.evidence).toBe("- Removed `foo()`.");
  });
  test("the ids prompt differs from the default only in the evidence field and the notes header", () => {
    expect(EXTRACT_PROMPT_IDS).not.toContain("copied verbatim");
    expect(EXTRACT_PROMPT_IDS).toContain('"|"');
  });
});

describe("one call, records first", () => {
  test("labels attach by id, not position", () => {
    const text = JSON.stringify({
      records: [
        { id: "r1", subject: "a", summary: "A." },
        { id: "r2", subject: "b", summary: "B." },
      ],
      labels: [{ id: "r2", terms: ["b"] }],
    });
    const out = parseSchemaAnswer(text)!;
    expect(out.map((x) => x.record.subject)).toEqual(["a", "b"]);
    expect(out[0]!.labels).toBeUndefined();
    expect(out[1]!.labels).toMatchObject({ terms: ["b"] });
  });
  test("the prompt lists records before labels and the schema is strict", () => {
    expect(SCHEMA_PROMPT.indexOf('"id": "r1"')).toBeLessThan(SCHEMA_PROMPT.indexOf('Then "labels"'));
    expect(SCHEMA_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(SCHEMA_RESPONSE_FORMAT.json_schema.schema.required).toEqual(["records", "labels"]);
  });
});

describe("output diet", () => {
  test("full drops the two unread hint fields; compact keeps them", () => {
    expect(dietPrompt(EXTRACT_PROMPT)).not.toContain('"change_type": one of');
    expect(dietPrompt(EXTRACT_PROMPT, "compact")).toContain('"change_type": one of');
    expect(dietPrompt(EXTRACT_PROMPT, "compact")).toContain("JSON array on one line");
  });
});
