// Codex CLI calls for eval scripts that reproduce results measured on Luna through `codex exec` (flags as `_codex` in
// ~/ati-slice0/harness/fw_spike.py), cached by sha256(model + prompt) under the central store. Only answers that
// parse are cached, so a failed or unparseable call is retried on the next run. Central itself calls no Codex
// (central/src/pipeline/llm.ts).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { centralDir } from "../../central/src/pipeline/paths.ts";
import { logUsage, readJson, sha256, sleep, writeAtomic } from "../../central/src/pipeline/util.ts";
import { parseJson } from "../../central/src/pipeline/llm.ts";

export { parseJson };

export const CODEX_MODEL = "gpt-5.6-luna";
const CODEX_BIN = process.env.UNSTALE_CODEX_BIN ?? "/opt/homebrew/bin/codex";
const CONCURRENCY = 5;
const TIMEOUT_MS = 20 * 60 * 1000;

export interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

export const codexStats = { calls: 0, cached: 0, failed: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function exec(prompt: string, model: string): Promise<{ text: string; usage?: CodexUsage; code: number | null; stderr: string }> {
  const work = mkdtempSync(join(tmpdir(), "unstale-codex-"));
  return new Promise((resolve) => {
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "-s", "read-only", "-m", model, "-C", work, prompt];
    const p = spawn(CODEX_BIN, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => p.kill("SIGKILL"), TIMEOUT_MS);
    // No Codex binary: a failed call, as a non-zero exit is, not an unhandled error event.
    p.on("error", (e) => {
      clearTimeout(timer);
      rmSync(work, { recursive: true, force: true });
      resolve({ text: "", code: null, stderr: String(e).slice(-300) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      rmSync(work, { recursive: true, force: true });
      let text = "";
      let usage: CodexUsage | undefined;
      for (const line of out.split("\n")) {
        let e: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string } };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "turn.completed" && e.usage) {
          usage ??= { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
          usage.input_tokens += e.usage.input_tokens ?? 0;
          usage.output_tokens += e.usage.output_tokens ?? 0;
          usage.cached_input_tokens += e.usage.cached_input_tokens ?? 0;
        }
        if (e.type === "item.completed" && e.item?.type === "agent_message") text = e.item.text ?? "";
      }
      resolve({ text, ...(usage ? { usage } : {}), code, stderr: err.slice(-300) });
    });
  });
}

/** One uncached Codex call under the shared concurrency limit (the classifier fallback caches by request itself). */
export const runCodex = (prompt: string, model: string = CODEX_MODEL) => slot(() => exec(prompt, model));

/** Runs a prompt; returns the parsed answer, or undefined after three failed attempts. */
/** Where a parsed answer to this prompt is cached. */
export function codexCachePath(prompt: string, model = CODEX_MODEL): string {
  const key = sha256(`${model}\n${prompt}`);
  return join(centralDir(), "cache", "codex", key.slice(0, 2), `${key}.json`);
}

export async function codex<T>(prompt: string, parse: (text: string) => T | undefined, model = CODEX_MODEL): Promise<T | undefined> {
  const path = codexCachePath(prompt, model);
  const hit = readJson<{ text: string }>(path);
  if (hit) {
    const v = parse(hit.text);
    if (v !== undefined) {
      codexStats.cached++;
      return v;
    }
  }
  return slot(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await exec(prompt, model);
      if (r.usage) {
        codexStats.calls++;
        codexStats.input_tokens += r.usage.input_tokens;
        codexStats.output_tokens += r.usage.output_tokens;
        codexStats.cached_input_tokens += r.usage.cached_input_tokens;
        logUsage({ api: "codex", model, ...r.usage });
      }
      const v = r.code === 0 ? parse(r.text) : undefined;
      if (v !== undefined) {
        writeAtomic(path, JSON.stringify({ model, text: r.text, usage: r.usage }) + "\n");
        return v;
      }
      console.error(`codex: attempt ${attempt + 1} failed (exit ${r.code}${r.text ? ", unparseable answer" : ""}) ${r.stderr.replace(/\s+/g, " ")}`);
      await sleep(10_000 * (attempt + 1));
    }
    codexStats.failed++;
    return undefined;
  });
}
