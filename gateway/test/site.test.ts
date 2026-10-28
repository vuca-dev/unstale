// The website built from an exported catalog: one page per package, breaking changes first, thin pages kept out of
// search, upstream text escaped.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { build, compareVersions, prose, THIN_RECORDS, type CatalogRecord, WORDMARK, wordmarkSvg } from "../site/build.ts";
import { page, prefersMarkdown, type Env } from "../src/index.ts";

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
  expect(page.indexOf(`id="v16"`)).toBeGreaterThan(0);
  expect(page.indexOf(`id="v16"`)).toBeLessThan(page.indexOf(`id="v15"`));
  const s16 = page.slice(page.indexOf(`id="v16"`), page.indexOf(`id="v15"`));
  expect(s16.indexOf("Breaking changes")).toBeLessThan(s16.indexOf("Fixes and other changes"));
  expect(s16).toContain('href="https://example.com/cache"');
  expect(page).not.toContain("gone changed");
  expect(page).not.toContain("noindex");
  expect(readFileSync(join(site, "sitemap.xml"), "utf8")).toContain("https://unstale.sh/npm/next/");
  const home = readFileSync(join(site, "index.html"), "utf8");
  expect(home).toContain('href="/npm/next/"');
  expect(home).toContain("npx @unstale/cli init");
  for (const page of [home, readFileSync(join(site, "index.md"), "utf8")]) {
    expect(page).toContain("No client telemetry.");
    expect(page).toContain("Daily aggregate coverage-request outcome counts");
    expect(page).not.toContain("No telemetry.");
  }
  expect(readFileSync(join(site, "npm", "next", "index.md"), "utf8")).toMatch(/^# What changed in next\n[\s\S]*## next 16[\s\S]*### Breaking changes\n\n- cache changed \(16\.1\.0\) — \[release notes\]\(https:\/\/example\.com\/cache\)/);
  expect(readFileSync(join(site, "llms.txt"), "utf8")).toContain("https://unstale.sh/npm/next/index.md");
  expect(readFileSync(join(site, "_headers"), "utf8")).toContain("Strict-Transport-Security");
  expect(JSON.parse(readFileSync(join(site, "stats.json"), "utf8"))).toEqual({ changes: `${THIN_RECORDS + 2}+`, packages: "1+" });
  expect(readFileSync(join(site, ".well-known", "security.txt"), "utf8")).toMatch(/^Contact: https:\/\/github\.com\/vuca-dev\/unstale\/security/);
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

test("catalog counters include active changes and distinct related package identities", () => {
  const shared = { releases: [
    { component: "pkg:npm/prisma", version: "7.0.0", line: "7" },
    { component: "pkg:npm/%40prisma/client", version: "7.0.0", line: "7" },
  ] };
  const site = tree({ prisma: { "7": [rec("a", "7.0.0", shared), rec("b", "7.0.0", shared), rec("retired", "7.0.0", { status: "retracted" })] } });
  build(site);
  const home = readFileSync(join(site, "index.html"), "utf8");
  expect(home).toContain('<dt>changes indexed</dt><dd>2+</dd>');
  expect(home).toContain('<dt>packages covered</dt><dd>2+</dd>');
  expect(readFileSync(join(site, "index.md"), "utf8")).toContain("2+ changes indexed · 2+ packages covered");
});

test("helpers", () => {
  expect(["15.10.0", "15.9.1", "16.0.0", "15.9.0"].sort(compareVersions)).toEqual(["15.9.0", "15.9.1", "15.10.0", "16.0.0"]);
  expect(prose("a `b` & c")).toBe("a <code>b</code> &amp; c");
});

test("Markdown is chosen only when a client ranks it above HTML", () => {
  expect(prefersMarkdown("text/markdown")).toBe(true);
  expect(prefersMarkdown("text/markdown, text/html;q=0.9")).toBe(true);
  expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(false);
  expect(prefersMarkdown("text/html, text/markdown;q=0.5")).toBe(false);
  expect(prefersMarkdown(null)).toBe(false);
});

test("pages: www and http go to the https apex; agents asking for Markdown get the index.md twin", async () => {
  const assets = new Map([["/npm/next/", "<html>next</html>"], ["/npm/next/index.md", "# What changed in next"]]);
  const env = {
    ASSETS: {
      fetch: async (input: Request | URL) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const body = assets.get(path);
        return body ? new Response(body) : new Response("not found", { status: 404 });
      },
    },
  } as unknown as Env;
  const get = (href: string, accept?: string) =>
    page(new Request(href, { headers: accept ? { Accept: accept } : {} }), env, new URL(href));

  const www = await get("https://www.unstale.sh/npm/next/?x=1");
  expect(www.status).toBe(301);
  expect(www.headers.get("Location")).toBe("https://unstale.sh/npm/next/?x=1");
  expect((await get("http://unstale.sh/")).headers.get("Location")).toBe("https://unstale.sh/");

  const md = await get("https://unstale.sh/npm/next/", "text/markdown");
  expect(md.headers.get("Content-Type")).toMatch(/^text\/markdown/);
  expect(await md.text()).toBe("# What changed in next");

  assets.set("/google0abc", "google-site-verification: google0abc.html");
  const google = await get("https://unstale.sh/google0abc.html");
  expect(google.status).toBe(200);
  expect(await google.text()).toBe("google-site-verification: google0abc.html");

  const html = await get("https://unstale.sh/npm/next/", "text/html,*/*;q=0.8");
  expect(await html.text()).toBe("<html>next</html>");
  expect(html.headers.get("Vary")).toContain("Accept");
});

test("website and README use the shared Menlo Bold outlines", () => {
  const svg = wordmarkSvg("mark");
  expect(WORDMARK.points.length).toBeGreaterThan(3000);
  for (const theme of ["dark", "light"]) {
    const readme = readFileSync(new URL(`../../docs/assets/wordmark-${theme}.svg`, import.meta.url), "utf8");
    for (const path of WORDMARK.paths) {
      expect(svg).toContain(`<path d="${path}"/>`);
      expect(readme).toContain(`<path d="${path}"/>`);
    }
    expect(readme).not.toContain("<text");
  }
});
