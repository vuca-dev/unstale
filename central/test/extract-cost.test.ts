// Calls extraction does not make: notes with nothing to extract (contentFree), and a truncated extract answer, which
// is split into pieces instead of being asked again. The model is a stubbed chat-completions endpoint; llm.ts is real.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { PREAMBLE_MARKED, renderChange } from "../src/docs/render.ts";
import { contentFree, extractRelease, MIN_SPLIT, releaseCached, splitChunk } from "../src/pipeline/extract.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";

const prev = { ...process.env };
// The default extraction modes (two calls, quoted evidence, no diet), whatever the environment sets.
const OWN = ["UNSTALE_CENTRAL_DIR", "AI_GATEWAY_API_KEY", "UNSTALE_EXTRACT_MODEL", "UNSTALE_EXTRACT_STRUCTURE", "UNSTALE_EXTRACT_EVIDENCE", "UNSTALE_EXTRACT_DIET"];
beforeAll(() => {
  for (const k of OWN) delete process.env[k];
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-extract-cost-"));
  process.env.AI_GATEWAY_API_KEY = "test-key";
  process.env.UNSTALE_EXTRACT_MODEL = "vercel:openai/gpt-6-luna";
});
afterAll(() => {
  for (const k of OWN) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});
afterEach(() => vi.unstubAllGlobals());

const reply = (content: string, finish = "stop") =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });

const rel = (version: string, notes: string) => ({ technology: "prisma", tag: version, version, date: "2026-01-01", url: `https://example.test/${version}`, snapshot: "sha256:0", notes });

describe("contentFree", () => {
  test("headings, links, compare and dependency-bump boilerplate only", () => {
    expect(contentFree("### Patch Changes\n\n- Updated dependencies [d5e7d82]\n  - @ai-sdk/provider-utils@4.0.59\n  - @ai-sdk/openai@3.0.130")).toBe(true);
    expect(contentFree("## [14.6.2](https://github.com/o/r/compare/v14.6.1...v14.6.2) (2026-08-03)\n")).toBe(true);
    expect(contentFree("*No significant changes*\n\n##### &nbsp;&nbsp;[View changes on GitHub](https://github.com/o/r/compare/v1...v2)")).toBe(true);
    expect(contentFree("**Full Changelog**: https://github.com/o/r/compare/v2.30.0...v2.30.1")).toBe(true);
    expect(contentFree("## Changelog\n\n")).toBe(true);
    expect(contentFree("### Patch Changes\n\n-   Updated dependencies \\[[`040d469`](https://example.test/c/040d469)]:\n    -   @assistant-ui/react@0.14.0\n")).toBe(true);
    expect(contentFree("### Patch Changes\n\n- Updated dependencies. ([#51138](https://example.test/51138))\n  - expo-font@58.0.7")).toBe(true);
  });
  test("any other text is content", () => {
    expect(contentFree("- Updated dependencies [abc]\n  - @x/y@1.0.0\n- Fix `parse` on empty input")).toBe(false);
    expect(contentFree("Please refer to [CHANGELOG.md](https://example.test) for details.")).toBe(false);
    expect(contentFree("Please see this [changelog](https://example.test/cve) for more information about this security patch.")).toBe(false);
    expect(contentFree("### Bug Fixes\n\n* fix CITGM [#1154](https://example.test/1154)")).toBe(false);
    expect(contentFree("## 2.0.0\n- 移除旧接口")).toBe(false);
    expect(contentFree("## Node.js 20 is now required\n\n**Full Changelog**: https://example.test/compare/v1...v2")).toBe(false);
    expect(contentFree("- Updated dependencies can now be configured per client")).toBe(false);
    expect(contentFree("* Updated dependencies, notably `tough-cookie`, which no longer prints a deprecation warning.")).toBe(false);
  });
  test("release boilerplate only: version bumps, section labels, credits, dependency moves (slice 8)", () => {
    expect(contentFree("# [3.981.0](https://github.com/o/r/compare/v3.980.0...v3.981.0) (2026-02-02)\n\n**Note:** Version bump only for package @x/y")).toBe(true);
    expect(contentFree("- chore(deps): bump webpack-sources to v3")).toBe(true);
    expect(contentFree("### Bug Fixes\n\n* **deps:** update dependency @x/y to v2.1.0 ([#12](https://example.test/12)) ([abc1234](https://example.test/c))")).toBe(true);
    expect(contentFree("## What's Changed\n* build(deps-dev): bump sass from 1.2.3 to 1.3.0 by @dependabot[bot] in https://example.test/pull/9\n\n**Full Changelog**: https://example.test/compare/v1...v2")).toBe(true);
    expect(contentFree("#### 🐛 Bug Fix\n\n#### Authors: 1\n\n- Jane Doe ([@jane](https://example.test/jane))")).toBe(true);
    expect(contentFree("### ❤️ Thank You\n\n- James Henry @JamesHenry")).toBe(true);
    expect(contentFree("## @x/core\n\n- Updated dependencies: `@x/util@1.2.0`\n\n<!-- generated -->")).toBe(true);
    expect(contentFree("Release v1.2.3")).toBe(true);
    expect(contentFree("### Patch Changes\n\nNo changes in this release.")).toBe(true);
  });
  test("pointers, chores, deps-scoped items with more to say, and credits outside a credits section are content", () => {
    expect(contentFree("Please see this [changelog](https://example.test/cve) for more information about this security patch.")).toBe(false);
    expect(contentFree("### Patch Changes\n\n-   f607a12: chore(google): drop support for Imagen models following API shutdown")).toBe(false);
    expect(contentFree("### Features\n\n* **deps:** update dependencies and require Node.js 22.19+ ([b867143](https://example.test/c))")).toBe(false);
    expect(contentFree("### Bug Fixes\n\n* **deps:** remove typescript peer dependencies ([#6180](https://example.test/6180))")).toBe(false);
    expect(contentFree("### Bug Fixes\n\n- bump minimum supported Node.js to 20")).toBe(false);
    expect(contentFree("**Note:** Version bump only for package @x/y\n\n### Breaking Changes\n\n- drop support for eslint v8")).toBe(false);
    expect(contentFree("```bash\nnpm i @x/y@4\n```")).toBe(false);
  });
  test("a content-free note makes no call and counts as cached", async () => {
    const f = vi.fn(async () => reply("[]"));
    vi.stubGlobal("fetch", f);
    const r = rel("7.0.1", "### Patch Changes\n\n- Updated dependencies [d5e7d82]\n  - @prisma/client@7.0.1");
    expect(releaseCached(TECHNOLOGIES.prisma!, r)).toBe(true);
    expect(await extractRelease(TECHNOLOGIES.prisma!, r)).toEqual({ incoming: [], failed: 0 });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("a truncated extract answer", () => {
  const line = (i: number) => `- Removed option \`opt${i}\` from the client configuration in favour of the new settings object`;
  const notes = "## Breaking changes\n" + Array.from({ length: 40 }, (_, i) => line(i)).join("\n");
  const record = (i: number) => ({ subject: `opt${i}`, summary: `opt${i} is removed.`, evidence: `Removed option \`opt${i}\``, change_type: "removal" });

  test("is not asked again: the chunk is extracted as pieces, records keep their order and keys", async () => {
    expect(notes.length).toBeGreaterThanOrEqual(MIN_SPLIT);
    const pieces = splitChunk(notes);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.join("\n")).toBe(notes);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const prompt = (JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }).messages[0]!.content;
      if (prompt.startsWith("You write search terms")) {
        const ids = [...prompt.matchAll(/"id": "(r\d+)"/g)].map((m) => m[1]!);
        return reply(JSON.stringify(Object.fromEntries(ids.map((id) => [id, { terms: [id] }]))));
      }
      asked.push(prompt);
      const body = prompt.slice(prompt.indexOf("<notes>"));
      if (body.includes("opt0`") && body.includes("opt39`")) return reply("[", "length");
      const seen = [...body.matchAll(/opt(\d+)`/g)].map((m) => Number(m[1]));
      return reply(JSON.stringify(seen.map(record)));
    });
    const r = rel("8.0.0", notes);
    expect(releaseCached(TECHNOLOGIES.prisma!, r)).toBe(false);
    const { incoming, failed } = await extractRelease(TECHNOLOGIES.prisma!, r);
    expect(failed).toBe(0);
    expect(asked).toHaveLength(1 + pieces.length);
    expect(asked.slice(1).every((p) => p.includes(`Piece `) && p.includes(` of ${pieces.length} of this text.`))).toBe(true);
    expect(incoming.map((x) => x.subject)).toEqual(Array.from({ length: 40 }, (_, i) => `opt${i}`));
    expect(incoming.map((x) => x.key)).toEqual(Array.from({ length: 40 }, (_, i) => `prisma@8.0.0#0.${i}`));
    expect(incoming.every((x) => x.grounded)).toBe(true);

    // A rerun is free: the truncated request is not sent again and every piece is cached.
    expect(releaseCached(TECHNOLOGIES.prisma!, r)).toBe(true);
    const again = await extractRelease(TECHNOLOGIES.prisma!, r);
    expect(asked).toHaveLength(1 + pieces.length);
    expect(again.incoming.map((x) => x.key)).toEqual(incoming.map((x) => x.key));
  });

  test("a chunk shorter than MIN_SPLIT is not split: one call, one failure, not asked again", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return reply("[", "length");
    });
    const r = rel("8.0.1", "## Fixes\n- Fixed `connect` timeouts");
    expect(await extractRelease(TECHNOLOGIES.prisma!, r)).toEqual({ incoming: [], failed: 1 });
    expect(calls).toBe(1);
    expect(releaseCached(TECHNOLOGIES.prisma!, r)).toBe(true);
    expect(await extractRelease(TECHNOLOGIES.prisma!, r)).toEqual({ incoming: [], failed: 1 });
    expect(calls).toBe(1);
  });
});

describe("a split docs change", () => {
  test("every piece keeps the instructions, the page and the section it starts in", () => {
    const hunks = Array.from({ length: 60 }, (_, i) => `+Option \`opt${i}\` is added to the configuration file.`).join("\n");
    const notes = renderChange("https://example.test/docs/config", "guide", [{ path: ["Config"], status: "changed", hunks } as never], { words: true });
    expect(notes.length).toBeGreaterThanOrEqual(MIN_SPLIT);
    const pieces = splitChunk(notes);
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces[0]).toBe(notes.slice(0, pieces[0]!.length));
    for (const p of pieces.slice(1)) {
      expect(p.startsWith(PREAMBLE_MARKED)).toBe(true);
      expect(p).toContain("Page: https://example.test/docs/config (guide)");
      expect(p).toContain("Section: Config (changed)");
      expect(p.length).toBeLessThan(notes.length);
    }
    const body = (p: string) => p.slice(p.indexOf("+Option"));
    expect(pieces.map(body).join("\n")).toBe(body(notes));
  });
});
