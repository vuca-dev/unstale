// The public website at unstale.sh, built from an exported catalog tree (`node gateway/site/build.ts <site dir>`).
// It writes next to `v1/` in the same tree, which the gateway deploys as static files: a home page, one page per
// covered package listing its changes by major version (breaking changes first, each with its official sources),
// sitemap.xml, robots.txt, llms.txt, llms-full.txt, security.txt and _headers, and an index.md beside every page for
// agents. Pages are generated from the catalog alone, with no per-package content. A package with fewer than
// THIN_RECORDS changes gets a page but is not indexed by search engines.
// The look follows the CLI's `init` screen: its particle wordmark and its
// tones (fresh green, stale amber, teal accent, muted).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const ORIGIN = "https://unstale.sh";
export const REPO = "https://github.com/vuca-dev/unstale";
export const INSTALL_NPX = "npx @unstale/cli init";
export const INSTALL_BREW = "brew install vuca-dev/tap/unstale";
export const THIN_RECORDS = 10;

/** Shared Menlo Bold outlines and particle mask; no installed font is required. */
export const WORDMARK = JSON.parse(readFileSync(new URL("../../docs/assets/wordmark.json", import.meta.url), "utf8")) as {
  paths: string[];
  points: [number, number][];
};

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

type Group = { title: string; chip: string; id: string; tone: string; test: (r: CatalogRecord) => boolean; collapsed?: boolean };
const GROUPS: Group[] = [
  { title: "Breaking changes", chip: "breaking", id: "breaking", tone: "amber", test: (r) => r.breaking === true || r.change_type === "removal" },
  { title: "Security", chip: "security", id: "security", tone: "amber", test: (r) => r.change_type === "security" || (r.benefit ?? []).includes("security") },
  { title: "Deprecations", chip: "deprecations", id: "deprecations", tone: "amber", test: (r) => r.change_type === "deprecation" },
  { title: "New APIs and options", chip: "new APIs and options", id: "new", tone: "fresh", test: (r) => r.change_type === "new_api" || r.change_type === "new_option" },
  { title: "Performance", chip: "performance", id: "performance", tone: "fresh", test: (r) => r.change_type === "performance" },
  {
    title: "Behavior and default changes", chip: "behavior and defaults",
    id: "behavior",
    tone: "accent",
    test: (r) => ["behavior_change", "default_change", "stability_change"].includes(r.change_type ?? ""),
  },
  { title: "Tooling", chip: "tooling", id: "tooling", tone: "muted", test: (r) => r.change_type === "tooling" },
  { title: "Fixes and other changes", chip: "fixes and other", id: "fixes", tone: "muted", test: () => true, collapsed: true },
];
const groupOf = (r: CatalogRecord) => GROUPS.find((g) => g.test(r))!;

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

/** Keep the same bold editor typography in the header, footer, and particle hero. */
export function wordmarkSvg(className: string): string {
  return `<svg class="${className}" viewBox="4 14 248 50" role="img" aria-label="unstale"><title>unstale</title><g fill="currentColor">${WORDMARK.paths.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 9"><rect width="7" height="9" rx="1.4" fill="#0b1113"/>${
  ["10001", "10001", "10001", "10011", "01101"]
    .flatMap((row, y) => [...row].map((c, x) => (c === "1" ? `<circle cx="${x + 1.5}" cy="${y + 2.5}" r="0.44" fill="#67dc91"/>` : "")))
    .join("")
}</svg>`;

const NPM_URL = "https://www.npmjs.com/package/@unstale/cli";

function copyable(cmd: string, extra = ""): string {
  return `<div class="cmd${extra}"><span class="dollar" aria-hidden="true">$</span><code>${esc(cmd)}</code><button type="button" class="copy" data-copy="${esc(cmd)}" aria-label="Copy command" title="Copy command"><svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><svg class="copied-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></div>`;
}

/** "@unstale/cli 0.1.1 on npm", linked: the package an `npx` reader checks before running it. */
function npmLink(version: string | undefined): string {
  return `<a href="${NPM_URL}"><code>@unstale/cli</code>${version ? ` ${esc(version)}` : ""} on npm</a>`;
}

function layout(o: { title: string; description: string; path: string; body: string; noindex?: boolean; head?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${ORIGIN}${o.path}">
<link rel="alternate" type="text/markdown" href="${ORIGIN}${o.path}index.md">
<link rel="describedby" href="${ORIGIN}/llms.txt">
${o.noindex ? '<meta name="robots" content="noindex">\n' : ""}<meta name="theme-color" content="#0b1113" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f8f7" media="(prefers-color-scheme: light)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="unstale">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${ORIGIN}${o.path}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/site.css">
${o.head ?? ""}</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="unstale home">${wordmarkSvg("mark")}</a><nav><a href="/#packages">Packages</a><a href="${REPO}">GitHub</a></nav></div></header>
<main class="wrap">
${o.body}
</main>
<footer class="wrap"><p>${wordmarkSvg("mark small")}<span>AGPL-3.0 · <a href="${REPO}">GitHub</a> · <a href="${NPM_URL}">npm</a> · <a href="${REPO}/blob/main/SECURITY.md">Security</a> · by <a href="https://vuca.dev">Jason Draper</a></span></p></footer>
<script src="/site.js" type="module"></script>
</body>
</html>
`;
}

function counts(p: Package): Record<string, number> {
  const c: Record<string, number> = {};
  for (const { records } of p.lines) for (const r of records) c[groupOf(r).id] = (c[groupOf(r).id] ?? 0) + 1;
  return c;
}

const versionsOf = (r: CatalogRecord) => [...new Set((r.releases ?? []).map((x) => x.version))].sort(compareVersions);
const shownVersions = (v: string[]) => (v.length > 3 ? `${v[0]} … ${v.at(-1)}` : v.join(", "));
const sourcesOf = (r: CatalogRecord) => {
  const seen = new Set<string>();
  return (r.evidence ?? []).filter((e) => e.url && !seen.has(e.url) && seen.add(e.url));
};

function recordItem(r: CatalogRecord): string {
  const shown = shownVersions(versionsOf(r));
  const sources = sourcesOf(r)
    .map((e) => `<a href="${esc(e.url)}" rel="nofollow">${esc(SOURCE_LABEL[e.kind] ?? "source")}</a>`)
    .join("");
  return `<li><p>${prose(r.summary!)}</p><p class="meta">${shown ? `<span class="v">${esc(shown)}</span>` : ""}${sources}</p></li>`;
}

function span(p: Package): string {
  return p.lines.length > 1 ? `${p.lines.at(-1)!.line} to ${p.lines[0]!.line}` : p.lines[0]!.line;
}

function describe(p: Package): string {
  const c = counts(p);
  const tally = [
    c.breaking && `${c.breaking} breaking`,
    c.deprecations && `${c.deprecations} deprecations`,
    c.security && `${c.security} security`,
    c.new && `${c.new} new APIs and options`,
  ].filter(Boolean);
  return (
    `${p.count} ${p.count === 1 ? "change" : "changes"} in ${p.name} ${span(p)} from its official release notes, upgrade guides and advisories` +
    (tally.length ? `: ${tally.join(", ")}.` : ".") +
    " Each one cited."
  );
}

export function packagePage(p: Package, version?: string): string {
  const c = counts(p);
  const tally = GROUPS.filter((g) => c[g.id])
    .map((g) => `<span><b class="${g.tone}">${c[g.id]}</b> ${g.chip}</span>`)
    .join("");
  const sections = p.lines
    .map(({ line, records }) => {
      const groups = GROUPS.map((g) => {
        const items = records.filter((r) => groupOf(r) === g);
        if (!items.length) return "";
        const head = `<h3 class="${g.tone}">${g.title} <span class="n">${items.length}</span></h3>`;
        const list = `<ul class="changes tone-${g.tone}">${items.map(recordItem).join("")}</ul>`;
        return g.collapsed
          ? `<details class="group"><summary>${head}</summary>${list}</details>`
          : `<div class="group" id="${esc(line)}-${g.id}">${head}${list}</div>`;
      }).join("\n");
      return `<section class="line" id="v${esc(line)}"><h2><span class="pkg">${esc(p.name)}</span> ${esc(line)}<span class="n">${records.length} changes</span></h2>\n${groups}</section>`;
    })
    .join("\n");
  const toc = p.lines.length > 1
    ? `<nav class="lines" aria-label="Major versions">${p.lines.map((l) => `<a href="#v${esc(l.line)}">${esc(p.name)} ${esc(l.line)}</a>`).join("")}</nav>`
    : "";
  const body = `<p class="crumb"><a href="/#packages">${esc(p.ecosystem)}</a> / ${esc(p.name)}</p>
<h1 class="pkgname">${esc(p.name)}</h1>
<p class="sub">What changed in ${esc(p.name)} ${esc(span(p))}, from its official release notes, upgrade guides and advisories.${p.also.length ? ` Also covers ${p.also.map((a) => `<code>${esc(a)}</code>`).join(", ")}.` : ""} Sources checked ${esc(p.checked.slice(0, 10))}.</p>
<p class="tally">${tally}</p>
<div class="cta"><p>See which of these apply to your code, ranked, in your agent:</p>${copyable(INSTALL_NPX)}<p class="alt">${npmLink(version)}</p></div>
${toc}
${sections}`;
  return layout({
    title: `${p.name} changes by version: breaking changes, deprecations, new APIs · unstale`,
    description: describe(p),
    path: p.path,
    body,
    noindex: p.count < THIN_RECORDS,
  });
}

/** The same page as Markdown, for agents (`index.md` beside `index.html`; also served for `Accept: text/markdown`). */
export function packageMarkdown(p: Package): string {
  const out = [
    `# What changed in ${p.name}`,
    "",
    `> ${describe(p)} Sources checked ${p.checked.slice(0, 10)}. HTML: ${ORIGIN}${p.path}`,
    "",
    `To see which of these apply to a repository, run \`${INSTALL_NPX}\` in it.`,
  ];
  for (const { line, records } of p.lines) {
    out.push("", `## ${p.name} ${line}`);
    for (const g of GROUPS) {
      const items = records.filter((r) => groupOf(r) === g);
      if (!items.length) continue;
      out.push("", `### ${g.title}`, "");
      for (const r of items) {
        const v = shownVersions(versionsOf(r));
        const src = sourcesOf(r).map((e) => `[${SOURCE_LABEL[e.kind] ?? "source"}](${e.url})`).join(", ");
        out.push(`- ${r.summary!.replace(/\s+/g, " ")}${v ? ` (${v})` : ""}${src ? ` — ${src}` : ""}`);
      }
    }
  }
  return out.join("\n") + "\n";
}

// Real `unstale init` output on a Next.js and Prisma app (`@unstale/cli` 0.1.0, 17 October 2026), trimmed, in the
// CLI's tones.
const TERMINAL: [string, string][] = [
  ["cmd", "$ npx @unstale/cli init"],
  ["fresh", "✓ my-app · Personal setup ready"],
  ["body", "Mapped 119 direct dependencies from pnpm-lock.yaml and checked local references."],
  ["muted", "Security · 31 advisory fixes match installed versions; each is noted on its upgrade."],
  ["", ""],
  ["accent", "Upgrades to review · 3 shortlisted"],
  ["body", "1. next 16.2.1 → 16.4.2 picks up 37 security fixes, 90 bug fixes, 5 performance changes, 20 behaviour changes"],
  ["body", "2. prisma 6.19.3 → 7.10.0 picks up 8 security fixes, 82 bug fixes, 8 performance changes · unlocks 52 optional capabilities"],
  ["", ""],
  ["accent", "Capabilities to explore · 8 shortlisted"],
  ["body", "1. next · available on 16.2.1 — updateTag provides Server Actions with read-your-writes cache expiration and immediate refresh semantics."],
  ["muted", "   Reference (unverified): `next/cache` in src/entities/user/model/update-user.action.ts"],
  ["", ""],
  ["rule", ""],
  ["fresh", "NEXT · Paste this prompt into your coding agent"],
  ["prompt", "Use .unstale/skills/onboarding/SKILL.md to review .unstale/onboarding-report.md against this repository. Rank the upgrades and capabilities by likely impact, explain the trade-offs, and recommend what to do first. Return proposals only; do not edit files."],
  ["rule", ""],
];

function terminal(): string {
  const rows = TERMINAL.map(([tone, text]) =>
    tone === "rule" ? `<span class="t-rule"></span>` : `<span class="t-${tone || "body"}">${esc(text) || "&nbsp;"}</span>`,
  ).join("");
  return `<section class="prose example">
<p>Example output of <code>unstale init</code> on a Next.js and Prisma app</p>
<figure class="term"><pre>${rows}</pre></figure>
</section>`;
}

/** Concrete merged fixes prompted by unstale findings. */
const CONTRIBUTIONS: { lead: string; rest: string; url: string }[] = [
  { lead: "Phoenix", rest: "Replaced deprecated AI SDK calls.", url: "https://github.com/Arize-ai/phoenix/pull/17150" },
  { lead: "i18next", rest: "Fixed a test that wasn't checking its call count.", url: "https://github.com/i18next/i18next/pull/2453" },
];

const SUMMARY =
  "unstale tells you and your coding agent what changed upstream for your package versions and your code. Cited, local, free and open source.";

const EVAL = `${REPO}/blob/main/eval/gate/MISSES.md`;
const BEAT_NAIVE = `${REPO}/blob/main/eval/beat-naive/RESULTS.md`;

/** Distinct package identities, including related packages grouped on a single page. */
function catalogStats(pkgs: Package[]) {
  const names = new Set(pkgs.flatMap((p) => [p.name, ...p.also].map((name) => `${p.ecosystem}/${name}`)));
  return { changes: pkgs.reduce((n, p) => n + p.count, 0).toLocaleString("en-US"), packages: names.size.toLocaleString("en-US") };
}

export function homePage(pkgs: Package[], version?: string): string {
  const stats = catalogStats(pkgs);
  const ld = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "unstale",
    description: SUMMARY,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    url: ORIGIN,
    ...(version ? { softwareVersion: version } : {}),
    downloadUrl: NPM_URL,
    sameAs: [REPO, NPM_URL],
  };
  const list = pkgs
    .map((p) => `<li data-name="${esc([p.name, ...p.also].join(" "))}"><a href="${esc(p.path)}">${esc(p.name)}</a> <span class="n">${p.count}</span></li>`)
    .join("");
  const body = `<section class="hero">
<canvas id="wordmark" class="wordmark" width="768" height="240" aria-hidden="true"></canvas>
<h1>You don't know what you don't know. Neither do your agents.</h1>
<p class="lede">unstale finds what changed in your dependencies and where your code needs it. It reads the release
notes, migration guides and advisories for your installed versions, and hands Claude Code, Codex or Cursor a cited
list.</p>
<p class="lede">It finds 4x as many changes worth acting on as Claude Code alone, using 1/16 of the tokens. <a href="${BEAT_NAIVE}">How we measured</a></p>
<p class="hero-facts">Runs locally · Free · Open source</p>
<div class="get-started" aria-labelledby="get-started">
<h2 id="get-started">Get started</h2>
<p class="install-hint">Run in your project directory.</p>
${copyable(INSTALL_NPX, " big")}
<details class="brew-install"><summary>Install with Homebrew</summary>
${copyable(INSTALL_BREW)}
<p class="install-hint">Then run in your project:</p>
${copyable("unstale init")}
</details>
</div>
</section>
<section class="catalog-proof" aria-label="Current catalog coverage">
<dl class="catalog-stats">
<div><dt>changes indexed</dt><dd>${stats.changes}+</dd></div>
<div><dt>packages covered</dt><dd>${stats.packages}+</dd></div>
</dl>
<a class="catalog-explore" href="#packages">Explore your stack <span aria-hidden="true">↓</span></a>
</section>
${terminal()}
<section class="prose">
<h2>What you get</h2>
<ul>
<li><strong>Upgrade plans.</strong> Breaking changes, deprecations and affected files.</li>
<li><strong>Fixes worth upgrading for.</strong> Security, bug fixes and behaviour changes between versions.</li>
<li><strong>New opportunities.</strong> Net new capabilities, performance improvements, and more.</li>
</ul>
<h2>How it works</h2>
<ol>
<li><strong>Read your lockfile.</strong> JavaScript, TypeScript and Python projects.</li>
<li><strong>Find what applies.</strong> Match a central catalog of upstream changes to your repo locally.</li>
<li><strong>Review with your agent.</strong> A report and a ready-to-paste prompt.</li>
</ol>
<h2>Your code stays on your machine</h2>
<p>unstale receives public package names; <a href="https://osv.dev">OSV</a> receives package names and versions for advisory checks. No telemetry.</p>
<details class="privacy-details"><summary>Network details</summary>
<p>Public package names (like <code>pkg:npm/next</code>) to fetch the changes that apply. Not your code, file paths,
versions or any ID. The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate
limits and count each address once per package, and never writes it to storage. To check advisories, the CLI sends the package names and versions your lockfiles resolve to
<a href="https://osv.dev">OSV</a>, as <code>npm audit</code> would, and it reads the public npm and PyPI registries.</p>
</details>
<h2>Fixes merged upstream</h2>
<ul>
${CONTRIBUTIONS.map((c) => `<li><a href="${esc(c.url)}">${esc(c.lead)}</a> ${esc(c.rest)}</li>`).join("\n")}
</ul>
<p class="license">AGPL-3.0 · <a href="${REPO}">GitHub</a></p>
</section>
<section id="packages" class="packages prose">
<h2>Explore your stack</h2>
<input id="filter" type="search" placeholder="Search your dependencies…" aria-label="Search your dependencies" aria-controls="pkgs">
<p id="package-empty" class="package-empty" role="status" hidden>No match yet. Run <code>${esc(INSTALL_NPX)}</code> in your project to request coverage.</p>
<ul class="pkgs" id="pkgs">${list}</ul>
</section>`;
  return layout({
    title: "unstale: what changed upstream that matters to your code, for coding agents",
    description: SUMMARY,
    path: "/",
    body,
    head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n<script>window.UNSTALE_WORDMARK_POINTS=${JSON.stringify(WORDMARK.points)}</script>\n`,
  });
}

export function homeMarkdown(pkgs: Package[], version?: string): string {
  return `# unstale

> ${SUMMARY}

Install: \`${INSTALL_NPX}\` in a repository${version ? ` (\`@unstale/cli\` ${version}, ${NPM_URL})` : ""}, or \`${INSTALL_BREW}\`.

**You don't know what you don't know. Neither do your agents.**

unstale finds what changed in your dependencies and where your code needs it. It reads the release notes, migration
guides and advisories for your installed versions, and hands Claude Code, Codex or Cursor a cited list. Runs locally,
free and open source.

It finds 4x as many changes worth acting on as Claude Code alone, using 1/16 of the tokens
([how we measured](${BEAT_NAIVE})).

## What you get

- **Upgrade plans.** Breaking changes, deprecations and affected files.
- **Fixes worth upgrading for.** Security, bug fixes and behaviour changes between versions.
- **New opportunities.** Net new capabilities, performance improvements, and more.

## How it works

1. **Read your lockfile.** JavaScript, TypeScript and Python projects.
2. **Find what applies.** Match a central catalog of upstream changes to your repo locally.
3. **Review with your agent.** A report and a ready-to-paste prompt.

## Your code stays on your machine

Public package names (like \`pkg:npm/next\`) to fetch the changes that apply. Not your code, file paths, versions or
any ID. The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate limits and count
each address once per package, and never writes it to storage.
No telemetry. To check advisories, the CLI sends the package names and versions your lockfiles resolve to OSV
(https://osv.dev), as \`npm audit\` would, and it reads the public npm and PyPI registries.

## Fixes merged upstream

${CONTRIBUTIONS.map((c) => `- [${c.lead}](${c.url}) ${c.rest}`).join("\n")}

AGPL-3.0, free and open source: ${REPO}

## Upstream changes, indexed

${catalogStats(pkgs).changes}+ changes indexed · ${catalogStats(pkgs).packages}+ packages covered in the current published catalog.
Every change links to an official source.

${pkgs.map((p) => `- [${p.name}](${ORIGIN}${p.path}index.md): ${p.count} ${p.count === 1 ? "change" : "changes"}`).join("\n")}
`;
}

export function llmsTxt(pkgs: Package[], version?: string): string {
  return `# unstale

> ${SUMMARY}

unstale is a CLI (\`@unstale/cli\` on npm${version ? `, ${version}` : ""}) plus a public, signed catalog of upstream changes.
\`${INSTALL_NPX}\` in a repository maps its dependencies, matches the catalog against the code locally, and writes agent
skills (\`/unstale-onboarding\`, \`/unstale-upgrade-review\`, \`/unstale-improvements-pass\`; \`$\`-prefixed in Codex).

Notes for agents:

- To learn what changed in a package, fetch \`${ORIGIN}/<ecosystem>/<package>/index.md\` (for example
  \`${ORIGIN}/npm/next/index.md\`; scoped packages keep their scope, \`${ORIGIN}/npm/@nestjs/core/index.md\`). Changes are grouped by
  major version, breaking changes first, each with its official sources. Any page also returns Markdown for
  \`Accept: text/markdown\`.
- Do not assume the latest version of \`@unstale/cli\` from memory; check \`npm view @unstale/cli version\`.
- The catalog's source of truth is the upstream release note, guide or advisory each item links to.

## Docs

- [README](${REPO}/blob/main/README.md): what it does, install, commands, how it works
- [Full text for agents](${ORIGIN}/llms-full.txt): README and security model in one file
- [Security and data handling](${REPO}/blob/main/SECURITY.md)
- [Against an unaided agent](${BEAT_NAIVE}): unstale vs Claude Code on 19 repos
- [Evaluation on real upgrades](${REPO}/blob/main/eval/gate/MISSES.md)
- [Home page as Markdown](${ORIGIN}/index.md)

## Upstream changes, indexed

${catalogStats(pkgs).changes}+ changes indexed · ${catalogStats(pkgs).packages}+ packages covered in the current published catalog.
Every change links to an official source.

${pkgs.map((p) => `- [${p.name}](${ORIGIN}${p.path}index.md): ${p.count} ${p.count === 1 ? "change" : "changes"}`).join("\n")}
`;
}

/** llms-full.txt: the README and the security model, read from the repository at build time. */
export function llmsFull(): string {
  const read = (rel: string) => {
    try {
      return readFileSync(new URL(rel, import.meta.url), "utf8");
    } catch {
      return "";
    }
  };
  return [read("../../README.md"), read("../../SECURITY.md")].filter(Boolean).join("\n\n---\n\n");
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

/** Response headers for every static file (Workers static assets `_headers`). */
export const HEADERS = `/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/*.md
  Content-Type: text/markdown; charset=utf-8
`;

export function securityTxt(now: string): string {
  const expires = new Date(Date.parse(now) + 180 * 86_400_000).toISOString();
  return `Contact: ${REPO}/security/advisories/new
Expires: ${expires}
Policy: ${REPO}/blob/main/SECURITY.md
Preferred-Languages: en
Canonical: ${ORIGIN}/.well-known/security.txt
`;
}

function write(site: string, rel: string, text: string) {
  const file = join(site, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** `version`: the published `@unstale/cli` version shown beside the npm link (omitted when unknown). */
export function build(site: string, now = new Date().toISOString(), version?: string): number {
  const pkgs = loadPackages(site);
  write(site, "index.html", homePage(pkgs, version));
  write(site, "index.md", homeMarkdown(pkgs, version));
  for (const p of pkgs) {
    write(site, join(p.path, "index.html"), packagePage(p, version));
    write(site, join(p.path, "index.md"), packageMarkdown(p));
  }
  for (const f of ["site.css", "site.js", "wordmark-repairs.js"]) write(site, f, readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
  write(site, "favicon.svg", FAVICON);
  write(site, "sitemap.xml", sitemap(pkgs, now));
  write(site, "robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  write(site, "llms.txt", llmsTxt(pkgs, version));
  write(site, "llms-full.txt", llmsFull());
  write(site, ".well-known/security.txt", securityTxt(now));
  write(site, "_headers", HEADERS);
  // Files that must sit at the root verbatim (search-engine ownership checks); see `page` in src/index.ts.
  const statics = new URL("./static/", import.meta.url);
  for (const f of readdirSync(statics)) write(site, f, readFileSync(new URL(f, statics), "utf8"));
  return pkgs.length;
}

async function publishedVersion(): Promise<string | undefined> {
  try {
    const res = await fetch("https://registry.npmjs.org/@unstale%2Fcli/latest", { signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as { version?: string }).version : undefined;
  } catch {
    return undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = process.argv[2];
  if (!site) throw new Error("usage: node gateway/site/build.ts <site dir>");
  const version = await publishedVersion();
  console.log(`site: ${build(site, undefined, version)} package pages (@unstale/cli ${version ?? "version unknown"})`);
}
