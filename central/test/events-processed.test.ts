// Change events central has processed carry `extracted`, so a client never derives them again on its own tokens:
// marked only after the records are saved (so never published ahead of them), only while the event's text is what
// was processed, deterministically (a republish with nothing new changes no byte), and for work done before marks
// existed (a coverage job's finished notes and guides, the docs ledger) with no model call.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eventsChanged, markProcessed, markRecorded, recordNotes } from "../src/pipeline/events.ts";
import { catalogDir, centralDir } from "../src/pipeline/paths.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { loadStore } from "../src/pipeline/store.ts";
import { canonical, sha256 } from "../src/pipeline/util.ts";
import { EventLine, TechIndex } from "../src/schema/catalog.ts";

const T = { id: "next", name: "Next.js", components: ["pkg:npm/next"] };
const CHECKED = "2026-11-11T06:00:00Z";
const T0 = new Date("2026-11-01T00:00:00Z");
const note = (version: string, notes: string, extra: Record<string, string> = {}) => ({
  technology: "next",
  tag: `v${version}`,
  version,
  date: "2026-10-30",
  url: `https://github.com/vercel/next.js/releases/tag/v${version}`,
  snapshot: `sha256:${sha256(notes)}`,
  notes,
  ...extra,
});

const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-events-processed-"));
  vi.stubEnv("UNSTALE_NOTICE", join(process.env.UNSTALE_STORE, "no-notice.json"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const indexText = () => readFileSync(join(catalogDir(), "v1", "tech", "next.json"), "utf8");
const published = (): EventLine[] =>
  TechIndex.parse(JSON.parse(indexText())).events!.flatMap((r) =>
    gunzipSync(readFileSync(join(catalogDir(), r.path))).toString().trim().split("\n").map((l) => EventLine.parse(JSON.parse(l))),
  );
const marked = () => published().filter((e) => e.extracted).map((e) => e.id);

describe("processed change events", () => {
  test("only marked events carry it; a republish with nothing new changes no byte; a new mark is a publish", () => {
    const a = note("16.0.0", "## Breaking\n- Node.js 20 is required");
    const b = note("16.1.0", "- Adds `images.qualities`");
    recordNotes(T, "releases", [a, b], T0);
    publishTechnology(loadStore("next"), CHECKED, catalogDir(), undefined, T0);
    expect(marked()).toEqual([]);
    expect(eventsChanged("next")).toBe(false);
    expect(markProcessed(T, [a])).toBe(1);
    expect(markProcessed(T, [a]), "a mark already there").toBe(0);
    expect(eventsChanged("next"), "a new mark is due a publish").toBe(true);
    publishTechnology(loadStore("next"), CHECKED, catalogDir(), undefined, T0);
    expect(marked()).toEqual(["next@16.0.0"]);
    const before = indexText();
    expect(eventsChanged("next")).toBe(false);
    publishTechnology(loadStore("next"), CHECKED, catalogDir(), undefined, new Date("2026-11-05T00:00:00Z"));
    expect(indexText(), "no-op republish").toBe(before);
  });

  test("without any mark the digest is the one published before marks existed (no technology republished for them)", () => {
    recordNotes(T, "releases", [note("16.0.0", "- one")], T0);
    const events = JSON.parse(readFileSync(join(centralDir(), "events", "next", "notes.json"), "utf8")).events;
    const pub = join(centralDir(), "events", "next", "published.json");
    writeFileSync(pub, JSON.stringify({ schema: 1, technology: "next", first_published: {}, digest: sha256(canonical(events)) }));
    expect(eventsChanged("next")).toBe(false);
  });

  test("a mark holds only for the text that was processed: changed notes are the client's to derive again", () => {
    const a = note("16.0.0", "- first text");
    recordNotes(T, "releases", [a], T0);
    markProcessed(T, [a]);
    recordNotes(T, "releases", [{ ...a, notes: "- first text\n- and a fix added later", snapshot: "sha256:other" }], T0);
    publishTechnology(loadStore("next"), CHECKED, catalogDir(), undefined, T0);
    expect(marked()).toEqual([]);
  });

  test("work done before marks: a coverage job's finished notes and guides, and the docs ledger, by id", async () => {
    const { markFinished } = await import("../src/onboarding/service.ts");
    const done = note("16.0.0", "- done");
    const waiting = note("16.1.0", "- not read yet");
    recordNotes(T, "releases", [done, waiting], T0);
    recordNotes(T, "guides", [{ ...note("16.0.0", "# Upgrading to 16"), kind: "upgrade_guide", keyTag: "+guide.abcdef12" } as never], T0);
    recordNotes(T, "docs", [{ ...note("16.1.0", "docs change"), kind: "docs", keyTag: "+docs.0123abcd" } as never, { ...note("16.1.0", "other change"), kind: "docs", keyTag: "+docs.99999999" } as never], T0);
    const docs = join(centralDir(), "docs", "next");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "extracted.json"), JSON.stringify({ "0123abcd5678": "2026-10-20T00:00:00Z" }));
    const n = markFinished(T, { completed: [`v16.0.0:${done.snapshot}:audience-v1`, "v15.0.0:sha256:gone:audience-v1"], guides_done: ["+guide.abcdef12:audience-v1"] }, [done, waiting]);
    expect(n).toBe(3);
    publishTechnology(loadStore("next"), CHECKED, catalogDir(), undefined, T0);
    expect(marked().sort()).toEqual(["next@16.0.0", "next@16.0.0+guide.abcdef12", "next@16.1.0+docs.0123abcd"]);
    expect(markRecorded("next", () => false)).toBe(0);
  });

  test("a coverage note is marked after its records are saved and before the publish, only when every call succeeded", async () => {
    const extract = await import("../src/pipeline/extract.ts");
    const events = await import("../src/pipeline/events.ts");
    const stores = await import("../src/pipeline/store.ts");
    const publish = await import("../src/pipeline/publish.ts");
    const prereqs = await import("../src/pipeline/prereqs.ts");
    const { synthesize } = await import("../src/onboarding/synthesis.ts");
    const tech = { ...T, repo: "vercel/next.js", tag: "^v(.*)$" } as never;
    const rel = note("16.2.0", "## Fixes\n- Internal refactor");
    recordNotes(T, "releases", [rel], T0);
    vi.spyOn(prereqs, "checkIncoming").mockResolvedValue(0);
    const mark = vi.spyOn(events, "markProcessed");
    const save = vi.spyOn(stores, "saveStore");
    const pub = vi.spyOn(publish, "publishTechnology");
    // A failed call: nothing is marked; the note is planned again.
    vi.spyOn(extract, "extractRelease").mockResolvedValueOnce({ incoming: [], failed: 1 });
    await expect(synthesize(tech, rel)).rejects.toThrow(/failed calls/);
    expect(mark).not.toHaveBeenCalled();
    // A release with no change in it: processed, though no record will ever name it.
    vi.spyOn(extract, "extractRelease").mockResolvedValueOnce({ incoming: [], failed: 0 });
    await synthesize(tech, rel);
    expect(marked()).toEqual(["next@16.2.0"]);
    const order = (s: { mock: { invocationCallOrder: number[] } }) => s.mock.invocationCallOrder;
    expect(Math.max(...order(save))).toBeLessThan(order(mark)[0]!);
    expect(order(mark)[0]!).toBeLessThan(Math.max(...order(pub)));
  });
});
