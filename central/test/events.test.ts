// Change events (events.ts): chunks exactly as extraction reads them, ids and hashes stable across runs and across a
// no-op republish. The model is a stubbed chat-completions endpoint that records the prompts; llm.ts is real.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eventChunks, eventId, publishEvents, recordNotes } from "../src/pipeline/events.ts";
import { chunk, extractRelease, MAX_CHUNK, toIncoming } from "../src/pipeline/extract.ts";
import { EventLine } from "../src/schema/catalog.ts";

const OWN = ["UNSTALE_STORE", "UNSTALE_CENTRAL_DIR", "UNSTALE_CATALOG_DIR", "AI_GATEWAY_API_KEY", "UNSTALE_EXTRACT_MODEL", "UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"];
const prev: Record<string, string | undefined> = {};
let store: string;
beforeEach(() => {
  for (const k of OWN) (prev[k] = process.env[k]), delete process.env[k];
  store = mkdtempSync(join(tmpdir(), "unstale-events-"));
  process.env.UNSTALE_STORE = store;
});
afterEach(() => {
  for (const k of OWN) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  vi.unstubAllGlobals();
});

const T = { id: "next", name: "Next.js", components: ["pkg:npm/next"] };
/** Long notes: two chunks of changes, then credits (with a Full Changelog line, a third chunk that is content-free). */
const LONG = [
  "## Core Changes",
  ...Array.from({ length: 900 }, (_, i) => `- Adds option \`images.option${i}\` to next.config.js (#${70000 + i})`),
  "## Credits",
  ...Array.from({ length: 300 }, (_, i) => `- Thanks @user${i} for helping`),
].join("\n");
const note = (version: string, notes: string, over: Record<string, unknown> = {}) => ({
  technology: "next",
  tag: `v${version}`,
  version,
  date: "2026-10-01",
  url: `https://github.com/vercel/next.js/releases/tag/v${version}`,
  snapshot: `sha256:${"a".repeat(64)}`,
  notes,
  ...over,
});

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name)).toString("base64");
    }
  };
  walk(dir, "");
  return out;
}

describe("change event chunks", () => {
  test("are the chunks extraction sends to the model, one call each, none for a content-free chunk", async () => {
    const notes = `${LONG}\n\n**Full Changelog**: https://github.com/vercel/next.js/compare/v16.0.0...v16.1.0`;
    const chunks = eventChunks(eventId("next", { version: "16.1.0" }), notes);
    expect(chunks.map((c) => c.text)).toEqual(chunk(notes));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= MAX_CHUNK)).toBe(true);
    // The model is asked once per chunk with content; its prompt holds that chunk's text and no other chunk's.
    process.env.AI_GATEWAY_API_KEY = "test-key";
    process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
    const prompts: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      prompts.push((JSON.parse(init.body) as { messages: Array<{ content: string }> }).messages.map((m) => m.content).join("\n"));
      return new Response(JSON.stringify({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    await extractRelease({ ...T, repo: "vercel/next.js", tag: /^v(.*)$/, clean: (s) => s }, note("16.1.0", notes));
    const asked = chunks.filter((c) => !c.content_free);
    expect(prompts).toHaveLength(asked.length);
    for (const c of asked) expect(prompts.filter((p) => p.includes(c.text))).toHaveLength(1);
    // The last chunk is only credits and the Full Changelog line: marked, and never sent.
    expect(chunks.at(-1)).toMatchObject({ content_free: true });
    expect(prompts.some((p) => p.includes("**Full Changelog**"))).toBe(false);
  });

  test("ids are the prefix of the keys extraction gives the chunk's records; hashes are of the text", () => {
    const n = note("16.1.0", LONG, { keyTag: "+linked.0123abcd" });
    const chunks = eventChunks(eventId("next", n), n.notes);
    const t = { ...T, repo: "vercel/next.js", tag: /^v(.*)$/, clean: (s: string) => s };
    chunks.forEach((c, ci) => {
      expect(c.id).toBe(`next@16.1.0+linked.0123abcd#${ci}`);
      const key = toIncoming(t, n, ci, 0, { subject: "x", summary: "y" } as never, {}, c.text).key;
      expect(key.startsWith(`${c.id}.`)).toBe(true);
      expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(new Set(chunks.map((c) => c.sha256)).size).toBe(chunks.length);
  });

  test("are stable: the same note chunked twice, recorded twice and republished give the same ids, hashes and bytes", () => {
    const notes = [note("16.1.0", LONG), note("16.0.0", "## Breaking\n- Node.js 20 is required")];
    expect(eventChunks("next@16.1.0", LONG)).toEqual(eventChunks("next@16.1.0", LONG));
    recordNotes(T, "releases", notes, new Date("2026-10-01T18:00:00Z"));
    const state = files(join(store, "central", "events"));
    const a = mkdtempSync(join(tmpdir(), "unstale-events-out-"));
    const first = publishEvents("next", a, new Date("2026-10-01T18:05:00Z"));
    expect(first.written).toBe(1);
    const published = files(a);
    // The same notes read again later (another run), then republished later still: nothing changes.
    recordNotes(T, "releases", notes, new Date("2026-10-02T06:00:00Z"));
    const again = publishEvents("next", a, new Date("2026-10-02T06:05:00Z"));
    expect(again).toEqual({ ...first, written: 0 });
    expect(files(a)).toEqual(published);
    // The state is unchanged but for the publish stamp written the first time.
    expect(Object.fromEntries(Object.entries(files(join(store, "central", "events"))).filter(([k]) => k.endsWith("notes.json")))).toEqual(state);
    // Into a fresh directory: byte-identical shards.
    const b = mkdtempSync(join(tmpdir(), "unstale-events-out-"));
    publishEvents("next", b, new Date("2026-10-03T00:00:00Z"));
    expect(files(b)).toEqual(published);
    const lines = gunzipSync(readFileSync(join(a, first.refs[0]!.path))).toString().trim().split("\n").map((l) => EventLine.parse(JSON.parse(l)));
    expect(lines.map((l) => l.id)).toEqual(["next@16.0.0", "next@16.1.0"]);
    expect(lines[1]!.chunks.map((c) => c.id)).toEqual(chunk(LONG).map((_, i) => `next@16.1.0#${i}`));
  });
});
