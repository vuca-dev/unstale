import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { env, page, versioned, type TestEnv } from "./helpers.ts";

let e: TestEnv;
beforeEach(async () => {
  e = await env();
});
afterEach(async () => {
  await e.close();
});

describe("change lifecycle", () => {
  test("first_seen, not_modified, changed, unchanged after cosmetic edit", async () => {
    const v = versioned("text/html; charset=utf-8", page("<h1>Fetch</h1><p>Returns a promise.</p>"));
    e.route("/p", v.handler);
    const spec = e.spec("/p");
    expect((await e.collector.check(spec)).outcome.status).toBe("first_seen");
    expect((await e.collector.check(spec)).outcome.status).toBe("not_modified");
    expect(e.requests.at(-1)?.headers["if-none-match"]).toBeTruthy();

    v.state.body = page("<h1>Fetch</h1><p>Returns a promise. Supports <code>signal</code>.</p>");
    const changed = (await e.collector.check(spec)).outcome;
    expect(changed.status).toBe("changed");
    if (changed.status === "changed") {
      expect(changed.diff.added.join("\n")).toContain("Supports `signal`.");
      expect(changed.diff.removed.join("\n")).toContain("Returns a promise.");
    }

    // Re-indented markup, a different script, and different chrome: same text.
    v.state.body = page("\n  <h1>Fetch</h1>\n\n  <p>Returns   a promise.\n Supports <code>signal</code>.</p>", "v99")
      .replace("var x=1", "var x=2");
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
  });

  test("raw-byte skip: identical body without validators is unchanged without reparsing", async () => {
    const v = versioned("text/html", page("<p>same</p>"));
    v.state.etag = false;
    e.route("/p", v.handler);
    const spec = e.spec("/p");
    await e.collector.check(spec);
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    expect(e.requests.at(-1)?.headers["if-none-match"]).toBeUndefined();
  });

  test("config change is a rebaseline, not a content change, and drops conditional headers", async () => {
    const v = versioned("text/html", page("<div id=a>one</div><div id=b>two</div>"));
    e.route("/p", v.handler);
    await e.collector.check(e.spec("/p", { id: "x" }));
    const r = await e.collector.check(e.spec("/p", { id: "x", selector: "#b" }));
    expect(r.outcome.status).toBe("rebaseline");
    expect(e.requests.at(-1)?.headers["if-none-match"]).toBeUndefined();
  });

  test("failure keeps the last good snapshot; recovery with same content is unchanged", async () => {
    let fail = false;
    const v = versioned("text/html", page("<p>stable</p>"));
    e.route("/p", (req, res) => (fail ? void res.writeHead(500).end("boom") : v.handler(req, res)));
    const spec = e.spec("/p");
    await e.collector.check(spec);
    fail = true;
    const f = await e.collector.check(spec);
    expect(f.outcome).toMatchObject({ status: "failed", failure: "http_status", httpStatus: 500 });
    expect((await e.store.getState(spec.id))?.consecutiveFailures).toBe(1);
    fail = false;
    v.state.etag = false; // force a full fetch
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    expect((await e.store.getState(spec.id))?.consecutiveFailures).toBe(0);
  });

  test("history is capped and identical snapshots share one blob", async () => {
    const v = versioned("text/markdown", "a\n");
    e.route("/m", v.handler);
    const spec = e.spec("/m", { format: "markdown" });
    for (let i = 0; i < 25; i++) {
      v.state.body = i % 2 ? "a\n" : "b\n";
      await e.collector.check(spec);
    }
    const st = await e.store.getState(spec.id);
    expect(st?.history.length).toBe(20);
    const dirs = await readdir(join(e.store.root, "blobs"));
    let blobs = 0;
    for (const d of dirs) blobs += (await readdir(join(e.store.root, "blobs", d))).length;
    expect(blobs).toBe(2);
  });

  test("a change back to an earlier snapshot is flagged as a revert (flapping)", async () => {
    const v = versioned("text/markdown", "a\n");
    e.route("/f", v.handler);
    const spec = e.spec("/f", { format: "markdown" });
    await e.collector.check(spec);
    v.state.body = "b\n";
    const first = (await e.collector.check(spec)).outcome;
    expect(first.status === "changed" && first.revertsTo).toBeFalsy();
    v.state.body = "a\n";
    const back = (await e.collector.check(spec)).outcome;
    expect(back.status === "changed" && back.revertsTo).toBeTruthy();
  });

  test("corrupt state file is quarantined and the watch rebaselines", async () => {
    e.route("/m", versioned("text/markdown", "x\n").handler);
    const spec = e.spec("/m", { format: "markdown", id: "c" });
    await e.collector.check(spec);
    await writeFile(join(e.store.root, "state", "c.json"), "{not json");
    expect((await e.collector.check(spec)).outcome.status).toBe("first_seen");
    expect((await readdir(join(e.store.root, "state"))).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  test("duplicate ids are rejected", async () => {
    await expect(e.collector.checkAll([e.spec("/a", { id: "d" }), e.spec("/b", { id: "d" })])).rejects.toThrow(/duplicate/);
  });
});

describe("format and extraction failures are never content changes", () => {
  test("Markdown watch receiving HTML (soft 404 or user-agent negotiation) is format_mismatch", async () => {
    let html = false;
    e.route("/doc.md", (_q, res) =>
      html ? void res.writeHead(200, { "content-type": "text/html" }).end(page("<p>Not found</p>")) : void res.writeHead(200, { "content-type": "text/markdown" }).end("# Doc\n"),
    );
    const spec = e.spec("/doc.md", { format: "markdown" });
    await e.collector.check(spec);
    html = true;
    expect((await e.collector.check(spec)).outcome).toMatchObject({ status: "failed", failure: "format_mismatch" });
  });

  test("Markdown served as text/plain is accepted", async () => {
    e.route("/r.md", (_q, res) => void res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("# Raw\n"));
    expect((await e.collector.check(e.spec("/r.md", { format: "markdown" }))).outcome.status).toBe("first_seen");
  });

  test("missing selector is selector_not_found", async () => {
    e.route("/p", versioned("text/html", page("<p>x</p>")).handler);
    expect((await e.collector.check(e.spec("/p", { selector: "#apicontent" }))).outcome).toMatchObject({ failure: "selector_not_found" });
  });

  test("empty content is empty_text", async () => {
    e.route("/p", versioned("text/html", page("   ")).handler);
    expect((await e.collector.check(e.spec("/p"))).outcome).toMatchObject({ failure: "empty_text" });
  });

  test("invalid JSON is parse", async () => {
    e.route("/j", (_q, res) => void res.writeHead(200, { "content-type": "application/json" }).end("{oops"));
    expect((await e.collector.check(e.spec("/j", { format: "json" }))).outcome).toMatchObject({ failure: "parse" });
  });
});

describe("structured formats", () => {
  test("JSON key order does not matter; values do", async () => {
    const v = versioned("application/json", '{"b":1,"a":{"y":2,"x":1}}');
    e.route("/j", v.handler);
    const spec = e.spec("/j", { format: "json" });
    await e.collector.check(spec);
    v.state.body = '{"a":{"x":1,"y":2},"b":1}';
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    v.state.body = '{"a":{"x":1,"y":3},"b":1}';
    expect((await e.collector.check(spec)).outcome.status).toBe("changed");
  });

  test("feed: a new item is a change; channel metadata is not", async () => {
    const feed = (items: string[], built: string) =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><lastBuildDate>${built}</lastBuildDate>${items
        .map((t) => `<item><title>${t}</title><link>https://e.x/${t}</link><guid>${t}</guid></item>`)
        .join("")}</channel></rss>`;
    const v = versioned("application/rss+xml", feed(["v1"], "Mon"));
    e.route("/f", v.handler);
    const spec = e.spec("/f", { format: "feed" });
    await e.collector.check(spec);
    v.state.body = feed(["v1"], "Tue");
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    v.state.body = feed(["v2", "v1"], "Wed");
    const r = (await e.collector.check(spec)).outcome;
    expect(r.status).toBe("changed");
    if (r.status === "changed") expect(r.diff.added).toContain("## v2");
  });

  test("Atom entries use link href", async () => {
    const v = versioned(
      "application/atom+xml",
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><entry><title>Release 2</title><link rel="alternate" href="https://e.x/r2"/><id>tag:r2</id><updated>2026-10-01T00:00:00Z</updated></entry></feed>`,
    );
    e.route("/a", v.handler);
    const spec = e.spec("/a", { format: "feed" });
    await e.collector.check(spec);
    const blob = await e.store.getBlob((await e.store.getState(spec.id))?.snapshot as string);
    expect(blob).toBe("## Release 2\nhttps://e.x/r2\ntag:r2\n2026-10-01T00:00:00Z\n");
  });

  test("sitemap: URL order and lastmod do not matter", async () => {
    const sm = (urls: string[], mod: string) =>
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc><lastmod>${mod}</lastmod></url>`).join("")}</urlset>`;
    const v = versioned("application/xml", sm(["https://e.x/a", "https://e.x/b"], "2026-01-01"));
    e.route("/s", v.handler);
    const spec = e.spec("/s", { format: "feed" });
    await e.collector.check(spec);
    v.state.body = sm(["https://e.x/b", "https://e.x/a"], "2026-10-14");
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    v.state.body = sm(["https://e.x/b", "https://e.x/a", "https://e.x/c"], "2026-10-14");
    expect((await e.collector.check(spec)).outcome.status).toBe("changed");
  });

  test("normalization rules: dropped lines never cause a change", async () => {
    const v = versioned("text/markdown", "# Limits\nLast updated Oct 12, 2026\n![](https://e.x/_astro/logo.te5VL_aD.svg)\nCPU: 10 ms\n");
    e.route("/l.md", v.handler);
    const spec = e.spec("/l.md", {
      format: "markdown",
      normalize: { dropLines: ["^Last updated ", "_astro/.*\\.[\\w-]{8}\\.svg"] },
    });
    await e.collector.check(spec);
    v.state.body = "# Limits\nLast updated Oct 14, 2026\n![](https://e.x/_astro/logo.Zz9xQ1aB.svg)\nCPU: 10 ms\n";
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
    v.state.body = "# Limits\nLast updated Oct 15, 2026\nCPU: 30 ms\n";
    expect((await e.collector.check(spec)).outcome.status).toBe("changed");
  });

  test("front matter can be dropped", async () => {
    const v = versioned("text/markdown", "---\nlastUpdated: 2026-08-18\n---\n# fetch\n");
    e.route("/f.md", v.handler);
    const spec = e.spec("/f.md", { format: "markdown", normalize: { dropFrontMatter: true } });
    await e.collector.check(spec);
    v.state.body = "---\nlastUpdated: 2026-10-14\n---\n# fetch\n";
    expect((await e.collector.check(spec)).outcome.status).toBe("unchanged");
  });
});

describe("encoding and transport", () => {
  test("gzip-encoded responses are decoded", async () => {
    e.route("/g", (_q, res) => void res.writeHead(200, { "content-type": "text/markdown", "content-encoding": "gzip" }).end(gzipSync("# zipped\n")));
    const spec = e.spec("/g", { format: "markdown" });
    await e.collector.check(spec);
    expect(await e.store.getBlob((await e.store.getState(spec.id))?.snapshot as string)).toBe("# zipped\n");
  });

  test("charset from <meta> when the header has none (windows-1252)", async () => {
    const body = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body><main><p>caf'), Buffer.from([0xe9, 0x20, 0x93, 0x71, 0x94]), Buffer.from("</p></main></body></html>")]);
    e.route("/w", (_q, res) => void res.writeHead(200, { "content-type": "text/html" }).end(body));
    const spec = e.spec("/w");
    await e.collector.check(spec);
    expect(await e.store.getBlob((await e.store.getState(spec.id))?.snapshot as string)).toBe("café “q”\n");
  });

  test("charset from Content-Type wins over <meta>", async () => {
    const body = Buffer.from('<html><head><meta charset="windows-1252"></head><body><main><p>naïve ✓</p></main></body></html>', "utf8");
    e.route("/u", (_q, res) => void res.writeHead(200, { "content-type": "text/html; charset=UTF-8" }).end(body));
    const spec = e.spec("/u");
    await e.collector.check(spec);
    expect(await e.store.getBlob((await e.store.getState(spec.id))?.snapshot as string)).toBe("naïve ✓\n");
  });

  test("format-specific Accept is pinned and watch headers override it", async () => {
    e.route("/m", (_q, res) => void res.writeHead(200, { "content-type": "text/markdown" }).end("x"));
    await e.collector.check(e.spec("/m", { format: "markdown" }));
    expect(e.requests.at(-1)?.headers.accept).toMatch(/^text\/markdown/);
    await e.collector.check(e.spec("/m", { format: "markdown", headers: { Accept: "text/plain" } }));
    expect(e.requests.at(-1)?.headers.accept).toBe("text/plain");
    expect(e.requests.at(-1)?.headers["user-agent"]).toMatch(/^unstale-collector/);
  });
});
