import { describe, expect, test } from "vitest";
import { detectFormat, htmlToMarkdown } from "../src/collector/extract.ts";
import { normalize } from "../src/collector/normalize.ts";

const md = (html: string, selector?: string, remove: string[] = []) => htmlToMarkdown(html, selector, remove);

describe("HTML to Markdown", () => {
  test("headings, paragraphs, inline code; links keep text only", () => {
    expect(md('<main><h2>Options</h2><p>Use <a href="/x?v=1">the <code>signal</code></a> option.</p></main>')).toBe(
      "## Options\n\nUse the `signal` option.",
    );
  });

  test("pre blocks keep their whitespace", () => {
    expect(md("<main><pre><code>a\n  b\n\n\nc</code></pre></main>")).toBe("```\na\n  b\n\n\nc\n```");
  });

  test("nested lists keep their structure", () => {
    expect(md("<main><ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol><li>first</li><li>second</li></ol></main>")).toBe(
      "- one\n\n  - inner\n- two\n\n1. first\n2. second",
    );
  });

  test("tables become pipe rows; pipes in cells are escaped; nested tables stay separate", () => {
    expect(md("<main><table><tr><th>Plan</th><th>Price</th></tr><tr><td>Free</td><td>$0 | mo</td></tr></table></main>")).toBe(
      "| Plan | Price |\n| --- | --- |\n| Free | $0 \\| mo |",
    );
  });

  test("chrome is dropped without a selector; hidden, scripts and buttons always", () => {
    const html = `<body><nav>Nav</nav><header>Site</header><main><p>Body</p><p hidden>secret</p><button>Copy</button><script>x()</script></main><aside>Ad</aside><footer>Foot</footer></body>`;
    expect(md(html)).toBe("Body");
  });

  test("remove selectors apply before the content selector", () => {
    const html = `<div id=c><p>keep</p><div class="banner">v24.10 banner</div></div>`;
    expect(md(html, "#c", [".banner"])).toBe("keep");
  });

  test("multiple selector matches are joined in document order", () => {
    expect(md("<div class=s>a</div><p>x</p><div class=s>b</div>", ".s")).toBe("a\n\nb");
  });

  test("entities are decoded, non-breaking spaces collapse", () => {
    expect(md("<main><p>a&nbsp;&nbsp;b &amp; c &lt;T&gt;</p></main>")).toBe("a b & c <T>");
  });

  test("falls back to body without main or article", () => {
    expect(md("<html><body><p>plain</p></body></html>")).toBe("plain");
  });
});

describe("format detection", () => {
  test.each([
    ["text/html; charset=utf-8", "<p>", "html"],
    ["text/plain", "<!DOCTYPE html><html>", "html"],
    ["text/markdown", "# x", "markdown"],
    ["text/plain", "# x", "text"],
    ["application/json", "{}", "json"],
    ["application/atom+xml", "<feed>", "feed"],
    ["application/xml", '<?xml version="1.0"?><urlset>', "feed"],
    [null, '<?xml version="1.0"?>\n<!-- c --><rss version="2.0">', "feed"],
  ] as const)("%s → %s", (ct, body, want) => {
    expect(detectFormat(ct, body)).toBe(want);
  });
});

describe("normalize", () => {
  test("CRLF, trailing spaces, blank runs, BOM, NFC", () => {
    expect(normalize("﻿é  \r\n\r\n\r\nb\t\r\n\r\n", { dropLines: [], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: false })).toBe("é\n\nb\n");
  });

  test("replace and sort", () => {
    expect(normalize("b ?v=abc\na ?v=def\n", { dropLines: [], replace: [{ pattern: "\\?v=\\w+", with: "?v=*" }], dropFrontMatter: false, sortLines: true, canonicalMarkdown: false })).toBe(
      "a ?v=*\nb ?v=*\n",
    );
  });
});

describe("canonical Markdown", () => {
  const rules = { dropLines: [], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: true };
  test("renderer formatting changes collapse to one form", () => {
    const before = "* **Usage**: rows read\n+ Storage\n\n| Plan   | Price      |\n| ------ | :--------: |\n| Free   | 5 GB       |\n\nLimits apply to D1\\.\n";
    const after = "- **Usage**: rows read\n- Storage\n\n| Plan | Price |\n| --- | --- |\n| Free | 5 GB |\n\nLimits apply to D1.\n";
    expect(normalize(before, rules)).toBe(normalize(after, rules));
    expect(normalize("a\n\n\nb\n", rules)).toBe("a\nb\n");
  });

  test("content changes still differ; code fences and escaped table pipes are kept", () => {
    expect(normalize("| a | 5 GB |\n", rules)).not.toBe(normalize("| a | 10 GB |\n", rules));
    expect(normalize("```\n* not a list\n  x\\.y\n```\n", rules)).toBe("```\n* not a list\n  x\\.y\n```\n");
    expect(normalize("~~~json\n{}\n~~~\n", rules)).toBe(normalize("```\n{}\n```\n", rules));
    expect(normalize("| a \\| b | c |\n", rules)).toBe("| a \\| b | c |\n");
  });
});

describe("invisible characters", () => {
  test("variation selectors, zero-width and soft hyphens are removed", () => {
    const rules = { dropLines: [], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: false };
    expect(normalize("dash\u00ADboard ↗\uFE0E zero\u200Bwidth", rules)).toBe(normalize("dashboard ↗ zerowidth", rules));
  });
  test("empty edge cells in tables are ignored by canonical Markdown", () => {
    const rules = { dropLines: [], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: true };
    expect(normalize("| | Free | Paid |\n| Rows | 5 | 25 | |\n", rules)).toBe(normalize("| Free | Paid |\n| Rows | 5 | 25 |\n", rules));
  });
});

describe("empty fences", () => {
  test("a fence emptied by a drop rule disappears; real code blocks stay", () => {
    const rules = { dropLines: ['^\\{"@context"'], replace: [], dropFrontMatter: false, sortLines: false, canonicalMarkdown: false };
    expect(normalize('text\n```json\n{"@context":"https://schema.org"}\n```\n```json\n{"rows_read": 5}\n```\n', rules)).toBe('text\n```json\n{"rows_read": 5}\n```\n');
  });
});
