// The shared prompt data (schema/prompts/*.json): every file parses and carries a version, and the text written out
// in one place agrees with the sets and constants it names elsewhere (a closed set added in one file and not the
// other would send the model a list that is not the one the answer is checked against).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Benefit, ChangeType, Surface } from "../src/schema/catalog.ts";
import { APIS_PROMPT, MAX_APIS } from "../src/pipeline/advisory-apis.ts";
import { EXTRACT_PROMPT, EXTRACT_PROMPT_IDS, LABEL_PROMPT, MAX_UNITS_PER_QUOTE, ONE_CALL_PROMPT, SCHEMA_PROMPT, SCHEMA_RESPONSE_FORMAT } from "../src/pipeline/extract.ts";
import { applyEdits, extractText, fill, labelsText, PROMPT_FILES, promptsDir } from "../src/pipeline/prompts.ts";
import { BENEFITS, CHANGE_TYPES, SURFACES } from "../src/pipeline/vocab.ts";

const enumOf = (u: unknown): string[] => {
  const z = u as { options?: unknown[]; value?: unknown };
  if (Array.isArray(z.options)) return z.options.flatMap((o) => (typeof o === "string" ? [o] : enumOf(o)));
  return z.value !== undefined ? [String(z.value)] : [];
};

describe("schema/prompts", () => {
  test("every file is listed, parses and has a version", () => {
    const dir = new URL("../../schema/prompts/", import.meta.url);
    for (const f of PROMPT_FILES) {
      const v = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { version?: unknown };
      expect(Number.isInteger(v.version) && (v.version as number) > 0, f).toBe(true);
    }
  });

  test("closed sets match the catalog schema", () => {
    expect(Object.keys(CHANGE_TYPES).sort()).toEqual([...enumOf(ChangeType)].sort());
    expect(Object.keys(SURFACES).sort()).toEqual([...enumOf(Surface)].sort());
    expect(labelsText.benefits.map((b) => b.id)).toEqual([...BENEFITS]);
    for (const b of BENEFITS) expect(enumOf(Benefit)).toContain(b);
  });

  test("the extraction prompt and its response schema list the closed sets in the file's order", () => {
    expect(EXTRACT_PROMPT).toContain(`"change_type": one of ${Object.keys(CHANGE_TYPES).join(" | ")},`);
    expect(EXTRACT_PROMPT).toContain(`one of ${Object.keys(SURFACES).join(" | ")},`);
    const items = (SCHEMA_RESPONSE_FORMAT.json_schema.schema as unknown as { properties: { records: { items: { properties: Record<string, { enum?: string[] }> } } } }).properties.records.items.properties;
    expect(items.change_type!.enum).toEqual(Object.keys(CHANGE_TYPES));
    expect(items.surface!.enum).toEqual(Object.keys(SURFACES));
  });

  test("constants a prompt states are the ones the code applies", () => {
    expect(APIS_PROMPT).toContain(`At most ${MAX_APIS}.`);
    expect(EXTRACT_PROMPT_IDS).toContain(`the 1 to ${MAX_UNITS_PER_QUOTE} numbered lines`);
  });

  test("the one-call variants carry the label prompt's rules as written there", () => {
    const rules = LABEL_PROMPT.slice(LABEL_PROMPT.indexOf('Rules for "terms"'), LABEL_PROMPT.indexOf("\n\nRecords:"));
    const intro = LABEL_PROMPT.slice(LABEL_PROMPT.indexOf("A local tool will search"), LABEL_PROMPT.indexOf(" Output only a JSON object"));
    expect(ONE_CALL_PROMPT).toContain(rules);
    expect(ONE_CALL_PROMPT).toContain(intro);
    expect(SCHEMA_PROMPT).toContain(rules.replace('Omit "min" or "max" when the notes do not state\nit.', 'Use null for "min" or "max" when the notes do not state it.'));
    expect(SCHEMA_PROMPT).toContain(intro);
  });

  test("an edit whose target is gone fails loudly", () => {
    expect(() => applyEdits("abc", [{ find: "x", replace: "y" }], "t")).toThrow(/edit target not found/);
    expect(applyEdits("a$b a$b", [{ find: "a$b", replace: "$&$1" }], "t")).toBe("$&$1 a$b");
    expect(() => applyEdits(EXTRACT_PROMPT, extractText.variants.one_call, "one_call")).not.toThrow();
  });

  test("fill leaves inserted text alone", () => {
    expect(fill("%A% %B%", { A: "%B%", B: "x" })).toBe("%B% x");
  });

  test("central finds the files in a checkout, and says where it looked when they are missing", () => {
    const dir = promptsDir({});
    expect(dir).toBe(fileURLToPath(new URL("../../schema/prompts/", import.meta.url)));
    for (const f of PROMPT_FILES) expect(existsSync(join(dir, f)), f).toBe(true);
    const missing = join(fileURLToPath(new URL(".", import.meta.url)), "no-such-prompts-dir");
    const r = spawnSync(process.execPath, ["-e", 'import("./src/pipeline/prompts.ts")'], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, UNSTALE_PROMPTS_DIR: missing }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`not found at ${join(missing, "extract.json")}`);
  });

  test("the central image ships the files where the default looks for them", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const ignore = readFileSync(new URL("../Dockerfile.dockerignore", import.meta.url), "utf8").split("\n");
    const workdir = /^WORKDIR (\S+)$/m.exec(docker)?.[1];
    const copied = /^COPY schema\/prompts (\S+)$/m.exec(docker)?.[1];
    expect(workdir && copied).toBeTruthy();
    // src/pipeline/prompts.ts sits at <workdir>/src/pipeline; the default is three levels up, then schema/prompts.
    expect(posix.join(workdir!, "src/pipeline", "../../../schema/prompts")).toBe(posix.normalize(copied!));
    expect(ignore).toContain("!schema/prompts/");
    expect(docker).toContain('import("./src/pipeline/prompts.ts")');
  });
});

