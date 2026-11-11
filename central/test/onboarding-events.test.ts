// The coverage service publishes a new package's change events before any extraction: when a new package's first run
// reaches its first note's extraction, the release notes' events are already in the catalog and no model has been
// called. Every request is stubbed, so nothing can reach a model.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CoverageService } from "../src/onboarding/service.ts";
import { catalogDir } from "../src/pipeline/paths.ts";
import { EventLine, TechIndex } from "../src/schema/catalog.ts";

let dir: string;
const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-onboarding-events-"));
  process.env.UNSTALE_STORE = dir;
  vi.stubEnv("UNSTALE_NOTICE", join(dir, "no-notice.json"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a new package's change events are published by its first run, with no model call", async () => {
  const discovery = await import("../src/onboarding/discovery.ts");
  const fetching = await import("../src/pipeline/fetch.ts");
  const synthesis = await import("../src/onboarding/synthesis.ts");
  const docs = await import("../src/docs/extract.ts");
  const llm = await import("../src/pipeline/llm.ts");
  const t = {
    discovery_version: 1,
    purl: "pkg:npm/example",
    id: "example",
    name: "Example",
    latest: "1.2.0",
    repo: "example/example",
    tag: "^v(\\d+\\.\\d+\\.\\d+)$",
    components: ["pkg:npm/example"],
  };
  vi.spyOn(discovery, "discoverTechnology").mockResolvedValue(t);
  const body = (v: string) => `## Features\n- Adds \`example.option${v.replaceAll(".", "")}\`\n\n**Full Changelog**: https://github.com/example/example/compare/v1.0.0...v${v}`;
  vi.spyOn(fetching, "fetchReleases").mockResolvedValue({
    checked: "2026-11-10T00:00:00Z",
    stats: { requests: 1, newReleases: 2 },
    notes: ["1.1.0", "1.2.0"].map((version) => ({
      technology: t.id,
      tag: `v${version}`,
      version,
      date: "2026-11-01",
      url: `https://github.com/example/example/releases/tag/v${version}`,
      snapshot: `sha256:${version.replaceAll(".", "").repeat(22).slice(0, 64)}`,
      notes: body(version),
    })),
  });
  vi.spyOn(fetching, "fetchGuides").mockResolvedValue([]);
  vi.spyOn(docs, "dailyPass").mockResolvedValue(undefined);
  // Every model path: extraction and labelling (llm.ts), and the record pipeline behind them (synthesis.ts), which
  // here only takes note of what the catalog held when extraction was first reached.
  const model = vi.spyOn(llm, "extractLlm");
  let atFirstExtraction: { index: string | undefined; modelCalls: number; asked: string[] } | undefined;
  const synth = vi.spyOn(synthesis, "synthesize").mockImplementation(async () => {
    const file = join(catalogDir(), "v1", "tech", "example.json");
    atFirstExtraction ??= { index: existsSync(file) ? readFileSync(file, "utf8") : undefined, modelCalls: model.mock.calls.length, asked: [...asked] };
    return 0;
  });
  // Any request leaving the process, answered here (the advisories database with none).
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ vulns: [] }));
  });
  const service = new CoverageService(1, {
    admission: async () => ({ admit: true, why: "test" }),
  });
  try {
    service.submit(t.purl);
    await vi.waitFor(() => expect(synth).toHaveBeenCalled(), { timeout: 3000 });
    expect(atFirstExtraction!.index, "published before extraction").toBeDefined();
    const index = TechIndex.parse(JSON.parse(atFirstExtraction!.index!));
    expect(index.shards).toEqual([]);
    expect(index.events?.map((e) => [e.line, e.records])).toEqual([["1", 2]]);
    const events = gunzipSync(readFileSync(join(catalogDir(), index.events![0]!.path))).toString().trim().split("\n").map((l) => EventLine.parse(JSON.parse(l)));
    expect(events.map((e) => [e.id, e.name, e.kind, e.chunks.map((c) => c.id)])).toEqual([
      ["example@1.1.0", "Example", "release_notes", ["example@1.1.0#0"]],
      ["example@1.2.0", "Example", "release_notes", ["example@1.2.0#0"]],
    ]);
    expect(events[1]!.chunks[0]!.text).toBe(body("1.2.0"));
    expect(events.every((e) => e.freshness.first_seen && e.freshness.first_published && e.freshness.backfilled)).toBe(true);
    expect(atFirstExtraction!.modelCalls).toBe(0);
    expect(atFirstExtraction!.asked.filter((u) => /typesafe|openai|vercel\.sh|anthropic|cloudflare|completions/i.test(u))).toEqual([]);
    await vi.waitFor(() => expect(service.status(t.purl)?.state).toBe("monitoring"), { timeout: 3000 });
    expect(model).not.toHaveBeenCalled();
  } finally {
    service.stop();
  }
});
