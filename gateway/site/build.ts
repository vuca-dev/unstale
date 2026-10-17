// The public website at unstale.sh, built from an exported catalog tree (`node gateway/site/build.ts <site dir>`).
// It writes next to `v1/` in the same tree, which the gateway deploys as static files: a home page, one page per
// covered package listing its changes by major version (breaking changes first, each with its official sources),
// sitemap.xml, robots.txt and llms.txt. Pages are generated from the catalog alone, with no per-package content.
// A package with fewer than THIN_RECORDS changes gets a page but is not indexed by search engines.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const ORIGIN = "https://unstale.sh";
export const REPO = "https://github.com/vuca-dev/unstale";
// Flip with the first release: the install line shown everywhere.
export const RELEASED = false;
export const THIN_RECORDS = 10;

type Evidence = { kind: string; url: string; quote?: string };
type Release = { component: string; version: string; line: string };
export type CatalogRecord = {
  id: string;
  status: string;
  summary?: string;
  change_type?: string;
  breaking?: boolean;
  benefit?: string[];
  releases?: Release[];
  evidence?: Evidence[];
};
type Shard = { path: string; line: string };
type TechIndex = { technology: string; checked: string; shards?: Shard[] };

export type Package = {
  ecosystem: string;
  name: string;
  /** Other packages the same technology covers (for example `@prisma/client` beside `prisma`). */
  also: string[];
  path: string;
  checked: string;
  lines: { line: string; records: CatalogRecord[] }[];
  count: number;
};

const GROUPS: { title: string; id: string; test: (r: CatalogRecord) => boolean; collapsed?: boolean }[] = [
  { title: "Breaking changes", id: "breaking", test: (r) => r.breaking === true || r.change_type === "removal" },
  { title: "Security", id: "security", test: (r) => r.change_type === "security" || (r.benefit ?? []).includes("security") },
  { title: "Deprecations", id: "deprecations", test: (r) => r.change_type === "deprecation" },
  { title: "New APIs and options", id: "new", test: (r) => r.change_type === "new_api" || r.change_type === "new_option" },
  { title: "Performance", id: "performance", test: (r) => r.change_type === "performance" },
  {
    title: "Behavior and default changes",
    id: "behavior",
    test: (r) => ["behavior_change", "default_change", "stability_change"].includes(r.change_type ?? ""),
  },
  { title: "Tooling", id: "tooling", test: (r) => r.change_type === "tooling" },
  { title: "Fixes and other changes", id: "fixes", test: () => true, collapsed: true },
];

const SOURCE_LABEL: Record<string, string> = {
  release_notes: "release notes",
  upgrade_guide: "upgrade guide",
  advisory: "security advisory",
  docs: "docs",
  changelog: "changelog",
};

/** `pkg:npm/%40prisma/client` → ["npm", "@prisma/client"]. */
export function parsePurl(purl: string): [string, string] {
  const m = /^pkg:([a-z]+)\/(.+)$/.exec(purl);
  if (!m) return ["other", purl];
  return [m[1]!, decodeURIComponent(m[2]!)];
}

function versionKey(v: string): number[] {
  return v.split(/[.\-+]/).map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
}

export function compareVersions(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const latestVersion = (r: CatalogRecord) =>
  (r.releases ?? []).map((x) => x.version).sort(compareVersions).at(-1) ?? "";

export function loadPackages(site: string): Package[] {
  const techDir = join(site, "v1", "tech");
  const out: Package[] = [];
  for (const file of readdirSync(techDir).filter((f) => f.endsWith(".json"))) {
    const index = JSON.parse(readFileSync(join(techDir, file), "utf8")) as TechIndex;
    const byLine = new Map<string, CatalogRecord[]>();
    const components = new Set<string>();
    for (const shard of index.shards ?? []) {
      const text = new TextDecoder().decode(gunzipSync(readFileSync(join(site, shard.path))));
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        const r = JSON.parse(raw) as CatalogRecord;
        if (r.status !== "active" || !r.summary) continue;
        for (const rel of r.releases ?? []) components.add(rel.component);
        byLine.set(shard.line, [...(byLine.get(shard.line) ?? []), r]);
      }
    }
    if (!byLine.size) continue;
    const names = [...components].map(parsePurl);
    const base = index.technology.replace(/-[0-9a-f]{8}$/, "");
    const primary = names.find(([, n]) => n === base) ?? names.sort((a, b) => a[1].length - b[1].length)[0]!;
    const lines = [...byLine.entries()]
      .sort(([a], [b]) => compareVersions(b, a))
      .map(([line, records]) => ({ line, records: records.sort((a, b) => compareVersions(latestVersion(b), latestVersion(a))) }));
    out.push({
      ecosystem: primary[0],
      name: primary[1],
      also: names.filter(([, n]) => n !== primary[1]).map(([, n]) => n).sort(),
      path: `/${primary[0]}/${primary[1]}/`,
      checked: index.checked,
      lines,
      count: lines.reduce((n, l) => n + l.records.length, 0),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------------------------------------ HTML

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Escaped text with `backticked` spans as code. */
export function prose(s: string): string {
  return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

const INSTALL = RELEASED
  ? `<pre><code>npx @unstale/cli init</code></pre>`
  : `<pre><code>npx @unstale/cli init</code></pre><p class="note">Arrives with the first release. Until then, <a href="${REPO}#quick-start">build from source</a>.</p>`;

function layout(o: { title: string; description: string; path: string; body: string; noindex?: boolean; head?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${ORIGIN}${o.path}">
${o.noindex ? '<meta name="robots" content="noindex">\n' : ""}<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${ORIGIN}${o.path}">
<link rel="stylesheet" href="/site.css">
${o.head ?? ""}</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/">unstale</a><nav><a href="/#packages">Packages</a><a href="${REPO}">GitHub</a></nav></div></header>
<main class="wrap">
${o.body}
</main>
<footer class="wrap"><p>Open source under AGPL-3.0 · <a href="${REPO}">${REPO.replace("https://", "")}</a> · Built by <a href="https://vuca.dev">Jason Draper</a></p></footer>
</body>
</html>
`;
}

function counts(p: Package): Record<string, number> {
  const c: Record<string, number> = {};
  for (const { records } of p.lines)
    for (const r of records) {
      const g = GROUPS.find((g) => g.test(r))!;
      c[g.id] = (c[g.id] ?? 0) + 1;
    }
  return c;
}

function recordItem(r: CatalogRecord): string {
  const versions = [...new Set((r.releases ?? []).map((x) => x.version))].sort(compareVersions);
  const shown = versions.length > 3 ? `${versions[0]} … ${versions.at(-1)}` : versions.join(", ");
  const seen = new Set<string>();
  const sources = (r.evidence ?? [])
    .filter((e) => e.url && !seen.has(e.url) && seen.add(e.url))
    .map((e) => `<a href="${esc(e.url)}" rel="nofollow">${esc(SOURCE_LABEL[e.kind] ?? "source")}</a>`)
    .join(" · ");
  return `<li><p>${prose(r.summary!)}</p><p class="meta">${shown ? `<span class="v">${esc(shown)}</span>` : ""}${sources ? ` ${sources}` : ""}</p></li>`;
}

export function packagePage(p: Package): string {
  const c = counts(p);
  const span = p.lines.length > 1 ? `${p.lines.at(-1)!.line} to ${p.lines[0]!.line}` : p.lines[0]!.line;
  const tally = [
    c.breaking && `${c.breaking} breaking`,
    c.deprecations && `${c.deprecations} deprecations`,
    c.security && `${c.security} security`,
    c.new && `${c.new} new APIs and options`,
  ].filter(Boolean);
  const description =
    `${p.count} changes in ${p.name} ${span} from its official release notes, upgrade guides and advisories` +
    (tally.length ? `: ${tally.join(", ")}.` : ".") +
    " Each one cited.";
  const sections = p.lines
    .map(({ line, records }) => {
      const groups = GROUPS.map((g) => {
        const items = records.filter((r) => GROUPS.find((x) => x.test(r)) === g);
        if (!items.length) return "";
        const list = `<ul class="changes">${items.map(recordItem).join("")}</ul>`;
        return g.collapsed
          ? `<details><summary><h3>${g.title} <span class="n">${items.length}</span></h3></summary>${list}</details>`
          : `<h3 id="${esc(line)}-${g.id}">${g.title} <span class="n">${items.length}</span></h3>${list}`;
      }).join("\n");
      return `<section id="${esc(line)}"><h2>${esc(p.name)} ${esc(line)}</h2>\n${groups}</section>`;
    })
    .join("\n");
  const toc = p.lines.length > 1
    ? `<p class="toc">${p.lines.map((l) => `<a href="#${esc(l.line)}">${esc(l.line)}</a>`).join(" ")}</p>`
    : "";
  const body = `<p class="eco">${esc(p.ecosystem)}</p>
<h1>What changed in ${esc(p.name)}</h1>
<p class="lede">${esc(description)}${p.also.length ? ` Also covers ${p.also.map((a) => `<code>${esc(a)}</code>`).join(", ")}.` : ""} Sources checked ${esc(p.checked.slice(0, 10))}.</p>
<aside class="cta"><p><strong>Which of these apply to your code?</strong> unstale matches each change against your
repository on your machine and hands the ones that apply to Claude Code, Codex or Cursor, breaking changes first.</p>
${INSTALL}</aside>
${toc}
${sections}`;
  return layout({
    title: `${p.name} changes by version: breaking changes, deprecations, new APIs · unstale`,
    description,
    path: p.path,
    body,
    noindex: p.count < THIN_RECORDS,
  });
}

export function homePage(pkgs: Package[]): string {
  const total = pkgs.reduce((n, p) => n + p.count, 0);
  const description =
    "unstale tells Claude Code, Codex and Cursor what changed upstream since their training cutoff that applies to your code: new APIs worth adopting, breaking changes for your next major upgrade, deprecations, and the security and performance fixes in each version bump.";
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "unstale",
    description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    url: ORIGIN,
    sameAs: [REPO, "https://www.npmjs.com/package/@unstale/cli"],
  };
  const list = pkgs
    .map((p) => `<li data-name="${esc([p.name, ...p.also].join(" "))}"><a href="${esc(p.path)}">${esc(p.name)}</a> <span class="n">${p.count}</span></li>`)
    .join("");
  const body = `<section class="hero">
<h1>Everything that changed past your coding agent's knowledge cutoff.</h1>
<p class="lede">Teams ship faster than ever, and so does every framework, SDK and platform they depend on. Nobody can
read all the release notes, migration guides and docs changes, and your coding agent was trained before most of them
existed.</p>
<p class="lede">unstale reads the official release notes, migration guides, docs and security advisories of the
packages you use, distills each change once, and matches it against your code. Your coding agent (Claude Code, Codex or
Cursor) then knows what applies here: new APIs worth adopting, breaking changes for your next major upgrade,
deprecations, and the security and performance fixes in each version bump. Nothing else.</p>
${INSTALL}
</section>
<section class="cols">
<div><h2>What your agent gets</h2><ul>
<li><strong>Upgrade reviews.</strong> What you must change to move to the next major version, obligations first, located in your code.</li>
<li><strong>New capabilities.</strong> Features released since you wrote the code that could replace custom code, each with its stated benefit.</li>
<li><strong>Bump digests.</strong> What a version bump actually fixes, including security advisories, with no model calls.</li>
<li><strong>Ambient awareness.</strong> One line at the start of a Claude Code session when something new lands for your stack.</li>
</ul></div>
<div><h2>Why it holds up</h2><ul>
<li><strong>Source-cited.</strong> Every item links to the release note, guide, docs page or advisory it came from.</li>
<li><strong>Private.</strong> Matching runs on your machine. Your code, paths and versions never leave it, and there is no telemetry.</li>
<li><strong>Signed.</strong> The catalog is signed; the client discards anything that does not verify.</li>
<li><strong>Quiet when it should be.</strong> If nothing upstream matters to your code, your agent hears nothing.</li>
<li><strong>Alongside your update bot.</strong> Dependabot and Renovate tell you a new version exists; unstale tells your agent what it means for your code.</li>
</ul></div>
</section>
<section>
<h2>Proven on real upgrades</h2>
<p>We replay 15 real major upgrades in open-source projects (Next.js 16, Prisma 7, NestJS 12) from the commit before
the maintainers upgraded. Of the required changes that official sources document, the catalog covers 60 of 65, and
the first batch of 16 the agent works through holds 34 of them. <a href="${REPO}/blob/main/eval/gate/MISSES.md">Method and results</a>.</p>
</section>
<section id="packages">
<h2>What changed, package by package</h2>
<p>${total.toLocaleString("en-US")} changes across ${pkgs.length} packages, read from official sources and kept current.
Any npm or PyPI package your project uses is added on request.</p>
<input id="filter" type="search" placeholder="Filter packages" aria-label="Filter packages">
<ul class="pkgs" id="pkgs">${list}</ul>
</section>
<script>
document.getElementById("filter").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const li of document.querySelectorAll("#pkgs li")) li.hidden = q !== "" && !li.dataset.name.toLowerCase().includes(q);
});
</script>`;
  return layout({
    title: "unstale: what changed upstream that matters to your code, for coding agents",
    description,
    path: "/",
    body,
    head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n`,
  });
}

export function llmsTxt(pkgs: Package[]): string {
  return `# unstale

> unstale tells coding agents (Claude Code, Codex, Cursor) what changed upstream since their training cutoff that
> applies to a repository: new APIs worth adopting, breaking changes for the next major upgrade, deprecations, and the
> security and performance fixes in each version bump. Changes come from official release notes, upgrade guides, docs
> and security advisories, each cited. Matching runs locally; no code leaves the machine.

- [Source, install and documentation](${REPO})
- [Security and data handling](${REPO}/blob/main/SECURITY.md)
- [Evaluation on real upgrades](${REPO}/blob/main/eval/gate/MISSES.md)

## Changes by package

${pkgs.filter((p) => p.count >= THIN_RECORDS).map((p) => `- [${p.name}](${ORIGIN}${p.path}): ${p.count} changes`).join("\n")}
`;
}

export function sitemap(pkgs: Package[], now: string): string {
  const urls = [
    `<url><loc>${ORIGIN}/</loc><lastmod>${now.slice(0, 10)}</lastmod></url>`,
    ...pkgs
      .filter((p) => p.count >= THIN_RECORDS)
      .map((p) => `<url><loc>${esc(ORIGIN + p.path)}</loc><lastmod>${esc(p.checked.slice(0, 10))}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

function write(site: string, rel: string, text: string) {
  const file = join(site, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export function build(site: string, now = new Date().toISOString()): number {
  const pkgs = loadPackages(site);
  write(site, "index.html", homePage(pkgs));
  for (const p of pkgs) write(site, join(p.path, "index.html"), packagePage(p));
  write(site, "site.css", readFileSync(new URL("./site.css", import.meta.url), "utf8"));
  write(site, "sitemap.xml", sitemap(pkgs, now));
  write(site, "robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  write(site, "llms.txt", llmsTxt(pkgs));
  return pkgs.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = process.argv[2];
  if (!site) throw new Error("usage: node gateway/site/build.ts <site dir>");
  console.log(`site: ${build(site)} package pages`);
}
