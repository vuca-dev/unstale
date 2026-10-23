import { describe, expect, test } from "vitest";
import { linkRank, links, majorDocs, upgradeFileNames, wantedMajors, type MajorSource } from "../src/pipeline/majors.ts";
import type { Res } from "../src/docs/resolve.ts";

const versions = ["16.0.0", "16.14.0", "17.0.0", "17.0.2", "18.0.0", "18.3.1", "19.0.0", "19.2.0", "20.0.0-rc.1", "0.14.0"];

describe("wanted majors", () => {
  test("a major is wanted when enough of last week's downloads are below it", () => {
    // 0.5% on 16.x, 2.5% on 17.x, 22% on 18.x: 17 is not wanted (0.5% below it), 18 (3%) and 19 (25%) are.
    const counts = new Map([["16.14.0", 500], ["17.0.2", 2500], ["18.3.1", 22000], ["19.2.0", 75000], ["20.0.0-rc.1", 9000]]);
    expect(wantedMajors(versions, counts)).toEqual({ majors: [18, 19], basis: "adoption" });
  });
  test("nobody behind: nothing is wanted; no downloads to read: the current and previous major", () => {
    expect(wantedMajors(versions, new Map([["19.2.0", 1000]]))).toEqual({ majors: [], basis: "adoption" });
    expect(wantedMajors(versions, undefined)).toEqual({ majors: [18, 19], basis: "window" });
    // A 0.x line is no major; a technology with only 0.x releases wants none.
    expect(wantedMajors(["0.14.0", "0.15.0"], undefined)).toEqual({ majors: [], basis: "window" });
  });
});

describe("links of the x.0.0 notes", () => {
  test("Markdown and bare links, http read as https, fragments dropped", () => {
    expect(links("See the [guide](https://babeljs.io/docs/v8-migration#top). Read http://babeljs.io/blog/2026/06/16/8.0.0!")).toEqual([
      "https://babeljs.io/docs/v8-migration",
      "https://babeljs.io/blog/2026/06/16/8.0.0",
    ]);
  });
  test("a guide naming the major ranks over a page naming the release; dates, code hosts and other majors do not count", () => {
    expect(linkRank("https://babeljs.io/docs/v8-migration", 8)).toBe(2);
    expect(linkRank("https://react.dev/blog/2024/04/25/react-19-upgrade-guide", 19)).toBe(2);
    expect(linkRank("https://babeljs.io/blog/2026/06/16/8.0.0", 8)).toBe(1);
    expect(linkRank("https://docs.langchain.com/oss/javascript/releases/langchain-v1", 1)).toBe(1);
    expect(linkRank("https://react.dev/blog/2024/04/25/react-19", 19)).toBe(1);
    expect(linkRank("https://react.dev/blog/2024/04/25/react-19", 25)).toBe(0);
    expect(linkRank("https://github.com/babel/babel/pull/8", 8)).toBe(0);
    expect(linkRank("https://babeljs.io/docs/v7-migration", 8)).toBe(0);
    expect(linkRank("https://example.com/docs/options", 8)).toBe(0);
  });
  test("upgrade files by name at the root or in docs/", () => {
    const entries = [
      { path: "UPGRADING.md", type: "file" },
      { path: "MIGRATION-v5.md", type: "file" },
      { path: "README.md", type: "file" },
      { path: "docs/migrating-to-6.md", type: "file" },
      { path: "docs/api.md", type: "file" },
      { path: "src/migrate.md", type: "file" },
    ];
    expect(upgradeFileNames(entries)).toEqual(["UPGRADING.md", "MIGRATION-v5.md", "docs/migrating-to-6.md"]);
  });
});

/** A source whose pages are a map of URL → text (404 otherwise). */
function source(notes: Awaited<ReturnType<MajorSource["notes"]>>, pages: Record<string, string>, files: Array<[string, string]> = []): MajorSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    repo: "o/r",
    notes: async () => notes,
    upgradeFiles: async () => files,
    fetcher: {
      requests: 0,
      async get(url: string): Promise<Res> {
        asked.push(url);
        return url in pages ? { status: 200, url, text: pages[url]! } : { status: 404, url, text: "" };
      },
    },
  };
}

const long = (s: string) => `${s}\n\n${"Breaking change text. ".repeat(40)}`;

describe("a major's upgrade material", () => {
  test("short old notes with a list of changes are notes; a pointer body is not", async () => {
    const short = "### BREAKING CHANGES\n\n* deprecated options removed. See https://marked.js.org/using_advanced#options";
    expect((await majorDocs(8, source({ url: "https://github.com/o/r/releases/tag/v8.0.0", text: short, old: true }, {}), new Set())).map((d) => d.via)).toEqual(["release"]);
    const pointer = "Please refer to [CHANGELOG.md](https://github.com/x/y/blob/v7.0.0/CHANGELOG.md) for details.";
    expect(await majorDocs(7, source({ url: "https://github.com/o/r/releases/tag/v7.0.0", text: pointer, old: true }, {}), new Set())).toEqual([]);
  });
  test("the guide the x.0.0 notes link, by its Markdown copy first; old notes themselves too", async () => {
    const src = source(
      { url: "https://github.com/o/r/releases/tag/v19.0.0", text: long("See https://react.dev/blog/2024/04/25/react-19-upgrade-guide and https://github.com/o/r/pull/1"), old: true },
      { "https://react.dev/blog/2024/04/25/react-19-upgrade-guide.md": long("# React 19 Upgrade Guide") },
    );
    const docs = await majorDocs(19, src, new Set());
    expect(docs.map((d) => [d.via, d.url])).toEqual([
      ["linked", "https://react.dev/blog/2024/04/25/react-19-upgrade-guide"],
      ["release", "https://github.com/o/r/releases/tag/v19.0.0"],
    ]);
    expect(docs[0]!.text).toContain("# React 19 Upgrade Guide");
    expect(src.asked).toEqual(["https://react.dev/blog/2024/04/25/react-19-upgrade-guide.md"]);
  });
  test("notes in the window are release notes already: only their links are read; an HTML page without a copy is read as its article", async () => {
    const src = source(
      { url: "https://github.com/o/r/releases/tag/v8.0.0", text: "migration guide: https://babeljs.io/docs/v8-migration", old: false },
      { "https://babeljs.io/docs/v8-migration": `<html><body><article><h1>Upgrade to Babel 8</h1><p>${"Babel 8 removes options. ".repeat(40)}</p></article></body></html>` },
    );
    const docs = await majorDocs(8, src, new Set());
    expect(docs.map((d) => [d.via, d.url])).toEqual([["linked", "https://babeljs.io/docs/v8-migration"]]);
    expect(docs[0]!.text).toContain("Upgrade to Babel 8");
  });
  test("a document already ingested is not read again; with nothing found, the repository's upgrade file's section", async () => {
    const seen = new Set(["https://babeljs.io/docs/v8-migration"]);
    const none = source({ url: "u", text: "https://babeljs.io/docs/v8-migration", old: false }, {}, [["UPGRADING.md", "https://raw/UPGRADING.md"]]);
    expect(await majorDocs(8, none, seen)).toEqual([]);
    const file = source(undefined, { "https://raw/UPGRADING.md": `# Upgrading\n\n## 8.0.0\n\n${"Removed the foo option. ".repeat(20)}\n\n## 7.0.0\n\nOld.` }, [["UPGRADING.md", "https://raw/UPGRADING.md"]]);
    const docs = await majorDocs(8, file, new Set());
    expect(docs.map((d) => [d.via, d.url])).toEqual([["repo-file", "https://github.com/o/r/blob/HEAD/UPGRADING.md"]]);
    expect(docs[0]!.text).toContain("Removed the foo option");
    expect(docs[0]!.text).not.toContain("Old.");
  });
});
