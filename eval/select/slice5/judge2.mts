// Judge 2 runner (PREREG.md, "Judge 2"): the slice 5 judge requests rewritten per arm, fewer candidates (K) and/or the
// identity rules stated once in the state instead of in every question, or one answer-by-id question. Answers are
// written keyed by the ORIGINAL request key, so score5.mts --judge2 scores them with the unchanged guards.
//
//   cd central && npx tsx ../eval/select/slice5/judge2.mts --arm F8|F4|O8|O4|O2|O1|I8|I4|M8|T8 --split smoke|dev|heldout
//     [--cand jev|clef|subq] [--dry-run] [--concurrency 4]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const SELECT = join(import.meta.dirname, "..");
const OUT5 = join(SELECT, "out", "slice5");
process.env.UNSTALE_CENTRAL_DIR = join(OUT5, "central");
const { PROVIDERS, baseUrlOf, dollars, loadPrices, logUsageLine, priceOf } = await import("../client.ts");
const { ClassifierCache, Jev, keyFromEnvFile } = await import("../../../central/src/pipeline/classify/adapter.ts");
const { pool, sha256 } = await import("../../../central/src/pipeline/util.ts");
const { spendByProvider } = await import("../budget.ts");
const { SubqClassifier } = await import("../subq.ts");
import type { Classification, Classifier, Questions } from "../../../central/src/pipeline/classify/adapter.ts";
import type { Usage } from "../client.ts";

const { values: a } = parseArgs({
  options: {
    arm: { type: "string" },
    split: { type: "string", default: "smoke" },
    cand: { type: "string", default: "jev" },
    "dry-run": { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
  },
});
const USAGE = join(OUT5, "judge2-usage.jsonl");
const JEV_CAP = 0.55;

export interface Req { key: string; set: string; state: Record<string, unknown>; questions: Questions; split: "dev" | "heldout" }

const PREFIX = /^Does the incoming record describe the same change as candidate c1\?\n/;
/** The request as the arm asks it. */
export function rewrite(r: Req, arm: string): { state: Record<string, unknown>; questions: Questions } {
  const form = arm[0]!;
  const K = Number(arm.slice(1));
  const st = r.state as { technology: string; incoming: unknown; candidates: Record<string, unknown> };
  const ids = Object.keys(r.questions).map((q) => q.replace("same_", "")).slice(0, K);
  if (form === "F") {
    if (K >= Object.keys(r.questions).length) return { state: r.state, questions: r.questions };
    return {
      state: { ...st, candidates: Object.fromEntries(ids.map((c) => [c, st.candidates[c]])) },
      questions: Object.fromEntries(ids.map((c) => [`same_${c}`, r.questions[`same_${c}`]!])),
    };
  }
  if (form === "M" || form === "T") return compressed(r, form, K);
  const first = r.questions.same_c1!.instructions;
  if (!PREFIX.test(first)) throw new Error(`${r.key}: unexpected question text`);
  const rules = first.replace(PREFIX, "");
  const state = { technology: st.technology, identity_rules: rules, incoming: st.incoming, candidates: Object.fromEntries(ids.map((c) => [c, st.candidates[c]])) };
  if (form === "O") {
    return {
      state,
      questions: Object.fromEntries(ids.map((c) => [`same_${c}`, {
        instructions: `Does the incoming record describe the same change as candidate ${c}? Apply the identity_rules in the state.`,
        options: { yes: `The same change as candidate ${c}.`, no: `A different change from candidate ${c}, or unsure.` },
      }])),
    };
  }
  if (form === "I") {
    return {
      state,
      questions: {
        same: {
          instructions: "Which candidate describes the same change as the incoming record? Apply the identity_rules in the state. Answer none when no candidate is the same change, or when unsure.",
          options: { ...Object.fromEntries(ids.map((c) => [c, `Candidate ${c} is the same change.`])), none: "No candidate is the same change, or unsure." },
        },
      },
    };
  }
  throw new Error(`unknown arm ${arm}`);
}

// "Judge rules compression" (PREREG.md): the rules stay inside every question, reworded shorter. M moderate, T tight.
const CROSS_LINE = "\nThe same change described in release notes and in an upgrade guide is the same change; the wording and the level of detail differ between the two kinds of source.";
export const RULES: Record<"M" | "T", { q: (c: string) => string; cross: string }> = {
  M: {
    q: (c) => `Is the incoming record the same change as candidate ${c}?
Same: the same thing changed in the same way. Ignore change_type labels and release lines (a backport is the same change).
Not the same, even if related: a specific function, option, flag or channel vs the broader feature; deprecating or removing an API vs adding its replacement; a rename vs adding the new name; two different options, or two separate fixes, of one API; a breaking vs a non-breaking change.
Unsure: answer no (a wrong match hides a change).`,
    cross: "\nRelease notes and an upgrade guide describe the same change in different words and detail.",
  },
  T: {
    q: (c) => `Same change as candidate ${c} (same thing, changed the same way; labels and release line don't matter)? No if one is narrower than the other (one function or option vs the feature), deprecation vs replacement, rename vs new name, different options or fixes of one API, or breaking vs non-breaking. Unsure: no.`,
    cross: " Notes and guides word the same change differently.",
  },
};
function compressed(r: Req, form: "M" | "T", K: number): { state: Record<string, unknown>; questions: Questions } {
  const ids = Object.keys(r.questions).map((q) => q.replace("same_", "")).slice(0, K);
  const first = r.questions.same_c1!.instructions;
  if (!PREFIX.test(first)) throw new Error(`${r.key}: unexpected question text`);
  const cross = first.endsWith(CROSS_LINE.slice(1));
  return {
    state: r.state,
    questions: Object.fromEntries(ids.map((c) => [`same_${c}`, { instructions: RULES[form].q(c) + (cross ? RULES[form].cross : ""), options: r.questions[`same_${c}`]!.options }])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arm = a.arm ?? "";
  const split = a.split as "smoke" | "dev" | "heldout";
  const cand = a.cand as "jev" | "clef" | "subq";
  const prices = loadPrices();
  const runId = ["j2", arm, split, ...(cand !== "jev" ? [cand] : [])].join("-");
  const all = JSON.parse(readFileSync(join(OUT5, "units.json"), "utf8")) as { reqs: Record<string, Req> };
  let reqs = Object.values(all.reqs).filter((r) => (split === "heldout" ? r.split === "heldout" : r.split === "dev"));
  if (split === "smoke") reqs = [...reqs].sort((x, y) => sha256(`slice5:${x.key}`).localeCompare(sha256(`slice5:${y.key}`))).slice(0, 5);

  const built = reqs.map((r) => ({ r, ...rewrite(r, arm) }));
  const tok = (s: string) => Math.ceil(s.length / 3.5);
  const planIn = built.reduce((s, b) => s + tok(JSON.stringify({ state: b.state, questions: b.questions })), 0);
  const worst = cand === "jev" ? (planIn * 0.042) / 1e6 : cand === "subq" ? (planIn * 0.05) / 1e6 : 0;
  console.log(`${runId}: ${reqs.length} requests, ~${planIn} input tokens (chars/3.5) ≈ $${worst.toFixed(4)} on ${cand === "subq" ? "SubQ Snap" : "Jev"}; ${(planIn / reqs.length).toFixed(0)} per request`);
  if (a["dry-run"]) process.exit(0);
  const spent = spendByProvider(USAGE).jev?.dollars ?? 0;
  if (cand === "jev" && spent + worst * 1.3 > JEV_CAP) throw new Error(`jev cap: spent $${spent.toFixed(4)}, this run ~$${worst.toFixed(4)}, cap $${JEV_CAP}`);

  const meter = { calls: 0, input: 0, output: 0, dollars: 0 };
  const cf = PROVIDERS.cloudflare!;
  const f: typeof fetch = async (url, init) => {
    let res: Response;
    if (cand === "clef") {
      const target = `${baseUrlOf(cf).replace(/\/ai\/v1$/, "")}/ai/run/@cf/cloudflare/clef-flash`;
      res = await fetch(target, { ...init, headers: { Authorization: `Bearer ${keyFromEnvFile(cf.keyFile, cf.keyVar)()}`, "Content-Type": "application/json" } });
      if (!res.ok) {
        console.error(`clef: HTTP ${res.status} ${(await res.clone().text()).slice(0, 300)}`);
        return res;
      }
      const j = (await res.json()) as { result?: unknown };
      res = new Response(JSON.stringify(j.result ?? j), { status: 200, headers: { "Content-Type": "application/json" } });
    } else res = await fetch(url, init);
    if (res.ok) {
      const j = (await res.clone().json().catch(() => undefined)) as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
      const u = { input_tokens: j?.usage?.input_tokens ?? 0, cached_input_tokens: 0, output_tokens: j?.usage?.output_tokens ?? 0, reasoning_tokens: null };
      const d = cand === "jev" ? dollars(priceOf(prices, "jev", "jev-latest"), u) : (u.input_tokens * 0.038) / 1e6;
      meter.calls++;
      meter.input += u.input_tokens;
      meter.output += u.output_tokens;
      meter.dollars += d ?? 0;
      logUsageLine(USAGE, { step: `judge2:${runId}`, provider: cand === "jev" ? "jev" : "cloudflare", model: cand === "jev" ? "jev-latest" : "clef-flash", ...u, dollars: d });
    }
    return res;
  };
  // SubQ Snap (eval/select/subq.ts) takes Jev's request and answer shape at its own endpoint, with its own meter.
  const onUsage = (u: Usage, d: number | null) => {
    meter.calls++;
    meter.input += u.input_tokens;
    meter.output += u.output_tokens;
    meter.dollars += d ?? 0;
    logUsageLine(USAGE, { step: `judge2:${runId}`, provider: "subq", model: "subq-snap-preview", ...u, dollars: d });
  };
  const cls: Classifier = cand === "subq" ? new SubqClassifier({ step: `judge2:${runId}`, onUsage }) : new Jev({ model: cand === "jev" ? "jev-latest" : "clef-flash", fetch: f, ...(cand === "clef" ? { apiKey: () => "unused" } : {}) });
  // F8 reproduces J1 from J1's own caches (dev: the fresh dev run; held-out: run 1).
  const cacheDir = arm === "F8" && cand === "jev" ? join(OUT5, "cache", split === "heldout" ? "jev-heldout-r1" : split === "dev" ? "jev-dev" : "jev-smoke", "cls") : join(OUT5, "cache", runId, "cls");
  const cache = new ClassifierCache(cacheDir);
  const answers: Record<string, Classification | null> = {};
  let hits = 0;
  let done = 0;
  await pool(built, Number(a.concurrency), async (b) => {
    const hit = cache.get(cls, b.state, b.questions);
    if (hit) hits++;
    try {
      const x = hit ?? (await cls.classify(b.state, b.questions));
      if (!hit) cache.put(cls, b.state, b.questions, x);
      answers[b.r.key] = x;
    } catch (e) {
      console.error(`${b.r.key}: ${e instanceof Error ? e.message : String(e)}`);
      answers[b.r.key] = null;
    }
    if (++done % 50 === 0) console.log(`  ${done}/${built.length}`);
  });
  const n = reqs.length;
  const answered = Object.values(answers).filter(Boolean).length;
  const meta = { runId, arm, cand, split, requests: n, answered, cache_hits: hits, ...meter, input_per_request: meter.input / Math.max(1, n - hits), dollars_per_request: meter.dollars / Math.max(1, n - hits), planned_input_per_request: planIn / n };
  const runDir = join(OUT5, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "answers.json"), JSON.stringify(answers, null, 1) + "\n");
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(JSON.stringify(meta));
}
