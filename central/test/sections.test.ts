import { describe, expect, test } from "vitest";
import { allAdded, markWords, sectionDiff, sections } from "../src/collector/sections.ts";
import { env, versioned } from "./helpers.ts";

const doc = (...parts: string[]) => parts.join("\n") + "\n";

describe("sections", () => {
  test("heading paths nest by level; headings inside code fences are not headings", () => {
    const s = sections(doc("intro", "# A", "a", "## B", "```sh", "# not a heading", "```", "### C", "c", "## D", "d"));
    expect(s.map((x) => x.path)).toEqual([[], ["A"], ["A", "B"], ["A", "B", "C"], ["A", "D"]]);
    expect(s[2]!.lines).toContain("# not a heading");
  });
});

describe("sectionDiff", () => {
  test("a modified section carries its heading path, context and removed lines", () => {
    const before = doc("# Config", "## Options", "Set `strict`.", "Defaults to `true`.", "More.", "## Other", "x");
    const after = doc("# Config", "## Options", "Set `strict`.", "Defaults to `false`.", "More.", "## Other", "x");
    const [c, ...rest] = sectionDiff(before, after);
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ path: ["Config", "Options"], status: "modified", added: 1, removed: 1 });
    expect(c!.hunks).toContain("-Defaults to `true`.");
    expect(c!.hunks).toContain("+Defaults to `false`.");
    expect(c!.hunks).toContain(" Set `strict`.");
  });

  test("added and removed sections are reported whole", () => {
    const before = doc("# A", "a", "## Old API", "use old()");
    const after = doc("# A", "a", "## New API", "use brandNew()", "with options");
    const out = sectionDiff(before, after);
    expect(out.map((c) => [c.status, c.path.join(" > ")])).toEqual([["added", "A > New API"], ["removed", "A > Old API"]]);
    expect(out[1]!.hunks).toBe("-## Old API\n-use old()");
  });

  test("a renamed heading with the same content is a modification with from; children under it are no change", () => {
    const before = doc("# Guide", "## Setup", "step one", "step two", "### Detail", "deep");
    const after = doc("# Guide", "## Installation", "step one", "step two", "### Detail", "deep");
    const out = sectionDiff(before, after);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: ["Guide", "Installation"], from: ["Guide", "Setup"], status: "modified" });
    expect(out[0]!.hunks).toContain("-## Setup");
  });

  test("repeated headings are matched by occurrence", () => {
    const before = doc("## Example", "one", "## Example", "two");
    const after = doc("## Example", "one", "## Example", "TWO");
    const out = sectionDiff(before, after);
    expect(out).toHaveLength(1);
    expect(out[0]!.hunks).toContain("+TWO");
  });

  test("identical text gives no changes; a whole page is all added", () => {
    expect(sectionDiff(doc("# A", "a"), doc("# A", "a"))).toEqual([]);
    expect(allAdded(doc("intro", "# A", "a")).map((c) => c.status)).toEqual(["added", "added"]);
  });
});

test("the collector reports sections on a changed HTML page", async () => {
  const e = await env();
  try {
    const v = versioned("text/html", "<html><body><h1>Fetch</h1><h2>Options</h2><p>timeout: 10 s</p><h2>Other</h2><p>x</p></body></html>");
    e.route("/p", v.handler);
    const spec = e.spec("/p");
    await e.collector.check(spec);
    v.state.body = "<html><body><h1>Fetch</h1><h2>Options</h2><p>timeout: 30 s</p><h2>Other</h2><p>x</p></body></html>";
    const out = (await e.collector.check(spec)).outcome;
    expect(out.status).toBe("changed");
    if (out.status === "changed") {
      expect(out.sections?.map((s) => s.path)).toEqual([["Fetch", "Options"]]);
      expect(out.sections?.[0]?.hunks).toContain("-timeout: 10 s");
    }
  } finally {
    await e.close();
  }
});

describe("block context and word marks", () => {
  test("block context: a changed list item comes with its whole list and the line that leads into it", () => {
    const before = doc("# Upgrade", "", "Some intro.", "", "Remove these flags:", "", "- `--skip-generate`", "- `--skip-seed`", "", "Later text.", "", "More text.");
    const after = before.replace("- `--skip-seed`", "- `--skip-seed` (now an error)");
    const [b] = sectionDiff(before, after, "block");
    expect(b!.hunks).toContain(" Remove these flags:");
    expect(b!.hunks).toContain(" - `--skip-generate`");
    expect(b!.hunks).not.toContain("Later text.");
    expect(b!.hunks).not.toContain("Some intro.");
    const [l] = sectionDiff(before, after, 1);
    expect(l!.hunks).not.toContain("Remove these flags:");
  });

  test("block context: a change inside a code fence keeps the fence and its lead-in", () => {
    const before = doc("# Config", "", "Set it in next.config.js:", "", "```js", "module.exports = {", "  a: 1,", "}", "```", "", "Unrelated.");
    const [c] = sectionDiff(before, before.replace("a: 1", "a: 2"), "block");
    expect(c!.hunks.split("\n").filter((l) => l.startsWith(" ")).map((l) => l.slice(1))).toEqual(["Set it in next.config.js:", "```js", "module.exports = {", "}", "```"]);
  });

  test("word marks: one changed word in a paragraph is one marked line; mostly new text keeps - and +", () => {
    const para = "The timeout option defaults to 10 seconds and applies to every request the client sends to the server.";
    expect(markWords(`@@ -1 +1 @@\n-${para}\n+${para.replace("10", "30")}`)).toBe(`@@ -1 +1 @@\n~The timeout option defaults to [-10-]{+30+} seconds and applies to every request the client sends to the server.`);
    expect(markWords("-Old sentence about caching.\n+A completely different paragraph on routing now.")).toBe("-Old sentence about caching.\n+A completely different paragraph on routing now.");
    expect(markWords(" context\n+added only")).toBe(" context\n+added only");
    // Words in any script: a Cyrillic word changes as a word, not letter by letter; Han characters one at a time.
    expect(markWords("-Вы можете использовать ловушку useSWRConfig для конфигураций\n+Вы можете использовать хук useSWRConfig для конфигураций")).toBe("~Вы можете использовать [-ловушку-]{+хук+} useSWRConfig для конфигураций");
    expect(markWords("-使用默认数据的预渲染模式\n+使用默认数据的服务端渲染模式")).toBe("~使用默认数据的[-预-]{+服务端+}渲染模式");
  });
});
