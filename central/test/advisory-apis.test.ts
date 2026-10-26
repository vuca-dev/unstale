// Per-advisory affected APIs (advisory-apis.ts; known bugs 3.3): one extraction-model call per advisory, names kept
// only when the advisory's text writes them, published in the tech index, and given as terms to a record made from the
// advisory alone.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { advisoryApis, advisoryText, APIS_PROMPT, attachAdvisoryApis, groundedApis, MAX_APIS, MAX_TEXT, packageNamesOf } from "../src/pipeline/advisory-apis.ts";
import type { Advisory } from "../src/pipeline/advisories.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";

// zod's CVE-2023-54404: the summary names no API; the details name `z.array()` (affected) and `.max()` (the mitigation).
const ZOD: Advisory = {
  id: "CVE-2023-54404",
  aliases: ["GHSA-zzzz-yyyy-xxxx"],
  url: "https://osv.dev/vulnerability/CVE-2023-54404",
  summary: "Zod Uncontrolled Resource Consumption via Unbounded Array, Set, and Map Validation",
  details:
    "This is reachable in the default configuration whenever a container schema such as z.array() is declared without a size bound. The upstream change only moves the .max(), .length() and .size() size checks to run before element parsing.",
  published: "2026-10-01",
  affected: [{ component: "pkg:npm/zod", range: ">= 0", type: "SEMVER", listed: [] }],
};

/** A model that answers from a table keyed by a substring of the prompt, and records the prompts. */
function model(answers: Record<string, string>) {
  const prompts: string[] = [];
  const ask = async <T,>(prompt: string, parse: (text: string) => T | undefined): Promise<T | undefined> => {
    prompts.push(prompt);
    const k = Object.keys(answers).find((x) => prompt.includes(x));
    return k === undefined ? undefined : parse(answers[k]!);
  };
  return { ask: ask as never, prompts };
}

describe("advisory affected APIs", () => {
  test("names are kept only as the advisory writes them: not invented, not the package, not prose, at most MAX_APIS", () => {
    const text = advisoryText(ZOD);
    expect(groundedApis(["z.array()", "`z.array`", "z.object", "zod", "unbounded array", 7], text, ["zod"])).toEqual(["z.array"]);
    expect(groundedApis("z.array", text, ["zod"])).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => `api${i}`);
    expect(groundedApis(many, many.join(" "), [])).toHaveLength(MAX_APIS);
  });

  test("one call per advisory reads its summary and details (cut at MAX_TEXT); an advisory naming none gives []", async () => {
    const m = model({ "z.array()": '["z.array", "z.set", "z.map"]', "Prototype": "[]" });
    // z.set and z.map are not written in this text: dropped.
    expect(await advisoryApis(ZOD, ["zod"], m.ask)).toEqual(["z.array"]);
    expect(m.prompts[0]).toContain("for the package zod ");
    expect(m.prompts[0]).toContain(ZOD.details);
    expect(m.prompts[0]!.length).toBeLessThan(APIS_PROMPT.length + MAX_TEXT + 20);
    expect(await advisoryApis({ ...ZOD, summary: "Prototype pollution", details: "x".repeat(3 * MAX_TEXT) }, ["zod"], m.ask)).toEqual([]);
    expect(m.prompts[1]!.length).toBeLessThan(APIS_PROMPT.length + MAX_TEXT + 20);
    // A failed call names nothing.
    expect(await advisoryApis({ ...ZOD, summary: "other", details: "" }, ["zod"], model({}).ask)).toBeUndefined();
  });

  test("the store keeps them per advisory (id and aliases), a record made from the advisory alone gets them as terms, and the index publishes them", async () => {
    const rec = (id: string, kind: string, terms: string[]): StoredRecord =>
      ({
        id, technology: "zod", status: "active", revision: 1, label_version: 1, change_type: "security", breaking: false, surface: "code_api",
        subject: ZOD.summary, subject_kind: "concept", summary: ZOD.summary, benefit: ["security"],
        releases: [{ component: "pkg:npm/zod", version: "4.6.6", date: "2026-10-01", line: "4" }],
        prerequisites: [], conditions: [], requires: [], introduces: [], terms, replaces: [],
        evidence: [{ kind, url: ZOD.url, quote: ZOD.summary, snapshot: "sha256:x" }], related: [], sources: [id], history: [],
        advisories: [{ id: "GHSA-zzzz-yyyy-xxxx", aliases: ["CVE-2023-54404"], summary: ZOD.summary, url: ZOD.url, affected: [] }],
      }) as unknown as StoredRecord;
    const s: TechStore = {
      technology: "zod",
      records: { "zod:a": rec("zod:a", "advisory", []), "zod:b": rec("zod:b", "release_notes", []), "zod:c": rec("zod:c", "advisory", ["z.object"]) },
      ingested: {},
    };
    const none: Advisory = { ...ZOD, id: "GHSA-none-none-none", aliases: [], summary: "Malicious code in zod", details: "" };
    const r = await attachAdvisoryApis(s, [ZOD, none], ["zod"], undefined, undefined, model({ "z.array()": '["z.array"]', Malicious: "[]" }).ask);
    expect(r).toEqual({ advisories: 2, named: 1, records: 1 });
    expect(s.advisoryApis).toEqual([{ ids: ["CVE-2023-54404", "GHSA-zzzz-yyyy-xxxx"], apis: ["z.array"] }]);
    expect(s.records["zod:a"]!.terms).toEqual(["z.array"]);
    expect(s.records["zod:a"]!.label_version).toBe(2);
    // A release-notes record keeps its own matching; a record with terms keeps them.
    expect(s.records["zod:b"]!.terms).toEqual([]);
    expect(s.records["zod:c"]!.terms).toEqual(["z.object"]);
    const dir = mkdtempSync(join(tmpdir(), "unstale-apis-"));
    const { index } = publishTechnology(s, "2026-10-26T00:00:00Z", dir);
    expect(index.advisory_apis).toEqual([{ ids: ["CVE-2023-54404", "GHSA-zzzz-yyyy-xxxx"], apis: ["z.array"] }]);
    expect(JSON.parse(readFileSync(join(dir, "v1", "tech", "zod.json"), "utf8")).advisory_apis).toHaveLength(1);
  });

  test("another database's entry of the same advisory adds its details (the GHSA says only 'an array schema'; the CVE record names z.array())", async () => {
    const ghsa: Advisory = { ...ZOD, id: "GHSA-mrhx-c7xc-m3w5", aliases: ["CVE-2023-54404"], details: "Attackers submit a large array to an application using an array schema without a length constraint." };
    const texts = new Map([["CVE-2023-54404", [ZOD.details!]], ["GHSA-MRHX-C7XC-M3W5", [ghsa.details!]]]);
    const s: TechStore = { technology: "zod", records: {}, ingested: {} };
    const m = model({ "z.array()": '["z.array"]' });
    await attachAdvisoryApis(s, [ghsa], ["zod"], texts, undefined, m.ask);
    expect(s.advisoryApis).toEqual([{ ids: ["GHSA-mrhx-c7xc-m3w5", "CVE-2023-54404"], apis: ["z.array"] }]);
    // Each text once.
    expect(m.prompts[0]!.split(ghsa.details!).length).toBe(2);
  });

  test("an advisory naming none is read once more with its aliases' entries when the package query left them out", async () => {
    const ghsa: Advisory = { ...ZOD, id: "GHSA-mrhx-c7xc-m3w5", aliases: ["CVE-2023-54404"], details: "Attackers submit a large array to an application using an array schema without a length constraint." };
    const s: TechStore = { technology: "zod", records: {}, ingested: {} };
    const m = model({ "z.array()": '["z.array"]', "array schema": "[]" });
    const asked: string[] = [];
    await attachAdvisoryApis(s, [ghsa], ["zod"], new Map(), async (id) => (asked.push(id), id === "CVE-2023-54404" ? ZOD.details : undefined), m.ask);
    expect(asked).toEqual(["CVE-2023-54404"]);
    expect(m.prompts).toHaveLength(2);
    expect(s.advisoryApis).toEqual([{ ids: ["GHSA-mrhx-c7xc-m3w5", "CVE-2023-54404"], apis: ["z.array"] }]);
    // Named the first time: no alias is read.
    const again = model({ "z.array()": '["z.array"]' });
    await attachAdvisoryApis({ technology: "zod", records: {}, ingested: {} }, [ZOD], ["zod"], new Map(), async () => { throw new Error("not read"); }, again.ask);
    expect(again.prompts).toHaveLength(1);
  });

  test("failed extraction preserves published APIs, successful empty clears them, and prompt text stays literal", async () => {
    const s: TechStore = { technology: "zod", records: {}, ingested: {}, advisoryApis: [{ ids: [ZOD.id, ...ZOD.aliases], apis: ["z.array"] }] };
    await attachAdvisoryApis(s, [ZOD], ["zod"], undefined, undefined, model({}).ask);
    expect(s.advisoryApis?.[0]?.apis).toEqual(["z.array"]);
    await attachAdvisoryApis(s, [ZOD], ["zod"], undefined, undefined, model({ "z.array()": "[]" }).ask);
    expect(s.advisoryApis).toEqual([]);
    const details = "Literal $$ $& $` $' with z.array()";
    const m = model({ Literal: '["z.array"]' });
    expect(await advisoryApis({ ...ZOD, details }, ["zod"], m.ask)).toEqual(["z.array"]);
    expect(m.prompts[0]).toContain(details);
  });

  test("package names from package URLs", () => {
    expect(packageNamesOf(["pkg:npm/%40hono/node-server", "pkg:npm/zod", "pkg:pypi/django"])).toEqual(["@hono/node-server", "zod", "django"]);
  });
});
