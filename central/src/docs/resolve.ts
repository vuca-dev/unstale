// Docs source resolution (vault: Source Registry and Coverage, "Docs sources traced from the package"; measured in
// Docs Sources - Eval D1: 90 % out of sample, no validated pair wrong). A deterministic chain from a package URL to its
// official docs site(s) and docs repositories, each with the step that named it and a validation verdict. No model
// calls and no web search. Ported unchanged from eval/docs-sources/resolve.mts; HTTP goes through a `Fetcher` so the
// eval replays its cache and the module uses the polite client.
import { createHash } from "node:crypto";
import { isRepoSlug } from "../pipeline/util.ts";

/** A response as the resolver reads it: any status (0 for a network failure), the final URL, the body as text. */
export interface Res { status: number; url: string; text: string }

export interface Fetcher {
  /** Requests made so far (cache hits excluded). */
  readonly requests: number;
  /** `gh`: send the GitHub token (api.github.com only). A `#retry` suffix asks for a fresh attempt. */
  get(url: string, accept?: string, gh?: boolean): Promise<Res>;
}

export type Resolution = Awaited<ReturnType<ReturnType<typeof createResolver>["resolve"]>>;

export function createResolver(f: Fetcher) {
  const get = (url: string, accept = "text/html,*/*;q=0.8", gh = false) => f.get(url, accept, gh);

  async function ghApi<T>(path: string): Promise<T | undefined> {
    const r = await get(`https://api.github.com/${path}`, "application/vnd.github+json", true);
    return r.status === 200 ? (JSON.parse(r.text) as T) : undefined;
  }
  const CODE_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sourceforge\.net|www\.npmjs\.com|npmjs\.com|pypi\.org|crates\.io|lib\.rs|travis-ci\.|img\.shields\.io|badge|coveralls|codecov|opencollective|twitter\.com|x\.com|discord|gitter|github\.io$)/;
  const isCodeHost = (h: string) => CODE_HOSTS.test(h) || /(^|\.)(npmjs|shields|codecov|coveralls|opencollective|discord|gitter|twitter|bundlephobia|packagephobia|snyk|deps\.dev|libraries\.io|badgen|circleci|travis-ci|appveyor|jsdelivr|unpkg|discord\.gg)\b/.test(h);
  const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

  interface Repo { host: string; owner: string; name: string; directory?: string | undefined }
  function parseRepo(u: string | undefined, directory?: string): Repo | undefined {
    if (!u) return undefined;
    const m = /(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(u);
    if (m) return m[1] !== "github.com" || isRepoSlug(`${m[2]}/${m[3]}`) ? { host: m[1]!, owner: m[2]!, name: m[3]!, directory } : undefined;
    const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(u); // npm shorthand "owner/name"
    if (short) return isRepoSlug(u.replace(/^github:/, "")) ? { host: "github.com", owner: short[1]!, name: short[2]!, directory } : undefined;
    return u.includes("sourceforge") ? { host: "sourceforge.net", owner: "", name: u } : undefined;
  }

  // Registry adapters: one per ecosystem, reading the ecosystem's own vocabulary.
  interface Registry { homepage?: string | undefined; docs?: string[] | undefined; repo?: Repo | undefined; readme?: string | undefined; raw: Record<string, unknown> }
  async function registry(purl: string): Promise<Registry> {
    const [, type, rest] = /^pkg:(\w+)\/(.+)$/.exec(purl)!;
    const name = decodeURIComponent(rest!);
    if (type === "npm") {
      let r = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, "application/json");
      if (r.status !== 200) r = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest#retry`, "application/json");
      const j = r.status === 200 ? JSON.parse(r.text) : {};
      const repo = typeof j.repository === "string" ? j.repository : j.repository?.url;
      return { homepage: j.homepage, repo: parseRepo(repo, j.repository?.directory), raw: { homepage: j.homepage, repository: j.repository } };
    }
    if (type === "pypi") {
      const r = await get(`https://pypi.org/pypi/${name}/json`, "application/json");
      const i = r.status === 200 ? JSON.parse(r.text).info : {};
      const urls: Record<string, string> = i.project_urls ?? {};
      const docs = Object.entries(urls).filter(([k]) => /doc/i.test(k)).map(([, v]) => v);
      const src = Object.entries(urls).find(([k]) => /source|code|repo|github/i.test(k))?.[1]
        ?? Object.values(urls).find((v) => /github\.com|gitlab\.com|sourceforge/.test(v));
      return { homepage: i.home_page || urls.Homepage || urls.homepage, docs, repo: parseRepo(src), readme: i.description, raw: { project_urls: urls, home_page: i.home_page } };
    }
    if (type === "cargo") {
      const r = await get(`https://crates.io/api/v1/crates/${name}`, "application/json");
      const c = r.status === 200 ? JSON.parse(r.text).crate : {};
      return { homepage: c.homepage, docs: [c.documentation || `https://docs.rs/${name}`], repo: parseRepo(c.repository), raw: { homepage: c.homepage, documentation: c.documentation, repository: c.repository } };
    }
    throw new Error("no adapter for " + type);
  }

  // Repository names are aliases (renames, transfers): compare by the API's canonical full name.
  const canonMemo = new Map<string, string>();
  async function canon(full: string): Promise<string> {
    const k = full.toLowerCase();
    if (!canonMemo.has(k)) canonMemo.set(k, ((await ghApi<{ full_name: string }>(`repos/${full}`))?.full_name ?? full).toLowerCase());
    return canonMemo.get(k)!;
  }
  interface GhRepo { full_name: string; homepage: string | null; default_branch: string; has_wiki: boolean; has_pages: boolean; archived: boolean }
  interface Tree { paths: string[]; truncated: boolean }
  async function repoTree(full: string, branch: string): Promise<Tree> {
    const t = await ghApi<{ tree: Array<{ path: string; type: string; sha: string }>; truncated: boolean }>(`repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (!t) return { paths: [], truncated: false };
    if (!t.truncated) return { paths: t.tree.map((x) => x.path), truncated: false };
    // Large repository: top level, then the subtrees whose names look like docs.
    const top = await ghApi<{ tree: Array<{ path: string; type: string; sha: string }> }>(`repos/${full}/git/trees/${encodeURIComponent(branch)}`);
    const paths = (top?.tree ?? []).map((x) => x.path);
    for (const d of (top?.tree ?? []).filter((x) => x.type === "tree" && /^(docs?|documentation|website|site|apps)$/.test(x.path))) {
      const sub = await ghApi<{ tree: Array<{ path: string }> }>(`repos/${full}/git/trees/${d.sha}?recursive=1`);
      for (const x of sub?.tree ?? []) paths.push(d.path + "/" + x.path);
    }
    return { paths, truncated: true };
  }

  const CONFIG = /(^|\/)(docusaurus\.config\.(js|ts|mjs|cjs)|mkdocs\.ya?ml|conf\.py|\.vitepress\/config\.(js|ts|mjs|mts)|astro\.config\.(mjs|js|ts)|mint\.json|docs\.json|book\.toml|theme\.config\.(tsx|jsx|js)|source\.config\.ts|CNAME|_config\.yml|antora\.yml|\.readthedocs\.ya?ml|next\.config\.(js|mjs|ts))$/;
  const DOCDIR = /^(docs?|documentation|website|site|apps\/(docs|web|www|website)|src\/content\/docs|content|pages)\//;
  function framework(p: string): string {
    if (/docusaurus/.test(p)) return "docusaurus"; if (/mkdocs/.test(p)) return "mkdocs"; if (/conf\.py$/.test(p)) return "sphinx";
    if (/vitepress/.test(p)) return "vitepress"; if (/astro\.config/.test(p)) return "astro"; if (/mint\.json|docs\.json/.test(p)) return "mintlify";
    if (/book\.toml/.test(p)) return "mdbook"; if (/theme\.config/.test(p)) return "nextra"; if (/source\.config/.test(p)) return "fumadocs";
    if (/_config\.yml/.test(p)) return "jekyll"; if (/antora/.test(p)) return "antora"; if (/readthedocs/.test(p)) return "readthedocs";
    if (/CNAME/.test(p)) return "cname"; return "other";
  }
  interface RepoDocs { full: string; homepage?: string | undefined; branch: string; docFiles: number; allDocFiles: number; docDirs: string[]; configs: Array<{ path: string; framework: string; hosts: string[] }>; hasWiki: boolean }
  async function repoDocs(full: string): Promise<RepoDocs | undefined> {
    const meta = await ghApi<GhRepo>(`repos/${full}`);
    if (!meta) return undefined;
    const tree = await repoTree(meta.full_name, meta.default_branch);
    const docs = tree.paths.filter((p) => (/\.(mdx?|rst|adoc)$/.test(p) || (/\.txt$/.test(p) && DOCDIR.test(p))) && !/node_modules|CHANGELOG|LICENSE|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY|\.github\//i.test(p));
    const inDir = docs.filter((p) => DOCDIR.test(p) || /(^|\/)(docs?|documentation)\//.test(p));
    const dirs = [...new Set(inDir.map((p) => p.split("/").slice(0, p.startsWith("apps/") ? 2 : 1).join("/")))].sort();
    const configPaths = tree.paths.filter((p) => CONFIG.test(p) && !/node_modules|examples?\/|test|fixtures?\//i.test(p)).sort((a, b) => a.split("/").length - b.split("/").length).slice(0, 6);
    const configs = [];
    for (const p of configPaths) {
      const raw = await get(`https://raw.githubusercontent.com/${meta.full_name}/${meta.default_branch}/${p}`, "text/plain");
      const text = raw.status === 200 ? raw.text : "";
      const hosts = /CNAME$/.test(p) ? [text.trim().replace(/^www\./, "")].filter(Boolean)
        : [...new Set([...text.matchAll(/\b(?:url|site_url|siteUrl|site|html_baseurl|baseURL|hostname|canonical)\s*[:=]\s*['"`](https?:\/\/[^'"`\s]+)/gi)].map((m) => host(m[1]!)).filter((h) => h && !isCodeHost(h)))];
      configs.push({ path: p, framework: framework(p), hosts });
    }
    return { full: meta.full_name, homepage: meta.homepage ?? undefined, branch: meta.default_branch, docFiles: inDir.length, allDocFiles: docs.length, docDirs: dirs, configs, hasWiki: meta.has_wiki };
  }

  interface Site { url: string; final: string; status: number; entry?: string | undefined; generator?: string | undefined; editRepos: string[]; repoLinks: string[]; sitemapPages: number; samples: string[]; versioned: string[]; prefix: string }
  function editLinks(html: string): Array<{ repo: string; kind: string; branch: string; path: string }> {
    const all = [...html.matchAll(/(["'=\s])https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(edit|blob|tree)\/([\w.-]+)\/([^"'#?<>]+?)(?=["'#?<>]|\s[\w-]+=|>|$)/gm)]
      .map((m) => ({ repo: m[2]!, kind: m[3]!, branch: m[4]!, path: decodeURIComponent(m[5]!.trim()).replace(/^website\/\.\.\//, "") }))
      .filter((e) => isRepoSlug(e.repo) && !/(^|\/)(CODE_OF_CONDUCT|CHANGELOG|LICENSE|CONTRIBUTING|SECURITY|README)(\.md)?$|(^|\/)(examples?|releases)(\/|$)/i.test(e.path));
    const edit = all.filter((e) => e.kind === "edit");
    return edit.length ? edit : all.filter((e) => /\.(mdx?|rst|txt|adoc)$/.test(e.path));
  }
  const DOCSY = /(^|[./])(docs?|documentation|guides?|reference|learn|manual|api)([./-]|$)/i;
  const site2 = (h: string) => h.split(".").slice(-2).join(".");
  async function probeSite(url: string, depth = 0, pkgName = ""): Promise<Site> {
    const r = await get(url);
    const html = r.status === 200 ? r.text : "";
    // A product homepage: follow its own link to the docs entry (docs.<same domain>, or /docs on the same host).
    const here = new URL(r.url || url);
    const redirected = host(url) !== host(here.href);
    if (depth === 0 && r.status === 200 && (redirected || here.pathname.replace(/\/$/, "") === "") && !DOCSY.test(here.hostname)) {
      const hrefs = [...html.matchAll(/href=["']([^"'#]+)["']/g)].map((m) => { try { return new URL(m[1]!, here); } catch { return undefined; } }).filter(Boolean) as URL[];
      const base = redirected ? "" : here.pathname.replace(/\/$/, "");
      const entry = (redirected ? hrefs.find((u) => host(u.href) === host(url) && DOCSY.test(u.pathname)) : undefined) ?? (base ? hrefs.find((u) => u.hostname === here.hostname && u.pathname.startsWith(base + "/") && DOCSY.test(u.pathname.slice(base.length))) : undefined)
        ?? hrefs.find((u) => u.hostname !== here.hostname && site2(u.hostname) === site2(here.hostname) && /^docs?\./.test(u.hostname))
        ?? (!base ? hrefs.find((u) => u.hostname === here.hostname && /^\/(docs?|documentation)(\/|$)/.test(u.pathname)) : undefined);
      if (entry) return { ...(await probeSite(entry.origin + entry.pathname, 1, pkgName)), url, entry: entry.origin + entry.pathname };
    }
    const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.exec(html)?.[1];
    const edits = editLinks(html);
    const repoLinks = [...new Set([...html.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?["'/]/g)].map((m) => m[1]!))].filter(isRepoSlug);
    // Page listing: robots.txt Sitemap lines, then /sitemap.xml at the docs path and at the origin.
    const origin = new URL(r.url || url);
    const robots = await get(new URL("/robots.txt", origin).href, "text/plain");
    const sitemaps = [...(robots.status === 200 ? robots.text : "").matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
    const base = origin.pathname.replace(/\/[^/]*$/, "/");
    sitemaps.push(new URL(base + "sitemap.xml", origin).href, new URL("/sitemap.xml", origin).href, new URL("/sitemap-index.xml", origin).href);
    const pages = new Set<string>(); const seen = new Set<string>(); const todo = [...new Set(sitemaps)];
    while (todo.length && seen.size < 25) {
      const s = todo.shift()!; if (seen.has(s)) continue; seen.add(s);
      const x = await get(s, "application/xml,text/xml");
      if (x.status !== 200 || !/<(urlset|sitemapindex)/.test(x.text)) continue;
      const locs = [...x.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
      if (/<sitemapindex/.test(x.text)) todo.push(...locs.filter((l) => host(l) === host(origin.href)));
      else for (const l of locs) if (host(l) === host(origin.href)) pages.add(l);
    }
    if (!pages.size) {
      const l = await get(new URL("/llms.txt", origin).href, "text/plain");
      if (l.status === 200) for (const m of l.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (host(m[1]!) === host(origin.href)) pages.add(m[1]!.replace(/\.md$/, ""));
    }
    // Scope: the docs root (the path up to its first docs-like segment), or nothing on a docs.* host.
    const segs = origin.pathname.split("/").filter(Boolean);
    const k = segs.findIndex((x) => DOCSY.test(x));
    const own = pkgName && segs[0]?.toLowerCase() === pkgName.toLowerCase();
    const prefix = own ? "/" + segs[0] : /^docs?\./.test(origin.hostname) ? "" : segs.length ? "/" + segs.slice(0, k >= 0 ? k + 1 : 1).join("/") : "";
    const inScope = (p: string) => { const x = new URL(p).pathname; return !prefix || x === prefix || x.startsWith(prefix + "/"); };
    if ([...pages].filter(inScope).length < 5) for (const m of html.matchAll(/href=["']?([^"'#?\s>]+)/g)) {
      try { const u = new URL(m[1]!, origin); if (u.hostname === origin.hostname && inScope(u.href) && !/\.(css|js|png|svg|ico|xml|json)$/.test(u.pathname)) pages.add(u.origin + u.pathname); } catch { /* skip */ }
    }
    const scoped = [...pages].filter((p) => inScope(p) && new URL(p).pathname !== origin.pathname).sort();
    const pick = scoped.length ? [0.15, 0.35, 0.5, 0.65, 0.85].map((f) => scoped[Math.floor(f * (scoped.length - 1))]!) : [];
    const versioned = [...new Set(scoped.map((p) => /\/(v\d+(?:\.\d+)?|\d+\.(?:x|\d+))\//.exec(new URL(p).pathname)?.[1]).filter(Boolean) as string[])].sort().slice(0, 8);
    const perPage = [new Set(edits.map((e) => e.repo.toLowerCase()))];
    for (const p of new Set(pick)) {
      const x = await get(p);
      if (x.status !== 200) continue;
      perPage.push(new Set(editLinks(x.text).map((e) => e.repo.toLowerCase())));
      for (const m of x.text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?["'/]/g)) if (isRepoSlug(m[1]!) && !repoLinks.includes(m[1]!)) repoLinks.push(m[1]!);
    }
    const counts = new Map<string, number>();
    for (const set of perPage) for (const r of set) counts.set(r, (counts.get(r) ?? 0) + 1);
    const editRepos = [...new Set(await Promise.all([...counts].filter(([, n]) => n >= Math.min(2, perPage.length)).map(([r]) => canon(r))))];
    return { url, final: r.url, status: r.status, generator: gen, editRepos, repoLinks, sitemapPages: scoped.length, samples: [...new Set(pick)], versioned, prefix };
  }

  // Content check: share of a source file's words that appear on the rendered page (page chrome cannot lower it).
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []);
  function pageText(html: string) {
    return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  }
  function sourceText(src: string) {
    return src.replace(/^---[\s\S]*?\n---/, " ").replace(/^(import|export) .*$/gm, " ").replace(/<\/?[A-Z][^>]*>/g, " ").replace(/```[^\n]*/g, " ");
  }
  // A page passes when its file covers it (>= 0.9) or clearly beats a control file from the same repository, so generic
  // vocabulary overlap cannot pass a wrong file. A page with almost no text (JavaScript-only site) is unverifiable.
  interface Check { page: string; file?: string | undefined; coverage?: number | undefined; control?: number | undefined; via: string; pass: boolean; verifiable: boolean }
  async function contentCheck(samples: string[], repo: RepoDocs): Promise<Check[]> {
    const out: Check[] = [];
    const tree = await repoTree(repo.full, repo.branch);
    const locale = (p: string) => /(^|\/)(?!en\/)[a-z]{2}(-[a-zA-Z]{2,4})?\//.test(p.replace(/^(docs?|src|content|website|apps)\//, "")) ? 1 : 0;
    const cand = tree.paths.filter((p) => /\.(mdx?|rst|txt)$/.test(p) && !/(^|\/)(CHANGELOG|LICENSE|CODE_OF_CONDUCT)/i.test(p)).sort((a, b) => locale(a) - locale(b) || a.length - b.length);
    const cover = async (file: string, pw: Set<string>) => {
      const raw = await get(`https://raw.githubusercontent.com/${repo.full}/${repo.branch}/${file}`, "text/plain");
      const fw = words(sourceText(raw.status === 200 ? raw.text : ""));
      return fw.size ? [...fw].filter((w) => pw.has(w)).length / fw.size : 0;
    };
    for (const page of samples) {
      const r = await get(page);
      const html = r.status === 200 ? r.text : "";
      const pw = words(pageText(html));
      if (pw.size < 80) { out.push({ page, via: "no-text", pass: false, verifiable: false }); continue; }
      // A site built from several repositories: a page whose edit link names another repository is that one's page.
      const pageEdits = editLinks(html).filter((x) => x.kind === "edit");
      const mine = repo.full.toLowerCase();
      const pageRepos = await Promise.all(pageEdits.map((x) => canon(x.repo)));
      if (pageEdits.length && !pageRepos.includes(mine)) { out.push({ page, via: "other-repo", pass: false, verifiable: false }); continue; }
      const files: Array<[string, string]> = [];
      const e = pageEdits.find((_, i) => pageRepos[i] === mine)?.path ?? editLinks(html).find((x) => x.repo.toLowerCase() === mine)?.path;
      if (e && tree.paths.includes(e)) files.push([e, "edit-link"]);
      const segs = new URL(page).pathname.replace(/\/$/, "").replace(/\.html$/, "").split("/").filter(Boolean);
      for (let k = Math.min(3, segs.length); k >= 1; k--) {
        const tail = segs.slice(-k).join("/");
        const f = cand.find((p) => p.replace(/\.(mdx?|rst|txt)$/, "").replace(/(^|\/)\d+-/g, "$1").endsWith(tail))
          ?? cand.find((p) => p.replace(/\/(index|README)\.(mdx?|rst|txt)$/i, "").replace(/(^|\/)\d+-/g, "$1").endsWith(tail));
        if (f) { files.push([f, "path-match"]); break; }
      }
      if (!files.length) { out.push({ page, via: "no-file", pass: false, verifiable: true }); continue; }
      let best = { file: "", via: "", coverage: -1 };
      for (const [f, via] of files) { const c = await cover(f, pw); if (c > best.coverage) best = { file: f, via, coverage: c }; }
      const others = cand.filter((p) => p !== best.file && p.split("/")[0] === best.file.split("/")[0]);
      const ctrlFile = others[parseInt(createHash("sha256").update(page).digest("hex").slice(0, 8), 16) % Math.max(1, others.length)];
      const control = ctrlFile ? await cover(ctrlFile, pw) : 0;
      const r2 = (x: number) => Math.round(x * 100) / 100;
      out.push({ page, file: best.file, via: best.via, coverage: r2(best.coverage), control: r2(control), verifiable: true,
        pass: best.coverage >= 0.9 || (best.coverage >= 0.5 && best.coverage - control >= 0.25) });
    }
    return out;
  }

  function readmeDocLinks(md: string): string[] {
    const links = [
      ...[...md.matchAll(/\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => ({ text: m[1]!, url: m[2]! })),
      ...[...md.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/g)].map((m) => ({ text: m[2]!, url: m[1]! })),
    ];
    return [...new Set(links.filter((l) => /doc|guide|reference|manual|api|website|learn/i.test(l.text) && !isCodeHost(host(l.url))).map((l) => l.url))];
  }
  const byHostHas = (cands: Array<{ url: string }>, u: string) => cands.some((c) => host(c.url) === host(u));

  async function resolve(purl: string) {
    const before = f.requests;
    const reg = await registry(purl);
    const ev: Record<string, unknown> = { registry: reg.raw };
    // The package's own repository (renames resolved by the API).
    let pkgRepo: RepoDocs | undefined;
    if (reg.repo?.host === "github.com") pkgRepo = await repoDocs(`${reg.repo.owner}/${reg.repo.name}`);
    let readme = reg.readme ?? "";
    if (!readme && !pkgRepo && purl.startsWith("pkg:npm/")) {
      const r = await get(`https://registry.npmjs.org/${decodeURIComponent(purl.slice(8)).replace("/", "%2f")}`, "application/json");
      readme = r.status === 200 ? (JSON.parse(r.text).readme ?? "") : "";
    }
    if (!readme && pkgRepo) {
      const r = await get(`https://api.github.com/repos/${pkgRepo.full}/readme`, "application/vnd.github.raw", true);
      readme = r.status === 200 ? r.text : "";
    }
    // Candidate docs sites, each with the step that named it.
    const cands: Array<{ url: string; from: string }> = [];
    for (const d of reg.docs ?? []) cands.push({ url: d, from: "registry-docs-field" });
    if (reg.homepage && !isCodeHost(host(reg.homepage))) cands.push({ url: reg.homepage, from: "registry-homepage" });
    if (pkgRepo?.homepage && !isCodeHost(host(pkgRepo.homepage))) cands.push({ url: pkgRepo.homepage, from: "repo-homepage" });
    for (const c of pkgRepo?.configs ?? []) for (const h of c.hosts) cands.push({ url: `https://${h}/`, from: `repo-config:${c.path}` });
    // README links are kept only if they stay on the publisher's own domain or the site links back to the repository
    // (checked after probing). Unchecked, every README-only site answer in stage 2 was wrong.
    for (const u of readmeDocLinks(readme).slice(0, 4)) if (!byHostHas(cands, u)) cands.push({ url: u, from: "readme-link" });
    const byHost = new Map<string, { url: string; from: string[] }>();
    for (const c of cands) {
      const h = host(c.url); if (!h) continue;
      const e = byHost.get(h); if (e) e.from.push(c.from); else byHost.set(h, { url: c.url, from: [c.from] });
    }
    const owner = pkgRepo ? await ghApi<{ blog?: string }>(`users/${pkgRepo.full.split("/")[0]}`) : undefined;
    const declared = new Set([reg.homepage, ...(reg.docs ?? []), pkgRepo?.homepage, owner?.blog].filter(Boolean).map((u) => host(/^https?:/.test(u!) ? u! : "https://" + u)));
    const declaredDomains = new Set([...declared].filter((h) => !isCodeHost(h) && site2(h) !== "github.com").map(site2)); // a code host is nobody's publisher domain
    // Probe up to 3 candidate hosts, strongest first (registry docs field, then hosts named by several signals).
    const ranked = [...byHost.entries()].sort((a, b) =>
      Number(b[1].from.includes("registry-docs-field")) - Number(a[1].from.includes("registry-docs-field")) || b[1].from.length - a[1].from.length).slice(0, 3);
    const sites: Array<Site & { from: string[] }> = [];
    const pkgName = decodeURIComponent(purl.split("/").at(-1)!);
    for (const [, c] of ranked) {
      const probed = { ...(await probeSite(c.url, 0, pkgName)), from: c.from };
      const onlyReadme = c.from.every((f) => f === "readme-link");
      // A README link counts when it stays on the publisher's domain, or the site itself links to that domain (a
      // product's platform docs link their company; third-party mirrors and translations link only the repository).
      const entryHtml = probed.status === 200 ? (await get(probed.final)).text : "";
      const linksPublisher = [...entryHtml.matchAll(/href=["'](https?:\/\/[^"'\/]+)/g)].some((m) => { const d = site2(host(m[1]!)); return declaredDomains.has(d) && !isCodeHost(host(m[1]!)) && d !== "github.com"; });
      if (onlyReadme && !declaredDomains.has(site2(host(probed.final || c.url))) && !linksPublisher) continue;
      sites.push(probed);
    }
    // Docs repository candidates: the package repository if it holds docs; repositories the site's edit links name;
    // repositories in the owners' organisations whose homepage or name is a site host.
    const repoCands = new Map<string, string[]>();
    const add = (full: string, why: string) => { const k = full.toLowerCase(); repoCands.set(k, [...(repoCands.get(k) ?? []), why]); };
    if (pkgRepo && pkgRepo.docFiles >= 5) add(pkgRepo.full, "package-repo-has-docs");
    for (const s of sites) for (const r of s.editRepos) add(r, "site-edit-link");
    const live = sites.filter((s) => s.status === 200);
    const siteHosts = new Set(live.map((s) => host(s.final)));
    const matchesSite = (u: string) => { try { const x = new URL(u); return live.some((s) => { const y = new URL(s.final); const first = x.pathname.split("/")[1] ?? ""; return host(x.href) === host(y.href) && (first === "" || first === (y.pathname.split("/")[1] ?? "")); }); } catch { return false; } };
    const owners = new Set([pkgRepo?.full.split("/")[0], ...sites.flatMap((s) => s.editRepos.map((r) => r.split("/")[0]))].filter(Boolean) as string[]);
    for (const o of owners) {
      const list = (await ghApi<Array<{ full_name: string; homepage: string | null; name: string; archived: boolean }>>(`orgs/${o}/repos?per_page=100&sort=pushed`))
        ?? (await ghApi<Array<{ full_name: string; homepage: string | null; name: string; archived: boolean }>>(`users/${o}/repos?per_page=100&sort=pushed`)) ?? [];
      for (const r of list.filter((r) => !r.archived)) {
        if (r.full_name.toLowerCase() === pkgRepo?.full.toLowerCase()) continue;
        if (r.homepage && matchesSite(r.homepage)) add(r.full_name, "org-repo-homepage");
        else if (siteHosts.has(r.name.toLowerCase())) add(r.full_name, "org-repo-named-for-host");
      }
    }
    // Validate each (site, repository) pair.
    const pairs = [];
    for (const [full, why] of repoCands) {
      const rd = full === pkgRepo?.full.toLowerCase() ? pkgRepo! : await repoDocs(full);
      const isPkg = rd?.full.toLowerCase() === pkgRepo?.full.toLowerCase();
      if (!rd || (isPkg ? rd.docFiles : rd.allDocFiles) < 5) continue;
      for (const s of live) {
        const sh = host(s.final);
        const siteToRepo = s.editRepos.some((r) => r.toLowerCase() === rd.full.toLowerCase()) || s.repoLinks.some((r) => r.toLowerCase() === rd.full.toLowerCase());
        const repoToSite = host(rd.homepage ?? "") === sh || (rd.full.toLowerCase() === pkgRepo?.full.toLowerCase() && !!rd.homepage && site2(host(rd.homepage)) === site2(sh)) || rd.configs.some((c) => c.hosts.includes(sh)) || rd.full.split("/")[1]!.toLowerCase() === sh;
        const authority = rd.full.split("/")[0]!.toLowerCase() === pkgRepo?.full.split("/")[0]!.toLowerCase() || declared.has(sh);
        const content = siteToRepo || repoToSite ? await contentCheck(s.samples, rd) : [];
        const verifiable = content.filter((c) => c.verifiable).length, cov = content.filter((c) => c.pass).length;
        const sameOrg = rd.full.split("/")[0]!.toLowerCase() === pkgRepo?.full.split("/")[0]!.toLowerCase();
        const byContent = verifiable >= 2 && cov >= 2 && cov > verifiable - cov;
        // Only a site with no readable text (JavaScript-only) may validate on links alone, and only in the package's organisation.
        const byLinksOnly = content.length > 0 && content.every((c) => c.via === "no-text") && sameOrg && siteToRepo !== repoToSite ? repoToSite && rd.full.split("/")[1]!.toLowerCase() === sh : false;
        pairs.push({ site: s.final, repo: rd.full, why, siteToRepo, repoToSite, authority, contentPass: `${cov}/${verifiable}/${content.length}`, content,
          validated: (siteToRepo || repoToSite) && authority && (byContent || byLinksOnly), validatedBy: byContent ? "content" : byLinksOnly ? "links-only" : "",
          framework: [...new Set(rd.configs.filter((c) => c.hosts.includes(sh) || c.framework !== "other").map((c) => c.framework))], docDirs: rd.docDirs, docFiles: rd.docFiles });
      }
    }
    const validated = pairs.filter((p) => p.validated);
    const site = sites.find((s) => s.status === 200 && s.sitemapPages > 0) ?? sites.find((s) => s.status === 200);
    const liveSites = sites.filter((s) => s.status === 200).map((s) => ({ site: s.final, pages: s.sitemapPages, from: s.from, prefix: s.prefix }));
    const answer = validated.length
      ? { kind: "site+repo", site: validated[0]!.site, repo: [...new Set(validated.map((p) => p.repo))].join(" "), sites: liveSites }
      : site ? { kind: "site-only", site: site.final, pages: site.sitemapPages, sites: liveSites }
      : pkgRepo && pkgRepo.docFiles >= 5 ? { kind: "repo-only", repo: pkgRepo.full, dirs: pkgRepo.docDirs }
      : readme ? { kind: "readme-only" } : { kind: "none" };
    ev.pkgRepo = pkgRepo && { full: pkgRepo.full, homepage: pkgRepo.homepage, docFiles: pkgRepo.docFiles, docDirs: pkgRepo.docDirs, configs: pkgRepo.configs, hasWiki: pkgRepo.hasWiki };
    ev.candidates = [...byHost.entries()].map(([h, c]) => ({ host: h, from: c.from }));
    ev.sites = sites.map(({ samples, ...s }) => ({ ...s, samples: samples.length }));
    return { purl, answer, pairs: pairs.map(({ content, ...p }) => ({ ...p, content: content.map((c) => `${c.pass ? "P" : "-"}${c.via}:${c.coverage ?? "-"}/${c.control ?? "-"}:${c.file ?? ""}`) })), evidence: ev, requests: f.requests - before };
  }
  return { resolve };
}
