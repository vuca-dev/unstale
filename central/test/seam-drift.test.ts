// The schema seam's drift check (vault: Implementation Stack, "Schema seam": CI fails when generated code drifts).
// Runs both generators' --check on a temp copy of the committed seam: the committed state passes, and a hand edit
// of the generated Zod, of a JSON Schema file, or an unsupported keyword makes them fail.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { generate } from "../scripts/gen-zod.ts";

const CENTRAL = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(CENTRAL, "..");
const TSX = join(CENTRAL, "node_modules", ".bin", "tsx");
const CARGO = [join(homedir(), ".cargo", "bin", "cargo"), "/opt/homebrew/bin/cargo"].find(existsSync) ?? "cargo";

function copySeam(): string {
  const dir = mkdtempSync(join(tmpdir(), "unstale-seam-"));
  cpSync(join(ROOT, "schema"), join(dir, "schema"), { recursive: true });
  mkdirSync(join(dir, "central", "src", "schema"), { recursive: true });
  cpSync(join(ROOT, "central", "src", "schema", "catalog.ts"), join(dir, "central", "src", "schema", "catalog.ts"));
  return dir;
}

const zodCheck = (root: string) =>
  spawnSync(TSX, [join(CENTRAL, "scripts", "gen-zod.ts"), "--check"], {
    env: { ...process.env, UNSTALE_SEAM_ROOT: root },
    encoding: "utf8",
  });

const rustCheck = (schemaDir: string) =>
  spawnSync(CARGO, ["run", "-q", "--manifest-path", join(ROOT, "local", "Cargo.toml"), "--bin", "gen-schema", "--", "--check"], {
    env: { ...process.env, UNSTALE_SCHEMA_DIR: schemaDir },
    encoding: "utf8",
  });

describe("seam drift check", () => {
  test("Zod: committed state passes; an edited generated file or schema fails", () => {
    const root = copySeam();
    expect(zodCheck(root).status).toBe(0);

    const out = join(root, "central", "src", "schema", "catalog.ts");
    const good = readFileSync(out, "utf8");
    writeFileSync(out, good.replace('"summary": z.string()', '"summary": z.string().optional()'));
    const edited = zodCheck(root);
    expect(edited.status).not.toBe(0);
    expect(edited.stderr).toContain("out of date");

    writeFileSync(out, good);
    const file = join(root, "schema", "catalog-root.v1.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { properties: Record<string, unknown> };
    doc.properties.notice = { type: "string" };
    writeFileSync(file, JSON.stringify(doc));
    expect(zodCheck(root).status).not.toBe(0);
  });

  test("Zod generator throws on a keyword it does not handle, so no constraint is dropped silently", () => {
    const root = copySeam();
    const file = join(root, "schema", "catalog-root.v1.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { properties: Record<string, Record<string, unknown>> };
    doc.properties.min_client!.pattern = "^\\d+\\.\\d+\\.\\d+$";
    writeFileSync(file, JSON.stringify(doc));
    expect(() => generate(root)).toThrow(/unsupported keyword "pattern"/);
  });

  test("JSON Schema: committed state passes; an edited schema file fails", { timeout: 300_000 }, () => {
    const root = copySeam();
    const dir = join(root, "schema");
    const ok = rustCheck(dir);
    expect(ok.status, ok.stderr).toBe(0);
    const file = join(dir, "catalog-shard-line.v1.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"jev"', '"jev-preview"'));
    const drift = rustCheck(dir);
    expect(drift.status).not.toBe(0);
    expect(drift.stderr).toContain("schema drift");
  });
});
