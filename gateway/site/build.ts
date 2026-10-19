// The public website at unstale.sh, built from an exported catalog tree (`node gateway/site/build.ts <site dir>`).
// It writes next to `v1/` in the same tree, which the gateway deploys as static files: a home page, one page per
// covered package listing its changes by major version (breaking changes first, each with its official sources),
// sitemap.xml, robots.txt, llms.txt, llms-full.txt, security.txt and _headers, and an index.md beside every page for
// agents. Pages are generated from the catalog alone, with no per-package content. A package with fewer than
// THIN_RECORDS changes gets a page but is not indexed by search engines.
// The look follows the CLI's `init` screen: its dot-matrix wordmark (GLYPHS, local/cli/src/onboarding_ui.rs) and its
// tones (fresh green, stale amber, teal accent, muted).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const ORIGIN = "https://unstale.sh";
export const REPO = "https://github.com/vuca-dev/unstale";
export const INSTALL_NPX = "npx @unstale/cli init";
export const INSTALL_BREW = "brew install vuca-dev/tap/unstale";
export const THIN_RECORDS = 10;

/** The CLI's wordmark, "unstale", one 5×7 glyph per letter (rows top to bottom; 1 = dot). */
export const GLYPHS: string[][] = [
  ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  ["00000", "00000", "11110", "10001", "10001", "10001", "10001"],
  ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  ["00100", "00100", "11111", "00100", "00100", "00100", "00010"],
  ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
];

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

/** The wordmark as an SVG, drawn as the CLI draws it: each glyph pixel a 4×3 block of braille sub-dots (the CLI's
 * scale 3, at its grid offsets so dots group into the same braille cells), cells twice as tall as wide. */
export function wordmarkSvg(className: string): string {
  const dots = new Set<string>();
  GLYPHS.forEach((glyph, letter) =>
    glyph.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c !== "1") return;
        for (let dy = 0; dy < 3; dy++)
          for (let dx = 0; dx <= 3; dx++) {
            const sx = 3 + (letter * 6 + x) * 3 + dx;
            const sy = 7 + y * 3 + dy;
            const cx = Math.floor(sx / 2) + (sx % 2 ? 0.68 : 0.32) - 1;
            const cy = Math.floor(sy / 4) * 2 + ((sy % 4) + 0.5) * 0.5 - 2;
            dots.add(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="0.15"/>`);
          }
      }),
    ),
  );
  return `<svg class="${className}" viewBox="0.4 1.5 62.2 10.5" role="img" aria-label="unstale"><title>unstale</title>${[...dots].join("")}</svg>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 9"><rect width="7" height="9" rx="1.4" fill="#0b1113"/>${
  ["10001", "10001", "10001", "10011", "01101"]
    .flatMap((row, y) => [...row].map((c, x) => (c === "1" ? `<circle cx="${x + 1.5}" cy="${y + 2.5}" r="0.44" fill="#67dc91"/>` : "")))
    .join("")
}</svg>`;

const NPM_URL = "https://www.npmjs.com/package/@unstale/cli";

function copyable(cmd: string, extra = ""): string {
  return `<div class="cmd${extra}"><span class="dollar" aria-hidden="true">$</span><code>${esc(cmd)}</code><button type="button" class="copy" data-copy="${esc(cmd)}" aria-label="Copy command">Copy</button></div>`;
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
<footer class="wrap"><p>${wordmarkSvg("mark small")}<span>AGPL-3.0 · <a href="${REPO}">GitHub</a> · <a href="${NPM_URL}">npm</a> · <a href="${REPO}/blob/main/SECURITY.md">Security</a> · <a href="/llms.txt">llms.txt</a> · by <a href="https://vuca.dev">Jason Draper</a></span></p></footer>
<script src="/site.js" defer></script>
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
    `${p.count} changes in ${p.name} ${span(p)} from its official release notes, upgrade guides and advisories` +
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
  ["amber", "Priority · 31 advisory fixes match installed versions. Review these first."],
  ["", ""],
  ["accent", "Upgrades to review · 3 shortlisted"],
  ["body", "1. next 16.2.1 → 16.4.2 picks up 37 security, 90 fixes, 5 performance changes, 20 behaviour changes"],
  ["body", "2. prisma 6.19.3 → 7.10.0 picks up 8 security, 82 fixes, 8 performance changes · unlocks 52 optional capabilities"],
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
  return `<figure class="term"><pre>${rows}</pre><figcaption>Real <code>init</code> output on a Next.js and Prisma app, trimmed.</figcaption></figure>`;
}

const SUMMARY =
  "unstale tells you and your coding agent what changed upstream for your package versions and your code. Cited, local, free and open source.";

const EVAL = `${REPO}/blob/main/eval/gate/MISSES.md`;

export function homePage(pkgs: Package[], version?: string): string {
  const total = pkgs.reduce((n, p) => n + p.count, 0);
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
<h1>Your coding agent was trained before your packages' latest releases</h1>
<p class="lede">Releases come out faster than anyone can read them. unstale reads them for you, then tells you and
Claude Code, Codex or Cursor what changed for the versions in your lockfile and the code that uses them. Every item
cites its source. It runs on your machine, and it's free and open source.</p>
${copyable(INSTALL_NPX, " big")}
<p class="alt">${npmLink(version)} · or <code>${esc(INSTALL_BREW)}</code></p>
</section>
${terminal()}
<section class="prose">
<h2>What you get</h2>
<ul>
<li><strong>Your next major upgrade, mapped to your code.</strong> The breaking changes and deprecations you'll hit,
with the files that hit them, required work first.</li>
<li><strong>What each version bump fixes.</strong> Security advisories, bug fixes and behaviour changes between your
installed version and the next one.</li>
<li><strong>Features you could be using.</strong> APIs released since you wrote the code that could replace something
you built by hand.</li>
</ul>
<p>Every item links to the release note, guide or advisory it came from.</p>
<h2>How it works</h2>
<ol>
<li><strong>It reads your lockfile.</strong> npm and PyPI projects. npm has the deepest catalog today.</li>
<li><strong>It matches upstream changes to your code locally.</strong> Release notes, migration guides and advisories
are summarised once, centrally, into a signed catalog. The matching against your code happens on your machine.</li>
<li><strong>Your agent reviews it.</strong> You get a short report and a prompt to paste into Claude Code, Codex or
Cursor. In Claude Code, a line at session start tells you when something new applies, so you don't have to remember to
ask. If nothing upstream matters to your code, your agent hears nothing.</li>
</ol>
<h2>What leaves your machine</h2>
<p>Public package names (like <code>pkg:npm/next</code>) to fetch the changes that apply. Not your code, file paths,
versions or any ID. The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate
limits and count each address once per package, and never writes it to storage. No telemetry. To check advisories, the CLI sends the package names and versions your lockfiles resolve to
<a href="https://osv.dev">OSV</a>, as <code>npm audit</code> would, and it reads the public npm and PyPI registries.</p>
<h2>Does it work?</h2>
<p>We replayed 15 real Next.js, Prisma and NestJS upgrades from the commit before the maintainers did them. The
catalog had 60 of the 65 required changes that upstream documents (92%). The misses are public,
along with 29 changes the maintainers made that no release note mentions. <a href="${EVAL}">Method and results</a>.</p>
<h2>Free and open source</h2>
<p>AGPL-3.0. <a href="${REPO}">GitHub</a>.</p>
</section>
<section id="packages" class="packages prose">
<h2>What changed, by package</h2>
<p>${total.toLocaleString("en-US")} changes across ${pkgs.length} packages, each cited to its official source. Packages
your projects use are added on request.</p>
<input id="filter" type="search" placeholder="Filter packages" aria-label="Filter packages">
<ul class="pkgs" id="pkgs">${list}</ul>
</section>`;
  return layout({
    title: "unstale: what changed upstream that matters to your code, for coding agents",
    description: SUMMARY,
    path: "/",
    body,
    head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>\n<script>window.UNSTALE_GLYPHS=${JSON.stringify(GLYPHS)}</script>\n`,
  });
}

export function homeMarkdown(pkgs: Package[], version?: string): string {
  return `# unstale

> ${SUMMARY}

Install: \`${INSTALL_NPX}\` in a repository${version ? ` (\`@unstale/cli\` ${version}, ${NPM_URL})` : ""}, or \`${INSTALL_BREW}\`.

Releases come out faster than anyone can read them. unstale reads them for you, then tells you and Claude Code, Codex
or Cursor what changed for the versions in your lockfile and the code that uses them. Every item cites its source. It
runs on your machine, and it's free and open source.

## What you get

- Your next major upgrade, mapped to your code: the breaking changes and deprecations you'll hit, with the files that
  hit them, required work first.
- What each version bump fixes: security advisories, bug fixes and behaviour changes between your installed version
  and the next one.
- Features you could be using: APIs released since you wrote the code that could replace something you built by hand.

## How it works

1. It reads your lockfile. npm and PyPI projects; npm has the deepest catalog today.
2. It matches upstream changes to your code locally. Release notes, migration guides and advisories are summarised
   once, centrally, into a signed catalog; the matching against your code happens on your machine.
3. Your agent reviews it: a short report and a prompt to paste into Claude Code, Codex or Cursor. In Claude Code, a
   line at session start says when something new applies. If nothing upstream matters to your code, your agent hears
   nothing.

## What leaves your machine

Public package names (like \`pkg:npm/next\`) to fetch the changes that apply. Not your code, file paths, versions or
any ID. The service, hosted on Cloudflare, sees your IP address. It keeps it in memory only, to apply rate limits and count
each address once per package, and never writes it to storage.
No telemetry. To check advisories, the CLI sends the package names and versions your lockfiles resolve to OSV
(https://osv.dev), as \`npm audit\` would, and it reads the public npm and PyPI registries.

## Does it work?

We replayed 15 real Next.js, Prisma and NestJS upgrades from the commit before the maintainers did them. The catalog
had 60 of the 65 required changes that upstream documents (92%). The misses are public, along with
29 changes the maintainers made that no release note mentions: ${EVAL}

AGPL-3.0, free and open source: ${REPO}

## What changed, by package

${pkgs.map((p) => `- [${p.name}](${ORIGIN}${p.path}index.md): ${p.count} changes`).join("\n")}
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
- [Evaluation on real upgrades](${REPO}/blob/main/eval/gate/MISSES.md)
- [Home page as Markdown](${ORIGIN}/index.md)

## What changed, by package

${pkgs.map((p) => `- [${p.name}](${ORIGIN}${p.path}index.md): ${p.count} changes`).join("\n")}
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
  for (const f of ["site.css", "site.js"]) write(site, f, readFileSync(new URL(`./${f}`, import.meta.url), "utf8"));
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
