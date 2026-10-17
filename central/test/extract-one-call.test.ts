// One call per chunk (UNSTALE_EXTRACT_STRUCTURE=one-call): records and their five label fields come from one answer.
// The Codex call is mocked; parseJson is the real one.
import { afterEach, describe, expect, test, vi } from "vitest";

const prompts: string[] = [];
let answer = "";
vi.mock("../src/pipeline/codex.ts", async (orig) => {
  const real = await orig<typeof import("../src/pipeline/codex.ts")>();
  return {
    ...real,
    codex: async <T>(prompt: string, parse: (text: string) => T | undefined) => {
      prompts.push(prompt);
      return parse(answer);
    },
  };
});

const { EXTRACT_PROMPT, LABEL_PROMPT, ONE_CALL_PROMPT, extractRelease, parseOneCall } = await import("../src/pipeline/extract.ts");
const { TECHNOLOGIES } = await import("../src/pipeline/technologies.ts");

const rel = {
  technology: "prisma",
  tag: "7.0.0",
  version: "7.0.0",
  date: "2026-01-01",
  url: "https://example.test/7.0.0",
  snapshot: "sha256:0",
  notes: "## Breaking changes\n- `new PrismaClient()` without an adapter has been removed\n- Node.js 20.19 is required",
};
const record = {
  subject: "PrismaClient",
  subject_kind: "literal",
  facet: null,
  change_type: "removal",
  surface: "code",
  summary: "Constructing PrismaClient without a driver adapter is removed.",
  audience: "application",
  introduces: ["@prisma/adapter-pg"],
  evidence: "new PrismaClient() without an adapter has been removed",
  terms: ["new PrismaClient(", "@prisma/client", "@prisma/adapter-pg"],
  replaces: ["datasourceUrl"],
  requires: ["pg"],
  prerequisites: [{ ecosystem: "npm", name: "node", min: "20.19.0" }],
  conditions: ["PostgreSQL 13 or later"],
};

afterEach(() => {
  delete process.env.UNSTALE_EXTRACT_STRUCTURE;
  prompts.length = 0;
});

describe("one-call extraction", () => {
  test("the prompt is the extraction prompt with the label fields and LABEL_PROMPT's rules folded in", () => {
    expect(ONE_CALL_PROMPT.startsWith(EXTRACT_PROMPT.split('\n "evidence"')[0]!)).toBe(true);
    for (const f of ["terms", "replaces", "requires", "prerequisites", "conditions"]) expect(ONE_CALL_PROMPT).toContain(` "${f}": [`);
    expect(ONE_CALL_PROMPT).toContain('Rules for "terms"');
    expect(ONE_CALL_PROMPT).toContain(LABEL_PROMPT.slice(LABEL_PROMPT.indexOf('"replaces" (0 to 4 terms)'), LABEL_PROMPT.indexOf("\n\nRecords:")));
    expect(ONE_CALL_PROMPT).not.toContain("%RECORDS%");
    expect(ONE_CALL_PROMPT).toContain("%NOTES%");
  });

  test("records are kept when label fields are absent; elements that are not records are dropped", () => {
    const p = parseOneCall(JSON.stringify([record, { subject: "x" }, { ...record, terms: undefined }]))!;
    expect(p).toHaveLength(2);
    expect(p[0]!.labels.terms).toEqual(record.terms);
    expect(parseOneCall("no json here")).toBeUndefined();
  });

  test("one call per chunk; toIncoming gets all five fields from the same object", async () => {
    process.env.UNSTALE_EXTRACT_STRUCTURE = "one-call";
    answer = "```json\n" + JSON.stringify([record]) + "\n```";
    const { incoming, failed } = await extractRelease(TECHNOLOGIES.prisma!, rel);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Release: 7.0.0 (2026-01-01)");
    expect(failed).toBe(0);
    expect(incoming).toHaveLength(1);
    const inc = incoming[0]!;
    expect(inc.key).toBe("prisma@7.0.0#0.0");
    expect(inc.grounded).toBe(true);
    expect(inc.section).toBe("Breaking changes");
    // "introduces" values never become terms.
    expect(inc.terms).toEqual(["new PrismaClient(", "@prisma/client"]);
    expect(inc.replaces).toEqual(["datasourceUrl"]);
    expect(inc.requires).toEqual(["pg"]);
    expect(inc.prerequisites).toEqual([{ ecosystem: "npm", name: "node", min: "20.19.0" }]);
    expect(inc.conditions).toEqual(["PostgreSQL 13 or later"]);
  });

  test("an unparseable answer counts one failed call and yields no records", async () => {
    process.env.UNSTALE_EXTRACT_STRUCTURE = "one-call";
    answer = "sorry";
    const r = await extractRelease(TECHNOLOGIES.prisma!, rel);
    expect(r).toEqual({ incoming: [], failed: 1 });
    expect(prompts).toHaveLength(1);
  });

  test("the default is still two calls: extraction, then labels over the record briefs", async () => {
    answer = JSON.stringify([record]);
    await extractRelease(TECHNOLOGIES.prisma!, rel);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Records:");
  });
});
