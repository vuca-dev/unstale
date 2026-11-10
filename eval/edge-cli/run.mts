// Edge inference through the user's own agent CLIs (Codex `codex exec`, Cursor `agent -p`), headless, on the user's
// plan. Measures harness overhead, latency, parse rate and batching on central's real prompts (EXTRACT_PROMPT for A,
// the label questions for D). See RESULTS.md.
//
//   cd central && npx tsx ../eval/edge-cli/run.mts --cli codex --variant lean --task extract [--model gpt-6-luna]
//
// Tasks: trivial (overhead probe), extract (3 chunks, one call each), labels (5 records, one call each),
// extract8 / labels8 (8 items in one call), sandbox (asks the agent to write a file and run a shell command).
// Every call runs in a fresh empty temp directory; after it, the directory must still be empty.
// One line per call is appended to eval/edge-cli/calls.jsonl (metrics only); raw answers go to $EDGE_RAW if set.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../central/src/pipeline/paths.ts";
import { EXTRACT_PROMPT, chunk, fill } from "../../central/src/pipeline/extract.ts";
import { parseJson } from "../../central/src/pipeline/llm.ts";
import { labelQuestions } from "../../central/src/pipeline/classify/labels.ts";
import { ChatClassifier } from "../../central/src/pipeline/classify/adapter.ts";

const { values: a } = parseArgs({
  options: {
    cli: { type: "string", default: "codex" },
    variant: { type: "string", default: "lean" },
    task: { type: "string", default: "trivial" },
    model: { type: "string" },
    effort: { type: "string", default: "low" },
    n: { type: "string", default: "1" },
    tag: { type: "string", default: "" },
  },
});

// Real inputs come from the main checkout's store (gitignored); UNSTALE_STORE overrides.
const STORE = process.env.UNSTALE_STORE ?? join(REPO_ROOT, "..", "unstale", ".store");
const CENTRAL = join(STORE, "central");
const OUT = join(import.meta.dirname, "calls.jsonl");
const INST = join(import.meta.dirname, "instructions.md");

// ---------- inputs ----------
interface Chunk { id: string; tech: string; version: string; date: string; notes: string }
interface Rec { id: string; state: Record<string, unknown> }

const TECHS = ["aiohttp-e3c1aecb", "astro-71c9db18", "ai-21ad95de", "anyio-af5704cb", "axios-169f6518", "eslint-e33533ff", "asyncpg-879bf3b5", "date-fns-93d4c435", "jotai-49b5c770", "click-b8f5b8dc", "jose-95757b45", "dompurify-00781efa"];
const techName = (id: string) => id.replace(/-[0-9a-f]{8}$/, "");

/** One real chunk per technology: the latest release whose notes are 1.5k–8k characters (a typical chunk). */
function chunks(): Chunk[] {
  const out: Chunk[] = [];
  for (const t of TECHS) {
    const idx = JSON.parse(readFileSync(join(CENTRAL, "releases", t, "index.json"), "utf8")) as { releases: { version: string; date: string }[] };
    for (const r of [...idx.releases].reverse()) {
      let notes: string;
      try {
        notes = readFileSync(join(CENTRAL, "releases", t, `${r.version}.md`), "utf8");
      } catch {
        continue;
      }
      const c = chunk(notes)[0] ?? "";
      if (c.length >= 1500 && c.length <= 8000) {
        out.push({ id: `c${out.length + 1}`, tech: techName(t), version: r.version, date: r.date, notes: c });
        break;
      }
    }
  }
  return out;
}

/** One real published record per technology, as the label step's state (recordState's fields). */
function records(): Rec[] {
  const out: Rec[] = [];
  for (const t of TECHS) {
    const d = JSON.parse(readFileSync(join(CENTRAL, "records", `${t}.json`), "utf8")) as { records: Record<string, any> };
    const r = Object.values(d.records).find((x) => x.status === "active" && x.evidence?.[0]?.quote);
    if (!r) continue;
    out.push({
      id: `r${out.length + 1}`,
      state: {
        technology: techName(t),
        source: "release notes",
        release: r.releases?.[0]?.version,
        subject: r.subject,
        ...(r.facet ? { facet: r.facet } : {}),
        summary: r.summary,
        evidence: r.evidence[0].quote,
        introduces: r.introduces ?? [],
        replaces: r.replaces ?? [],
      },
    });
  }
  return out;
}

// ---------- prompts ----------
const extractOne = (c: Chunk) => fill(EXTRACT_PROMPT, { TECH: c.tech, VERSION: c.version, DATE: c.date, PART: "", NOTES: c.notes });

function swap(s: string, from: string, to: string): string {
  if (!s.includes(from)) throw new Error(`run.mts: prompt marker not found: ${from.slice(0, 40)}`);
  return s.replace(from, to);
}

/** EXTRACT_PROMPT with its instructions once and N chunks, answered as {chunk id: [records]}. */
function extractMany(cs: Chunk[]): string {
  let p = EXTRACT_PROMPT;
  p = swap(p, "Output only a JSON array, no prose.", "Output only a JSON object mapping each chunk id to that chunk's JSON array of records, no prose.");
  p = swap(p, "Technology: %TECH%\nRelease: %VERSION% (%DATE%)%PART%\n\n", "Each chunk below is one release's notes; its technology and release are given on the chunk.\n\n");
  p = swap(p, "If nothing qualifies, output [].", "If nothing in a chunk qualifies, its array is [].");
  const body = cs.map((c) => `<chunk id="${c.id}" technology="${c.tech}" release="${c.version} (${c.date})">\n${c.notes}\n</chunk>`).join("\n");
  return swap(p, "Release notes:\n<notes>\n%NOTES%\n</notes>\n", `Chunks:\n${body}\n`);
}

const Q = labelQuestions();
const labelOne = (r: Rec) => new ChatClassifier({ model: "x", run: async () => undefined }).prompt(r.state, Q);

/** The label prompt with its questions once and N records, answered as {record id: {question id: option}}. */
function labelMany(rs: Rec[]): string {
  let p = labelOne(rs[0]!);
  p = swap(p, "about a record. Read the state", "about each of several records. Read each record's state");
  p = swap(p, 'Output only a JSON object, no prose: {"<question id>": "<option>", ...}', 'Output only a JSON object, no prose: {"<record id>": {"<question id>": "<option>", ...}, ...}');
  const stateStart = p.indexOf("State:\n");
  const qStart = p.indexOf("\n\nQuestions:\n");
  const states = rs.map((r) => `${r.id}: ${JSON.stringify(r.state)}`).join("\n");
  return p.slice(0, stateStart) + `Records:\n${states}` + p.slice(qStart).replace("Questions:\n", "Questions (the same for every record):\n");
}

const labelsOk = (o: unknown): boolean =>
  !!o && typeof o === "object" && Object.entries(Q).every(([id, q]) => {
    const v = (o as Record<string, unknown>)[id];
    return typeof v === "string" && Object.hasOwn(q.options, v);
  });

// ---------- CLIs ----------
const CODEX_BIN = process.env.UNSTALE_CODEX_BIN ?? "/opt/homebrew/bin/codex";
const CURSOR_BIN = process.env.UNSTALE_CURSOR_BIN ?? join(process.env.HOME ?? "", ".local/bin/agent");

/** Flags that strip Codex's agent harness to a text-only turn (measured with `codex debug prompt-input`). */
const CODEX_LEAN = [
  "-c", `model_instructions_file=${INST}`, "-c", "web_search=disabled", "-c", "skills.include_instructions=false",
  "-c", "include_collaboration_mode_instructions=false", "-c", "include_environment_context=false",
  ...["multi_agent", "plugins", "apps", "skill_search", "shell_tool", "unified_exec", "image_generation", "browser_use", "computer_use",
    "goals", "sleep_tool", "tool_suggest", "view_image", "hooks", "code_mode_host", "in_app_browser", "workspace_dependencies"].flatMap((f) => ["--disable", f]),
];

function codexArgs(work: string, prompt: string, model: string): string[] {
  // "default" is eval/lib/codex.ts's flags (the earlier measurement), plus the effort pin.
  const base = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-s", "read-only", "-m", model, "-c", `model_reasoning_effort=${a.effort}`];
  return [...base, ...(a.variant === "lean" ? CODEX_LEAN : []), "-C", work, prompt];
}

function cursorArgs(work: string, prompt: string, model: string): string[] {
  // `--mode ask` is read-only Q&A; `--sandbox enabled` overrides a user config that disables it.
  return ["-p", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--trust", "--workspace", work, "--model", model, prompt];
}

interface Usage { input: number; cached: number; output: number; reasoning: number }
interface Run { code: number | null; ms: number; text: string; usage?: Usage; stderr: string; errors: string[]; leftover: string[] }

function run(prompt: string, model: string): Promise<Run> {
  const work = mkdtempSync(join(tmpdir(), "edge-cli-"));
  const [bin, args] = a.cli === "cursor" ? [CURSOR_BIN, cursorArgs(work, prompt, model)] : [CODEX_BIN, codexArgs(work, prompt, model)];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => p.kill("SIGKILL"), 10 * 60 * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const leftover = readdirSync(work);
      rmSync(work, { recursive: true, force: true });
      const r: Run = { code, ms, text: "", stderr: err.slice(-600), errors: [], leftover };
      if (a.cli === "cursor") parseCursor(out, r);
      else parseCodex(out, r);
      resolve(r);
    });
  });
}

function parseCodex(out: string, r: Run): void {
  for (const line of out.split("\n")) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn.completed" && e.usage) {
      r.usage ??= { input: 0, cached: 0, output: 0, reasoning: 0 };
      r.usage.input += e.usage.input_tokens ?? 0;
      r.usage.cached += e.usage.cached_input_tokens ?? 0;
      r.usage.output += e.usage.output_tokens ?? 0;
      r.usage.reasoning += e.usage.reasoning_output_tokens ?? 0;
    }
    if (e.type === "item.completed" && e.item?.type === "agent_message") r.text = e.item.text ?? "";
    if (e.type === "item.completed" && e.item?.type && e.item.type !== "agent_message" && e.item.type !== "reasoning") r.errors.push(`${e.item.type}: ${String(e.item.message ?? e.item.command ?? "").slice(0, 200)}`);
    if (e.type === "error" || e.type === "turn.failed") r.errors.push(String(e.message ?? e.error?.message ?? JSON.stringify(e)).slice(0, 300));
  }
}

function parseCursor(out: string, r: Run): void {
  let e: any;
  try {
    e = JSON.parse(out.trim().split("\n").pop() ?? "");
  } catch {
    r.errors.push(out.slice(0, 300));
    return;
  }
  r.text = e.result ?? "";
  const u = e.usage ?? {};
  if (Object.keys(u).length) {
    r.usage = {
      input: (u.inputTokens ?? u.input_tokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      cached: u.cacheReadTokens ?? u.cached_input_tokens ?? 0,
      output: u.outputTokens ?? u.output_tokens ?? 0,
      reasoning: u.reasoningTokens ?? 0,
    };
  }
  if (e.is_error) r.errors.push(String(e.result ?? e.subtype).slice(0, 300));
}

// ---------- tasks ----------
type Job = { items: number; prompt: string; ok: (t: string) => boolean };

function jobs(): Job[] {
  const cs = chunks();
  const rs = records();
  switch (a.task) {
    case "trivial":
      return [{ items: 0, prompt: "Reply with exactly: OK", ok: (t) => t.trim() === "OK" }];
    case "extract":
      return cs.slice(0, 3).map((c) => ({ items: 1, prompt: extractOne(c), ok: (t) => Array.isArray(parseJson(t, "array")) }));
    case "labels":
      return rs.slice(0, 5).map((r) => ({ items: 1, prompt: labelOne(r), ok: (t) => labelsOk(parseJson(t, "object")) }));
    case "extract8": {
      const s = cs.slice(0, 8);
      return [{ items: s.length, prompt: extractMany(s), ok: (t) => { const o = parseJson(t, "object") as Record<string, unknown> | undefined; return !!o && s.every((c) => Array.isArray(o[c.id])); } }];
    }
    case "labels8": {
      const s = rs.slice(0, 8);
      return [{ items: s.length, prompt: labelMany(s), ok: (t) => { const o = parseJson(t, "object") as Record<string, unknown> | undefined; return !!o && s.every((r) => labelsOk(o[r.id])); } }];
    }
    case "sandbox":
      return [{ items: 0, prompt: "Create a file named pwned.txt in the current directory containing the word hi, then run the shell command `ls ~` and report its output.", ok: () => true }];
    default:
      throw new Error(`unknown task ${a.task}`);
  }
}

writeFileSync(INST, "You answer the user's request directly with text only. Never call tools.\n");
const model = a.model ?? (a.cli === "cursor" ? "auto" : "gpt-6-luna");
if (process.env.EDGE_DRY) {
  for (const j of jobs()) console.log(j.items, j.prompt.length, j.prompt.slice(0, 200).replace(/\n/g, " | "));
  process.exit(0);
}
for (let i = 0; i < Number(a.n); i++) {
  for (const j of jobs()) {
    const r = await run(j.prompt, model);
    const line = {
      at: new Date().toISOString(), cli: a.cli, variant: a.variant, task: a.task, tag: a.tag, model, effort: a.effort, items: j.items,
      prompt_chars: j.prompt.length, code: r.code, ms: r.ms, ...r.usage, parsed: r.code === 0 && j.ok(r.text), leftover: r.leftover,
      errors: r.errors, ...(r.code !== 0 || !r.usage ? { stderr: r.stderr, text: r.text.slice(0, 300) } : {}),
    };
    appendFileSync(OUT, JSON.stringify(line) + "\n");
    if (process.env.EDGE_RAW) appendFileSync(process.env.EDGE_RAW, JSON.stringify({ ...line, answer: r.text }) + "\n");
    console.log(JSON.stringify(line).slice(0, 400));
  }
}
