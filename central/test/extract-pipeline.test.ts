// Extraction helpers: chunking long release notes and locating evidence quotes.
import { describe, expect, test } from "vitest";
import { chunk, locate } from "../src/pipeline/extract.ts";
import { releaseLine } from "../src/pipeline/util.ts";

describe("extraction helpers", () => {
  test("short notes are one chunk; long notes split at headings within the limit, losing nothing", () => {
    expect(chunk("## A\n- one", 100)).toEqual(["## A\n- one"]);
    const notes = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n${"- change line\n".repeat(5)}`).join("\n");
    const parts = chunk(notes, 400);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(400);
    expect(parts.join("\n")).toBe(notes);
    expect(parts.slice(1).every((p) => p.startsWith("## Section"))).toBe(true);
  });

  test("a single line longer than the limit is cut", () => {
    const parts = chunk("x".repeat(250), 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
  });

  test("quotes are found after folding markup and whitespace, with their heading", () => {
    const notes = "# Release\n## Breaking changes\n- `new PrismaClient()` support has  been removed\n## Fixes\n- other";
    expect(locate(notes, "new PrismaClient() support has been removed")).toEqual({ grounded: true, section: "Breaking changes" });
    expect(locate(notes, "not in the notes")).toEqual({ grounded: false });
    expect(locate(notes, "")).toEqual({ grounded: false });
  });

  test("release line is the major, or major.minor below 1.0", () => {
    expect(releaseLine("16.3.2")).toBe("16");
    expect(releaseLine("0.17.0")).toBe("0.17");
  });
});

describe("release tags", () => {
  test("stable tags only; Prisma's major-0 (Prisma Next) tags are excluded", async () => {
    const { TECHNOLOGIES } = await import("../src/pipeline/technologies.ts");
    const ok = (t: string, tag: string) => TECHNOLOGIES[t]!.tag.exec(tag)?.[1];
    expect(ok("next", "v16.3.2")).toBe("16.3.2");
    expect(ok("next", "v16.4.0-canary.3")).toBeUndefined();
    expect(ok("prisma", "7.1.0")).toBe("7.1.0");
    expect(ok("prisma", "v0.17.0")).toBeUndefined();
    expect(ok("nestjs", "v11.1.7")).toBe("11.1.7");
  });
});

describe("upgrade guide impact ratings", () => {
  test("a guide's own rating for the quote's section is read (Laravel style); none when the guide gives none", async () => {
    const { impactOf } = await import("../src/pipeline/extract.ts");
    const guide = "# Upgrade\n### Updating Dependencies\n**Likelihood Of Impact: High**\n- update `laravel/framework`\n### Carbon 3\n**Likelihood Of Impact: Low**\n- text";
    expect(impactOf(guide, "Updating Dependencies")).toBe("high");
    expect(impactOf(guide, "Carbon 3")).toBe("low");
    expect(impactOf("## Node.js requirements\n- v20.19+", "Node.js requirements")).toBeUndefined();
    expect(impactOf(guide, undefined)).toBeUndefined();
  });
});
