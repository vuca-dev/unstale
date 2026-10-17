// The website built from an exported catalog: one page per package, breaking changes first, thin pages kept out of
// search, upstream text escaped.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { build, compareVersions, prose, THIN_RECORDS, type CatalogRecord } from "../site/build.ts";

const rec = (id: string, version: string, r: Partial<CatalogRecord> = {}, component = "pkg:npm/next"): CatalogRecord => ({
  id,
  status: "active",
  summary: `${id} changed`,
  change_type: "fix",
  breaking: false,
  releases: [{ component, version, line: version.split(".")[0]! }],
  evidence: [{ kind: "release_notes", url: `https://example.com/${id}` }],
  ...r,
});

function tree(techs: Record<string, Record<string, CatalogRecord[]>>): string {
  const site = mkdtempSync(join(tmpdir(), "site-"));
  mkdirSync(join(site, "v1", "tech"), { recursive: true });
  for (const [tech, lines] of Object.entries(techs)) {
    const shards = Object.entries(lines).map(([line, records]) => {
      const path = `v1/shards/${tech}/${line}.jsonl.gz`;
      mkdirSync(join(site, "v1", "shards", tech), { recursive: true });
      writeFileSync(join(site, path), gzipSync(records.map((r) => JSON.stringify(r)).join("\n") + "\n"));
      return { path, line };
    });
    writeFileSync(join(site, "v1", "tech", `${tech}.json`), JSON.stringify({ technology: tech, checked: "2026-10-17T00:00:00Z", shards }));
  }
  return site;
}

test("a package page lists majors newest first, breaking changes before fixes, with sources", () => {
  const many = Array.from({ length: THIN_RECORDS }, (_, i) => rec(`fix-${i}`, `15.0.${i}`));
  const site = tree({
    next: {
      "15": many,
      "16": [rec("cache", "16.1.0", { change_type: "behavior_change", breaking: true }), rec("tidy", "16.2.0"), rec("gone", "16.0.0", { status: "retracted" })],
    },
  });
  expect(build(site, "2026-10-17T00:00:00Z")).toBe(1);
  const page = readFileSync(join(site, "npm", "next", "index.html"), "utf8");
  expect(page.indexOf("<h2>next 16</h2>")).toBeLessThan(page.indexOf("<h2>next 15</h2>"));
  const s16 = page.slice(page.indexOf("<h2>next 16</h2>"), page.indexOf("<h2>next 15</h2>"));
  expect(s16.indexOf("Breaking changes")).toBeLessThan(s16.indexOf("Fixes and other changes"));
  expect(s16).toContain('href="https://example.com/cache"');
  expect(page).not.toContain("gone changed");
  expect(page).not.toContain("noindex");
  expect(readFileSync(join(site, "sitemap.xml"), "utf8")).toContain("https://unstale.sh/npm/next/");
  expect(readFileSync(join(site, "index.html"), "utf8")).toContain('href="/npm/next/"');
});

test("thin pages are built but not indexed; scoped packages keep their scope; upstream text is escaped", () => {
  const site = tree({
    "ai-sdk-azure-cd7bcab0": { "2": [rec("x", "2.0.0", { summary: "Use `<Foo>` <script>alert(1)</script>" }, "pkg:npm/%40ai-sdk/azure")] },
  });
  build(site);
  const page = readFileSync(join(site, "npm", "@ai-sdk", "azure", "index.html"), "utf8");
  expect(page).toContain('<meta name="robots" content="noindex">');
  expect(page).toContain("<code>&lt;Foo&gt;</code>");
  expect(page).not.toContain("<script>alert");
  expect(readFileSync(join(site, "sitemap.xml"), "utf8")).not.toContain("azure");
});

test("helpers", () => {
  expect(["15.10.0", "15.9.1", "16.0.0", "15.9.0"].sort(compareVersions)).toEqual(["15.9.0", "15.9.1", "15.10.0", "16.0.0"]);
  expect(prose("a `b` & c")).toBe("a <code>b</code> &amp; c");
});
