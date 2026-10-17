// Compressed-timeline test of the docs daily pass. For every package in the resolver sample whose docs history is in
// Git (a docs repo or repo docs directory from the resolver's validated pairs, or the README for README-only packages),
// replays the last N days one day at a time through the module's own normalisation, section diff, namespace and
// version-attribution rules, and measures what the daily pass would have recorded: events per day, the share of changed
// sections that carry a version, and how many changes are formatting, links or typos (the materiality question). No
// model calls. Clones are throwaway (blob-less, shallow) under --work.
//
//   cd central && npx tsx ../eval/docs-sources/replay.mts <out.json> [--days 90] [--work <dir>] [--only <substring>]
//
// Replay adaptations (the live pass sees URLs, not files): numeric ordering prefixes (`01-app`) are dropped from paths;
// Docusaurus `versioned_docs/` copies are skipped (the live site's version namespace excludes them); changelogs are not
// docs; the site's path prefix scopes a shared repo (Cloudflare's `/workers/`).
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { DEFAULT_HTTP, HttpClient } from "../../central/src/collector/http.ts";
import { normalize } from "../../central/src/collector/normalize.ts";
import { WatchSpec } from "../../central/src/collector/schema.ts";
import { allAdded, sectionDiff, type SectionChange } from "../../central/src/collector/sections.ts";
import { attribute, guideMajor, publishable, type Attribution } from "../../central/src/docs/attribute.ts";
import { editKind, type EditKind } from "../../central/src/docs/materiality.ts";
import { compact } from "../../central/src/docs/render.ts";
import { githubToken } from "../../central/src/docs/fetcher.ts";
import { findNamespaces, RELEASE_NOTES } from "../../central/src/docs/listing.ts";
import { latestVersion } from "../../central/src/docs/monitor.ts";
import { pool } from "../../central/src/pipeline/util.ts";
import { noiseOf, type Noise } from "./materiality.mts";

const run = promisify(execFile);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: "string", default: "90" }, work: { type: "string" }, only: { type: "string" }, keep: { type: "boolean", default: false } },
});
const OUT = positionals[0] ?? "replay-results.json";
const DAYS = Number(values.days);
const WORK = values.work ?? join(process.env.TMPDIR ?? "/tmp", "docs-replay");
mkdirSync(WORK, { recursive: true });
const TOKEN = githubToken();
const http = new HttpClient(DEFAULT_HTTP);
const MD_RULES = WatchSpec.parse({ id: "x", url: "https://x.invalid/", format: "markdown", normalize: { canonicalMarkdown: true, dropFrontMatter: true } }).normalize;
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
const START = new Date(today.getTime() - DAYS * 86_400_000);
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// ---------- targets from the resolver results ----------

interface Target { id: string; purls: string[]; repo: string; kind: "docs" | "readme"; dirs: string[]; prefix: string; readmeDir?: string }

function targets(): Target[] {
  const out = new Map<string, Target>();
  for (const f of ["stage1-results.json", "stage2-results.json", "stage3-results.json"]) {
    const rs: any[] = JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
    for (const r of rs) {
      const a = r.answer ?? {};
      const add = (t: Omit<Target, "id" | "purls">) => {
        const id = `${t.repo}:${t.kind === "readme" ? `README@${t.readmeDir ?? ""}` : `${t.dirs.join(",") || "."}${t.prefix}`}`;
        const x = out.get(id);
        if (x) x.purls.push(r.purl); // one state per source, shared by the packages that resolve to it
        else out.set(id, { id, purls: [r.purl], ...t });
      };
      if (a.kind === "site+repo") {
        for (const repo of String(a.repo).split(" ")) {
          const p = r.pairs.find((x: any) => x.repo === repo && x.validated) ?? r.pairs.find((x: any) => x.repo === repo);
          add({ repo, kind: "docs", dirs: p?.docDirs ?? [], prefix: sitePrefix(p?.site ?? a.site) });
        }
      } else if (a.kind === "repo-only") {
        add({ repo: a.repo, kind: "docs", dirs: a.dirs ?? [], prefix: "" });
      } else if (a.kind === "readme-only") {
        const repo = r.evidence?.pkgRepo?.full;
        if (repo) add({ repo, kind: "readme", dirs: [], prefix: "", readmeDir: r.evidence?.registry?.repository?.directory });
      }
    }
  }
  return [...out.values()].filter((t) => !values.only || t.id.includes(values.only));
}

/** The site's docs path prefix, as the resolver scopes a site: none on a docs.* host, else the first path segment. */
function sitePrefix(site: string): string {
  const u = new URL(site);
  const segs = u.pathname.split("/").filter(Boolean);
  return /^docs?\./.test(u.hostname) || !segs.length ? "" : "/" + segs[0];
}

// ---------- what counts as a docs file, and its page identity ----------

const DOC = /\.(md|mdx|markdown|rst)$/i;
const NOT_DOCS = /(^|\/)(node_modules|\.github|versioned_docs|versioned_sidebars)\/|(^|\/)(CHANGELOG|CHANGES|HISTORY|RELEASES?|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|LICENSE)[^/]*$/i;

/** The page path the live site would show: ordering prefixes dropped, extension and `index` removed. */
function pagePath(file: string): string {
  const segs = file.replace(DOC, "").split("/").map((s) => s.replace(/^\d+[-_.](?=\D)/, ""));
  if (/^(index|readme)$/i.test(segs.at(-1) ?? "")) segs.pop();
  return "/" + segs.join("/");
}

function scoper(files: string[], prefix: string, latestMajor: string | undefined) {
  const want = prefix.split("/").filter(Boolean);
  const has = (f: string) => {
    if (!want.length) return true;
    const segs = pagePath(f).split("/");
    return segs.some((_, i) => want.every((w, j) => segs[i + j] === w));
  };
  const docs = (f: string) => DOC.test(f) && !NOT_DOCS.test(f) && !RELEASE_NOTES.test(pagePath(f));
  const scoped = files.filter(docs);
  const inPrefix = scoped.filter(has);
  const base = inPrefix.length ? inPrefix : scoped; // a prefix the repo layout does not show scopes nothing
  const ns = findNamespaces(base.map(pagePath), latestMajor);
  const excluded = ns.filter((n) => !n.kept);
  const versionNs = ns.filter((n) => n.kept && n.kind === "version");
  const inScope = (f: string) => {
    if (!docs(f) || (inPrefix.length && !has(f))) return false;
    const segs = pagePath(f).split("/");
    return !excluded.some((n) => segs[n.position] === n.segment);
  };
  const namespaceMajor = (f: string) => {
    const segs = pagePath(f).split("/");
    return versionNs.find((n) => segs[n.position] === n.segment)?.segment.match(/^v?(\d+)/)?.[1];
  };
  const pages = base.filter(inScope);
  const parents = new Set(pages.map((f) => pagePath(f).split("/").slice(0, -1).join("/")));
  return { inScope, namespaceMajor, pages: pages.length, hasChildren: (f: string) => parents.has(pagePath(f)), namespaces: ns };
}

// ---------- records ----------

interface Sec {
  target: string; date: string; file: string; kind: string; path: string[]; status: string; attribution: Attribution; noise: Noise; chars: number; hunks?: string;
  /** The extraction body four ways, in characters: 3-line context or block context, plain or word-marked. */
  v?: { line3: number; line3w: number; block: number; blockw: number };
  /** The module's exact edit kind (docs/materiality.ts), beside the eval heuristic `noise`. */
  edit?: EditKind;
  /** Changed words missing from a word-marked body (should be 0), and block context lines ending in ":" that 3-line context lacks. */
  lost?: number; leadGain?: boolean;
  /** Block-context word-marked body, kept for publishable sections (the extraction input to compare). */
  blockw?: string;
}
interface TargetResult {
  id: string; purls: string[]; kind: string; latest?: string | undefined; pages: number; commitsInWindow: number;
  activeDays: number; events: Record<string, number>; suppressed: number; restructureDays: string[]; massEditDays: string[];
  sections: number; error?: string | undefined; namespaces?: string[]; ms: number;
}

function record(t: Target, date: string, file: string, kind: string, changes: SectionChange[], gm: string | undefined, nm: string | undefined, maxMajor: string | undefined, out: Sec[], blockChanges: SectionChange[] = changes) {
  changes.forEach((c, i) => {
    const attribution = attribute(c, { guideMajor: gm, namespaceMajor: nm, maxMajor });
    const b = blockChanges[i] && JSON.stringify(blockChanges[i]!.path) === JSON.stringify(c.path) ? blockChanges[i]! : c;
    const line3w = compact(c.hunks);
    const blockw = compact(b.hunks);
    const words = (h: string) => h.split("\n").filter((l) => /^[+-]/.test(l)).flatMap((l) => l.slice(1).match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
    const lost = [...new Set(words(c.hunks))].filter((w) => !line3w.includes(w)).length + [...new Set(words(b.hunks))].filter((w) => !blockw.includes(w)).length;
    const ctx = (h: string) => new Set(h.split("\n").filter((l) => l.startsWith(" ")).map((l) => l.slice(1)));
    const c3 = ctx(c.hunks);
    const leadGain = [...ctx(b.hunks)].some((l) => !c3.has(l) && /:\s*$/.test(l));
    out.push({
      target: t.id, date, file, kind, path: c.path, status: c.status, attribution, noise: noiseOf(c.hunks), chars: c.hunks.length,
      hunks: c.hunks.length < 6000 ? c.hunks : c.hunks.slice(0, 6000) + "\n…",
      v: { line3: c.hunks.length, line3w: line3w.length, block: b.hunks.length, blockw: blockw.length },
      edit: editKind(c), lost, leadGain,
      ...(publishable(attribution) ? { blockw } : {}),
    });
  });
}

const md = (s: string, file: string) => (/\.rst$/i.test(file) ? normalize(s, { ...MD_RULES, canonicalMarkdown: false }) : normalize(s, MD_RULES));

// ---------- docs repos: a blob-less shallow clone, one diff per day ----------

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run("git", args, { cwd, maxBuffer: 1 << 30, encoding: "utf8" })).stdout;
}

function catBlobs(cwd: string, oids: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["cat-file", "--batch"], { cwd });
    const chunks: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => chunks.push(b));
    p.on("error", reject);
    p.on("close", () => {
      const buf = Buffer.concat(chunks);
      const out = new Map<string, string>();
      let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i);
        const [oid, type, size] = buf.subarray(i, nl).toString().split(" ");
        if (type === "missing") { i = nl + 1; continue; }
        const n = Number(size);
        out.set(oid!, buf.subarray(nl + 1, nl + 1 + n).toString("utf8"));
        i = nl + 1 + n + 1;
      }
      resolve(out);
    });
    p.stdin.end(oids.join("\n") + "\n");
  });
}

const ZERO = /^0+$/;

async function replayRepo(t: Target, maxMajor: string | undefined, latest: string | undefined, secs: Sec[]): Promise<TargetResult> {
  const t0 = Date.now();
  const dir = join(WORK, t.id.replace(/[^\w.-]+/g, "_")); // per source: two sources in one repo must not share a clone
  const res: TargetResult = { id: t.id, purls: t.purls, kind: t.kind, latest, pages: 0, commitsInWindow: 0, activeDays: 0, events: {}, suppressed: 0, restructureDays: [], massEditDays: [], sections: 0, ms: 0 };
  rmSync(dir, { recursive: true, force: true });
  const since = new Date(START.getTime() - 45 * 86_400_000).toISOString();
  await run("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", "--single-branch", `--shallow-since=${since}`, `https://github.com/${t.repo}.git`, dir], { maxBuffer: 1 << 26 });
  const specs = (t.dirs.length ? t.dirs : ["."]).flatMap((d) => ["md", "mdx", "markdown", "rst"].map((e) => `:(glob)${d === "." ? "" : d + "/"}**/*.${e}`));
  const files = (await git(dir, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...(t.dirs.length ? t.dirs : ["."])])).split("\n").filter(Boolean);
  const scope = scoper(files, t.prefix, maxMajor);
  res.pages = scope.pages;
  res.namespaces = scope.namespaces.map((n) => `${n.kept ? "+" : "-"}${n.kind}:${n.segment}@${n.position}(${n.pages}, mirror ${n.mirror})`);
  let base = "";
  for (let i = 0; i < 6 && !base; i++) {
    base = (await git(dir, ["rev-list", "-1", "--first-parent", `--before=${START.toISOString()}`, "HEAD"])).trim();
    if (!base) await git(dir, ["fetch", "-q", "--filter=blob:none", "--deepen=100"]); // a quiet repo: reach back to the day-0 state
  }
  const log = (await git(dir, ["log", "--first-parent", "--format=%H %cI", `--since=${START.toISOString()}`, "HEAD", "--", ...specs])).split("\n").filter(Boolean);
  res.commitsInWindow = log.length;
  const lastOfDay = new Map<string, string>();
  for (const line of log) { const [sha, iso] = line.split(" "); const d = day(iso!); if (!lastOfDay.has(d)) lastOfDay.set(d, sha!); }
  let prev = base;
  if (!prev) throw new Error("no commit before the window (shallow boundary)");
  for (const [d, cur] of [...lastOfDay].sort(([a], [b]) => a.localeCompare(b))) {
    const from0 = prev;
    const raw = (await git(dir, ["diff", "--raw", "-z", "-M", "--no-abbrev", from0, cur, "--", ...specs])).split("\0");
    const entries: Array<{ status: string; a: string; b: string; from: string; to: string }> = [];
    for (let i = 0; i < raw.length - 1; ) {
      const head = raw[i++]!;
      if (!head.startsWith(":")) continue;
      const [, , a, b, status] = head.slice(1).split(" ");
      const from = raw[i++]!;
      const to = /^[RC]/.test(status!) ? raw[i++]! : from;
      if (!scope.inScope(from) && !scope.inScope(to)) continue;
      entries.push({ status: status!, a: a!, b: b!, from, to });
    }
    prev = cur;
    if (!entries.length) continue;
    res.activeDays++;
    // Fetch the day's blobs in one batch (a patch diff prefetches both sides), then read them locally.
    await run("git", ["--literal-pathspecs", "diff", "-M", "-p", "--output=/dev/null", from0, cur, "--", ...entries.flatMap((e) => [e.from, e.to])], { cwd: dir, maxBuffer: 1 << 28 }).catch(() => {});
    const blobs = await catBlobs(dir, entries.flatMap((e) => [e.a, e.b]).filter((o) => !ZERO.test(o)));
    const gone = entries.filter((e) => e.status === "D" || e.status.startsWith("R")).length;
    if (gone > Math.max(20, 0.3 * scope.pages)) {
      res.restructureDays.push(d);
      res.events.restructure = (res.events.restructure ?? 0) + 1;
      continue; // one restructure event; the new pages are baselined
    }
    if (entries.length > Math.max(20, 0.3 * scope.pages)) res.massEditDays.push(d); // a site-wide edit: one review, not N
    for (const e of entries) {
      const before = ZERO.test(e.a) ? undefined : md(blobs.get(e.a) ?? "", e.from);
      const after = ZERO.test(e.b) ? undefined : md(blobs.get(e.b) ?? "", e.to);
      const kind = e.status === "A" || e.status.startsWith("C") ? "created" : e.status === "D" ? "deleted" : e.status.startsWith("R") ? "moved" : "modified";
      const changes = kind === "created" ? allAdded(after ?? "") : kind === "deleted" ? sectionDiff(before ?? "", "") : sectionDiff(before ?? "", after ?? "");
      const blockChanges = kind === "modified" || kind === "moved" ? sectionDiff(before ?? "", after ?? "", "block") : changes;
      if (!changes.length) { res.suppressed++; continue; } // normalisation removed the change (front matter, whitespace)
      res.events[kind] = (res.events[kind] ?? 0) + 1;
      const file = e.to;
      const gm = scope.hasChildren(file) ? undefined : guideMajor(`https://repo.invalid${pagePath(file)}`, after ?? before);
      record(t, d, file, kind, changes, gm, scope.namespaceMajor(file), maxMajor, secs, blockChanges);
    }
  }
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  res.ms = Date.now() - t0;
  return res;
}

// ---------- READMEs: the GitHub API, one file, no clone ----------

async function gh(path: string): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "unstale-docs-replay", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${path}`);
  return r.json();
}

async function replayReadme(t: Target, maxMajor: string | undefined, latest: string | undefined, secs: Sec[]): Promise<TargetResult> {
  const t0 = Date.now();
  const res: TargetResult = { id: t.id, purls: t.purls, kind: t.kind, latest, pages: 1, commitsInWindow: 0, activeDays: 0, events: {}, suppressed: 0, restructureDays: [], massEditDays: [], sections: 0, ms: 0 };
  const readme = await gh(`/repos/${t.repo}/readme${t.readmeDir ? "/" + t.readmeDir : ""}`);
  const path: string = readme.path;
  const commits: any[] = [];
  for (let page = 1; page < 10; page++) {
    const batch: any[] = await gh(`/repos/${t.repo}/commits?path=${encodeURIComponent(path)}&since=${START.toISOString()}&per_page=100&page=${page}`);
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  res.commitsInWindow = commits.length;
  if (!commits.length) { res.ms = Date.now() - t0; return res; }
  const [base] = await gh(`/repos/${t.repo}/commits?path=${encodeURIComponent(path)}&until=${START.toISOString()}&per_page=1`);
  const raw = async (sha: string) => {
    const r = await fetch(`https://raw.githubusercontent.com/${t.repo}/${sha}/${path}`);
    return r.ok ? md(await r.text(), path) : undefined;
  };
  const lastOfDay = new Map<string, string>();
  for (const c of commits) { const d = day(c.commit.committer.date); if (!lastOfDay.has(d)) lastOfDay.set(d, c.sha); }
  let before = base ? await raw(base.sha) : undefined;
  for (const [d, sha] of [...lastOfDay].sort(([a], [b]) => a.localeCompare(b))) {
    const after = await raw(sha);
    if (after === undefined) continue;
    const changes = before === undefined ? allAdded(after) : sectionDiff(before, after);
    const blockChanges = before === undefined ? changes : sectionDiff(before, after, "block");
    before = after;
    res.activeDays++;
    if (!changes.length) { res.suppressed++; continue; }
    res.events.modified = (res.events.modified ?? 0) + 1;
    record(t, d, path, "modified", changes, undefined, undefined, maxMajor, secs, blockChanges);
  }
  res.ms = Date.now() - t0;
  return res;
}

// ---------- run ----------

const list = targets();
console.error(`${list.length} sources (${list.filter((t) => t.kind === "docs").length} docs repos, ${list.filter((t) => t.kind === "readme").length} READMEs), ${DAYS} days from ${day(START.toISOString())}`);
const secs: Sec[] = [];
const results = await pool(list, 4, async (t) => {
  const latest = await latestVersion(http, t.purls[0]!.replace("%40", "@"));
  const maxMajor = latest?.split(".")[0];
  try {
    const r = await (t.kind === "readme" ? replayReadme(t, maxMajor, latest, secs) : replayRepo(t, maxMajor, latest, secs));
    r.sections = secs.filter((s) => s.target === t.id).length;
    console.error(`${t.id}: ${r.commitsInWindow} commits, ${r.activeDays} active days, ${JSON.stringify(r.events)}, ${r.sections} sections (${(r.ms / 1000).toFixed(0)} s)`);
    return r;
  } catch (e) {
    console.error(`${t.id}: ${(e as Error).message.split("\n")[0]}`);
    return { id: t.id, purls: t.purls, kind: t.kind, latest, pages: 0, commitsInWindow: 0, activeDays: 0, events: {}, suppressed: 0, restructureDays: [], massEditDays: [], sections: 0, error: (e as Error).message.split("\n")[0], ms: 0 } satisfies TargetResult;
  }
});
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), days: DAYS, start: day(START.toISOString()), results, sections: secs }, null, 1) + "\n");
console.error(`wrote ${OUT}: ${secs.length} sections`);
