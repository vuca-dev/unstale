// Generates the central pipeline's Zod schemas from the JSON Schema that the Rust schema crate writes
// (`schema/*.json`, source of truth: `local/schema`). `--check` fails if the committed output differs.
//
// The generated Zod is the writer's contract, so every object is strict (unknown keys rejected), even
// though the JSON Schema leaves objects open for tolerant readers. The generator handles only the
// subset of JSON Schema the Rust types produce and throws on anything else, so it cannot drop a
// constraint silently.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Schema = Record<string, unknown>;

// `UNSTALE_SEAM_ROOT` points the generator at another checkout (the drift test runs it on a temp copy).
const ROOT = process.env.UNSTALE_SEAM_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "central", "src", "schema", "catalog.ts");
const DOCS: Array<[file: string, name: string]> = [
  ["catalog-shard-line.v1.json", "ShardLine"],
  ["catalog-tech-index.v1.json", "TechIndex"],
  ["catalog-root.v1.json", "Root"],
  ["catalog-technologies.v1.json", "Technologies"],
];
// Keywords that carry no validation, or that are handled where they appear.
const IGNORED = new Set(["$schema", "title", "description", "$defs", "format"]);

function fail(path: string, msg: string): never {
  throw new Error(`gen-zod: ${path}: ${msg}`);
}

function checkKeys(s: Schema, path: string, allowed: string[]): void {
  for (const k of Object.keys(s)) {
    if (!IGNORED.has(k) && !allowed.includes(k)) fail(path, `unsupported keyword "${k}"`);
  }
}

function refName(ref: unknown, path: string): string {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) fail(path, `unsupported $ref ${String(ref)}`);
  return ref.slice("#/$defs/".length);
}

function objectBody(s: Schema, path: string): string {
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const required = new Set((s.required ?? []) as string[]);
  const fields = Object.keys(props)
    .sort()
    .map((k) => {
      const { default: dflt, ...rest } = props[k]!;
      const z = expr(rest, `${path}.${k}`);
      // A serde default: optional in the input, always present in the parsed (and so published) output.
      const field = dflt !== undefined ? `${z}.default(${JSON.stringify(dflt)})` : required.has(k) ? z : `${z}.optional()`;
      return `  ${JSON.stringify(k)}: ${field},`;
    });
  return `{\n${fields.join("\n")}\n}`;
}

function expr(s: Schema, path: string): string {
  if ("$ref" in s && "properties" in s) {
    // An internally tagged variant: the tag's properties beside a referenced struct.
    checkKeys(s, path, ["$ref", "properties", "required", "type"]);
    return `${refName(s.$ref, path)}.extend(${objectBody(s, path)}).strict()`;
  }
  if ("$ref" in s) {
    checkKeys(s, path, ["$ref"]);
    return refName(s.$ref, path);
  }
  if ("anyOf" in s) {
    // Only an optional reference (`Option<Struct>`): exactly one schema beside `{"type": "null"}`.
    checkKeys(s, path, ["anyOf"]);
    const parts = s.anyOf as Schema[];
    const nul = parts.findIndex((p) => JSON.stringify(p) === '{"type":"null"}');
    if (parts.length !== 2 || nul < 0) fail(path, "unsupported anyOf (only X or null)");
    return `${expr(parts[1 - nul]!, `${path}.anyOf`)}.nullable()`;
  }
  if ("oneOf" in s) {
    checkKeys(s, path, ["oneOf"]);
    const variants = (s.oneOf as Schema[]).map((v, i) => expr(v, `${path}.oneOf[${i}]`));
    return `z.union([\n${variants.join(",\n")},\n])`;
  }
  if ("enum" in s) {
    checkKeys(s, path, ["enum", "type"]);
    return `z.enum(${JSON.stringify(s.enum)})`;
  }
  if ("const" in s) {
    checkKeys(s, path, ["const", "type"]);
    return `z.literal(${JSON.stringify(s.const)})`;
  }
  const type = s.type;
  if (Array.isArray(type)) {
    const [t, n] = type;
    if (type.length !== 2 || n !== "null") fail(path, `unsupported type ${JSON.stringify(type)}`);
    return `${expr({ ...s, type: t }, path)}.nullable()`;
  }
  switch (type) {
    case "string":
      checkKeys(s, path, ["type"]);
      return "z.string()";
    case "number": {
      checkKeys(s, path, ["type", "minimum", "maximum"]);
      const f = s.format;
      if (f !== undefined && f !== "double" && f !== "float") fail(path, `unsupported number format ${String(f)}`);
      let z = "z.number()";
      if (typeof s.minimum === "number") z += `.min(${s.minimum})`;
      if (typeof s.maximum === "number") z += `.max(${s.maximum})`;
      return z;
    }
    case "boolean":
      checkKeys(s, path, ["type"]);
      return "z.boolean()";
    case "integer": {
      checkKeys(s, path, ["type", "minimum", "maximum"]);
      let z = "z.number().int()";
      if (typeof s.minimum === "number") z += `.min(${s.minimum})`;
      if (typeof s.maximum === "number") z += `.max(${s.maximum})`;
      const f = s.format;
      if (f === "uint8") z += ".max(255)";
      else if (f === "uint32") z += ".max(4294967295)";
      else if (f === "uint64") z += ".max(Number.MAX_SAFE_INTEGER)";
      else if (f !== undefined) fail(path, `unsupported integer format ${String(f)}`);
      return z;
    }
    case "array":
      if ("prefixItems" in s) {
        checkKeys(s, path, ["type", "prefixItems", "minItems", "maxItems"]);
        const items = s.prefixItems as Schema[];
        if (s.minItems !== items.length || s.maxItems !== items.length) fail(path, "open tuple");
        return `z.tuple([${items.map((v, i) => expr(v, `${path}[${i}]`)).join(", ")}])`;
      }
      checkKeys(s, path, ["type", "items"]);
      return `z.array(${expr(s.items as Schema, `${path}[]`)})`;
    case "object":
      checkKeys(s, path, ["type", "properties", "required", "additionalProperties"]);
      if (s.additionalProperties !== undefined && s.additionalProperties !== false) fail(path, "open map");
      return `z.strictObject(${objectBody(s, path)})`;
    default:
      return fail(path, `unsupported schema ${JSON.stringify(s).slice(0, 80)}`);
  }
}

function refsOf(s: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(s)) s.forEach((v) => refsOf(v, out));
  else if (s && typeof s === "object") {
    for (const [k, v] of Object.entries(s)) {
      if (k === "$ref" && typeof v === "string") out.add(v.slice("#/$defs/".length));
      else refsOf(v, out);
    }
  }
  return out;
}

export function generate(root: string = ROOT): string {
  const defs = new Map<string, Schema>();
  const tops: Array<[string, Schema]> = [];
  for (const [file, name] of DOCS) {
    const doc = JSON.parse(readFileSync(join(root, "schema", file), "utf8")) as Schema;
    for (const [k, v] of Object.entries((doc.$defs ?? {}) as Record<string, Schema>)) {
      const prev = defs.get(k);
      if (prev && JSON.stringify(prev) !== JSON.stringify(v)) fail(file, `conflicting definitions of ${k}`);
      defs.set(k, v);
    }
    tops.push([name, doc]);
  }
  // Definitions in dependency order, so each constant is declared before use.
  const order: string[] = [];
  const visit = (k: string, stack: string[]): void => {
    if (order.includes(k)) return;
    if (stack.includes(k)) fail(k, "recursive definitions are not supported");
    for (const d of [...refsOf(defs.get(k), new Set())].sort()) visit(d, [...stack, k]);
    order.push(k);
  };
  [...defs.keys()].sort().forEach((k) => visit(k, []));

  const out = [
    "// Generated by central/scripts/gen-zod.ts from schema/*.json (source: local/schema). Do not edit.",
    "// The writer's contract: objects are strict. Readers (the Rust client) tolerate unknown fields and values.",
    'import { z } from "zod";',
    "",
  ];
  for (const [name, s] of [...order.map((k) => [k, defs.get(k)!] as const), ...tops]) {
    out.push(`export const ${name} = ${expr(s, name)};`);
    out.push(`export type ${name} = z.infer<typeof ${name}>;`, "");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = generate();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {}
    if (current !== text) {
      console.error("gen-zod: central/src/schema/catalog.ts is out of date; run `npm run gen:zod`");
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
