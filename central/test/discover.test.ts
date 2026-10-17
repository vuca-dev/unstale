import { afterEach, describe, expect, test } from "vitest";
import { coverage, discoverMany, discoverMarkdownCopy, hostChromeWords, suffixCandidates, watchFor } from "../src/collector/discover.ts";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { env, page, type TestEnv } from "./helpers.ts";

let e: TestEnv | undefined;
afterEach(async () => {
  await e?.close();
  e = undefined;
});
const client = () => new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10 });
const DOC = "<h1>Prompt caching</h1><p>Cache prefixes to reduce latency and cost for repeated context windows.</p>";
const COPY = "# Prompt caching\n\nCache prefixes to reduce latency and cost for repeated context windows.\n";
const md = (body: string) => (_q: unknown, res: import("node:http").ServerResponse) => void res.writeHead(200, { "content-type": "text/markdown" }).end(body);
const html = (body: string, headers: Record<string, string> = {}) => (_q: unknown, res: import("node:http").ServerResponse) =>
  void res.writeHead(200, { "content-type": "text/html", ...headers }).end(body);

describe("candidates and scoring", () => {
  test("suffix conventions", () => {
    expect(suffixCandidates("https://d.x/a/b/")).toEqual(["https://d.x/a/b.md", "https://d.x/a/b/index.md", "https://d.x/a/b/index.html.md"]);
    expect(suffixCandidates("https://d.x/api/fs.html?x=1#y")).toEqual(["https://d.x/api/fs.md", "https://d.x/api/fs.html.md"]);
    expect(suffixCandidates("https://d.x/docs/fetch")).toEqual(["https://d.x/docs/fetch.md", "https://d.x/docs/fetch/index.md"]);
  });

  test("coverage ignores link targets, front matter and host chrome", () => {
    expect(coverage("Use the signal option", "---\ntitle: x\n---\nUse the [signal](https://x/signal) option")).toBe(1);
    expect(coverage("Sidebar Guides Reference Use the signal option", "Use the signal option", new Set(["sidebar", "guides", "reference"]))).toBe(1);
    expect(coverage("Sidebar Guides Reference Use the signal option", "Use the signal option")).toBeLessThan(0.7);
  });

  test("host chrome words need at least three pages", () => {
    expect(hostChromeWords(["menu alpha", "menu beta"]).size).toBe(0);
    expect([...hostChromeWords(["menu alpha", "menu beta", "menu gamma"])]).toEqual(["menu"]);
  });
});

describe("discovery against a server", () => {
  test("<link rel=alternate type=text/markdown> wins, resolved relative to the page", async () => {
    e = await env();
    e.route("/docs/caching", html(page(DOC).replace("<head>", '<head><link rel="alternate" type="text/markdown" href="/md/caching.md">')));
    e.route("/md/caching.md", md(COPY));
    const d = await discoverMarkdownCopy(client(), `${e.base}/docs/caching`);
    expect(d.copy).toMatchObject({ method: "link", url: `${e.base}/md/caching.md`, coverage: 1 });
  });

  test("Link header is used when present", async () => {
    e = await env();
    e.route("/p", html(page(DOC), { link: '</p.txt>; rel="alternate"; type="text/markdown"' }));
    e.route("/p.txt", md(COPY));
    expect((await discoverMarkdownCopy(client(), `${e.base}/p`)).copy?.method).toBe("header");
  });

  test("an HTML soft 404 at the suffix is skipped; Accept negotiation is found", async () => {
    e = await env();
    e.route("/p.md", html(page("<p>Page not found</p>")));
    e.route("/p", (req, res) =>
      req.headers.accept?.startsWith("text/markdown") ? md(COPY)(req, res) : html(page(DOC))(req, res),
    );
    const d = await discoverMarkdownCopy(client(), `${e.base}/p`);
    expect(d.candidates.find((c) => c.url.endsWith("/p.md"))?.reason).toMatch(/not Markdown/);
    expect(d.copy).toMatchObject({ method: "accept", negotiated: true });
    expect(watchFor(d, "w")).toMatchObject({ format: "markdown", headers: { accept: "text/markdown" } });
  });

  test("a copy missing generated content is rejected and the watch falls back to HTML", async () => {
    e = await env();
    const listing = Array.from({ length: 30 }, (_, i) => `<li>childpage${i} description${i}</li>`).join("");
    e.route("/index", html(page(`<h1>Functions</h1><ul>${listing}</ul>`)));
    e.route("/index.md", md("# Functions\n"));
    const d = await discoverMarkdownCopy(client(), `${e.base}/index`);
    expect(d.copy).toBeUndefined();
    expect(d.candidates[0]?.reason).toMatch(/coverage/);
    expect(watchFor(d, "w", { selector: "main" })).toMatchObject({ format: "html", selector: "main" });
  });

  test("discoverMany discounts unmarked sidebar words shared by a host's pages", async () => {
    e = await env();
    const sidebar = '<div class="sidebar">Overview Installation Quickstart Queries Mutations Caching Pagination Infinite Devtools Testing Plugins</div>';
    for (const p of ["a", "b", "c"]) {
      e.route(`/${p}`, html(page(`${sidebar}<h1>Page ${p}</h1><p>Specific text for ${p}page alone.</p>`)));
      e.route(`/${p}.md`, md(`# Page ${p}\n\nSpecific text for ${p}page alone.\n`));
    }
    const single = await discoverMarkdownCopy(client(), `${e.base}/a`);
    expect(single.copy).toBeUndefined();
    const many = await discoverMany(client(), ["a", "b", "c"].map((p) => `${e!.base}/${p}`));
    expect(many.every((d) => "copy" in d && d.copy?.method === "suffix")).toBe(true);
  });
});
