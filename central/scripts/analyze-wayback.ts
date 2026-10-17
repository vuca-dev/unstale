// Replay archived captures of generated Markdown copies (Slice 2 E10) through the collector's
// normalizer, and count copy changes with and without a source commit in each interval.
//   tsx scripts/analyze-wayback.ts [--results FILE] [--cache DIR]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { lineDiff } from "../src/collector/diff.ts";
import { normalize } from "../src/collector/normalize.ts";
import { NormalizeRules } from "../src/collector/schema.ts";

const { values } = parseArgs({
  options: {
    results: { type: "string", default: join(homedir(), "ati-slice2/results/e10_wayback.json") },
    cache: { type: "string", default: join(homedir(), "Library/Caches/ati-slice2/wayback") },
  },
});

/** Host rules for Cloudflare's whole-page Markdown rendering (chrome lines seen in the captures). */
const CLOUDFLARE = {
  dropFrontMatter: true,
  dropLines: [
    "^\\[Skip to content\\]",
    "^Last updated .*\\|",
    "^> (Documentation Index|Fetch the complete documentation index|Use this file to discover)",
    '^\\s*\\{"@context":"https://schema.org"',
    "^\\[!\\[\\]\\(https://developers\\.cloudflare\\.com/_astro/",
    "^## On this page$",
    "^Was this helpful\\?$",
    "^YesNo$",
  ],
};
const CONFIGS: Record<string, NormalizeRules> = {
  none: NormalizeRules.parse({}),
  canonical: NormalizeRules.parse({ canonicalMarkdown: true }),
  host: NormalizeRules.parse({ canonicalMarkdown: true, ...CLOUDFLARE }),
};

function load(digest: string): string {
  const raw = readFileSync(join(values.cache, `${digest}.md`));
  if (raw[0] === 0x1f && raw[1] === 0x8b) return gunzipSync(raw).toString("utf8");
  try {
    return raw.toString("utf8").includes("�") ? brotliDecompressSync(raw).toString("utf8") : raw.toString("utf8");
  } catch {
    return raw.toString("utf8");
  }
}

interface Interval { from: string; to: string; from_digest?: string; to_digest?: string; source_commits: string[]; copy_changed: boolean }
interface PageResult { url: string; intervals?: Interval[]; error?: string }
const pages = JSON.parse(readFileSync(values.results, "utf8")) as PageResult[];

/** Capture timestamps and digests from the archive index, with backoff on rate limiting. */
async function cdx(url: string): Promise<Array<[string, string]>> {
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`https://web.archive.org/cdx/search/cdx?url=${url}&output=json&filter=statuscode:200&fl=timestamp,digest`, {
      headers: { "user-agent": "unstale-research/0.0" },
    });
    const body = await res.text();
    if (res.ok) return (JSON.parse(body || "[]") as Array<[string, string]>).slice(1);
    await new Promise((r) => setTimeout(r, 60_000 * (i + 1)));
  }
  throw new Error(`archive index unavailable for ${url}`);
}
const cached = new Set(readdirSync(values.cache).map((f) => f.replace(/\.md$/, "")));

for (const p of pages) {
  if (!p.intervals) {
    console.log(`${p.url}: ${p.error ?? "no intervals"}`);
    continue;
  }
  const digest = new Map<string, string>();
  if (p.intervals.every((i) => i.from_digest && i.to_digest)) {
    for (const i of p.intervals) digest.set(i.from, i.from_digest as string).set(i.to, i.to_digest as string);
  } else {
    for (const [t, d] of await cdx(p.url)) digest.set(t, d);
  }
  console.log(`\n${p.url}`);
  for (const i of p.intervals) {
    const a = digest.get(i.from), b = digest.get(i.to);
    if (!a || !b || !cached.has(a) || !cached.has(b)) {
      console.log(`  ${i.from}→${i.to} missing capture body`);
      continue;
    }
    const before = load(a), after = load(b);
    const cells = Object.entries(CONFIGS).map(([name, rules]) => {
      const d = lineDiff(normalize(before, rules), normalize(after, rules));
      return `${name}=${d.added.length + d.removed.length}`;
    });
    console.log(`  ${i.from.slice(0, 8)}→${i.to.slice(0, 8)} commits=${i.source_commits.length} diff lines: ${cells.join(" ")}`);
  }
}
