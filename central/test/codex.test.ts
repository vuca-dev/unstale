// A runner without the Codex CLI: a Codex call fails like a non-zero exit instead of crashing the process.
import { expect, test, vi } from "vitest";

test("a missing Codex binary is a failed call, not an unhandled error", async () => {
  vi.stubEnv("UNSTALE_CODEX_BIN", "/nonexistent/codex");
  vi.resetModules();
  const { runCodex } = await import("../src/pipeline/codex.ts");
  const r = await runCodex("ping");
  expect(r.code).toBeNull();
  expect(r.text).toBe("");
  expect(r.stderr).toContain("ENOENT");
  vi.unstubAllEnvs();
});
