//! Lexical matching over the repository: no model, no index (vault: Relevance Engine, "Relevance funnel" step 5
//! and "Fixes the funnel needs"). Ported from the Slice 0 harness (`fw_spike._lits`, `_hit`; the whole-token
//! applied check from `replay.py`).

use aho_corasick::{AhoCorasick, MatchKind};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

use crate::stack::walker;

const TEXT_EXT: &[&str] = &[
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "jsonc", "json5", "prisma", "graphql", "gql", "yml", "yaml", "toml",
    "vue", "svelte", "astro", "css", "scss", "html", "sql", "py", "pyi",
];
/// Source-code extensions of each ecosystem the client reads (package URL type). Config and data files are shared
/// by every ecosystem; code of another ecosystem's language never evidences a technology (Next.js `connection` in a
/// `.py` file, a Pulumi term in a Python sandbox).
const CODE_EXT: &[(&str, &[&str])] = &[
    ("npm", &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro"]),
    ("pypi", &["py", "pyi"]),
];

/// Whether `path` is source code of an ecosystem other than `ecosystem` (a package URL type).
pub fn foreign_code(path: &str, ecosystem: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    CODE_EXT.iter().any(|(e, exts)| *e != ecosystem && exts.contains(&ext.as_str()))
        && !CODE_EXT.iter().any(|(e, exts)| *e == ecosystem && exts.contains(&ext.as_str()))
}

/// Text read as data rather than code (fixtures, corpora, recorded responses) when it sits in a test role.
const DATA_EXT: &[&str] = &["json", "jsonc", "json5", "yml", "yaml", "toml", "sql", "graphql", "gql", "html"];

/// Whether a whole-token hit shows the project already applies a change: application files, or tests that are code
/// (a fixture or data file holding a literal is not adoption; nor is tooling, documentation or vendored code).
pub fn counts_as_applied(role: Role, path: &str) -> bool {
    match role {
        Role::App => true,
        Role::Test => !DATA_EXT.contains(&path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default().as_str()),
        _ => false,
    }
}

const LOCKFILES: &[&str] = &["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const MAX_BYTES: u64 = 400_000;

/// The repository's text, file by file (paths relative to the root, `/`-separated, sorted), and every file name.
#[derive(Debug, Default)]
pub struct Repo {
    pub files: Vec<(String, String)>,
    /// Every file's relative path and base name, including files whose text is not read.
    pub names: BTreeSet<String>,
    /// Every file's relative path, sorted.
    pub paths: Vec<String>,
    /// The root `.gitattributes` linguist lines, in file order (the last match wins, as in Git).
    attrs: Vec<(Gitignore, Role)>,
}

/// What a file is for, from conventions every repository shares (no per-technology list): application code first,
/// then the roles whose hits are weaker evidence of production use (tests and fixtures; scripts, CI, deployment and
/// development tooling; examples; documentation; generated; vendored). Ordered from most to least application-like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    App,
    Test,
    Tooling,
    Example,
    Docs,
    Generated,
    Vendored,
}

/// A path's role from directory and file-name conventions (GitHub Linguist's vendored/documentation/generated
/// conventions, plus the common test, fixture, evaluation, script, CI and deployment layouts). The least
/// application-like role any segment gives wins: `scripts/eval/data.json` is tooling, `examples/app/test/x.ts` an
/// example. Other dot-directories (`.github`, `.devcontainer`, `.pulumi-config`) hold tooling, not application code.
pub fn path_role(path: &str) -> Role {
    let lower = path.to_ascii_lowercase();
    let segs: Vec<&str> = lower.split('/').collect();
    let (file, dirs) = segs.split_last().expect("split yields one segment");
    let mut role = Role::App;
    for (i, d) in dirs.iter().enumerate() {
        let r = match *d {
            "third_party" | "third-party" | "thirdparty" | "bower_components" | "vendors" => Role::Vendored,
            "generated" | "__generated__" => Role::Generated,
            // Linguist anchors `docs/` at the root: `app/docs/page.tsx` is a route, not documentation.
            "docs" | "doc" if i == 0 => Role::Docs,
            "documentation" => Role::Docs,
            "examples" | "example" | "samples" | "sample" | "demo" | "demos" | ".storybook" | "stories" => Role::Example,
            "scripts" | "script" | "deploy" | "deployment" | "deployments" | "infra" | "infrastructure" | "k8s" | "kubernetes"
            | "helm" | "terraform" => Role::Tooling,
            "test" | "tests" | "__tests__" | "spec" | "specs" | "__mocks__" | "mocks" | "__fixtures__" | "fixtures" | "fixture"
            | "testdata" | "test-data" | "test_data" | "e2e" | "cypress" | "playwright" | "eval" | "evals" | "bench" | "benches"
            | "benchmark" | "benchmarks" => Role::Test,
            d if d.ends_with("-tests") || d.ends_with("_tests") || d.ends_with("-test") || d.ends_with("_test") => Role::Test,
            d if d.starts_with('.') => Role::Tooling,
            _ => Role::App,
        };
        role = role.max(r);
    }
    let f = *file;
    let by_name = if f.contains(".min.") || f.contains(".generated.") || f.ends_with("_pb2.py") || f.ends_with(".pb.go") {
        Role::Generated
    } else if f.contains(".stories.") {
        Role::Example
    } else if f.contains(".test.") || f.contains(".spec.") || f.contains("_test.") || f.starts_with("test_") || f.ends_with("_spec.rb") {
        Role::Test
    } else {
        Role::App
    };
    role.max(by_name)
}

/// The linguist lines of a `.gitattributes` file: `linguist-vendored`, `-generated` and `-documentation` set a role;
/// unsetting one (`-linguist-vendored`, `linguist-vendored=false`) marks the path as application code.
fn read_attrs(root: &Path) -> Vec<(Gitignore, Role)> {
    let Ok(text) = std::fs::read_to_string(root.join(".gitattributes")) else { return vec![] };
    let mut out = vec![];
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let mut parts = line.split_whitespace();
        let Some(pattern) = parts.next() else { continue };
        let mut role = None;
        for a in parts {
            let (unset, name) = match a.strip_prefix('-') {
                Some(n) => (true, n),
                None => match a.split_once('=') {
                    Some((n, v)) => (v == "false", n),
                    None => (false, a),
                },
            };
            let r = match name {
                "linguist-vendored" => Role::Vendored,
                "linguist-generated" => Role::Generated,
                "linguist-documentation" => Role::Docs,
                _ => continue,
            };
            role = Some(if unset { Role::App } else { r });
        }
        let Some(role) = role else { continue };
        let mut b = GitignoreBuilder::new(root);
        if b.add_line(None, pattern).is_ok()
            && let Ok(g) = b.build()
        {
            out.push((g, role));
        }
    }
    out
}

impl Repo {
    /// A file's role: the last matching `.gitattributes` linguist line, else the path's conventions.
    pub fn role(&self, path: &str) -> Role {
        self.role_for(path, &[])
    }

    /// A file's role for one technology: relative to the deepest of `owners` (directories of packages whose manifest
    /// declares the technology) that contains it, so a package's own code is application code for what it declares
    /// whatever its directory is called (`docs/` holding its own Next.js app). `.gitattributes` lines still win.
    pub fn role_for(&self, path: &str, owners: &[&str]) -> Role {
        if let Some((_, r)) = self.attrs.iter().rev().find(|(g, _)| g.matched_path_or_any_parents(path, false).is_ignore()) {
            return *r;
        }
        let rel = owners
            .iter()
            .filter(|o| **o != "." && path.strip_prefix(**o).is_some_and(|rest| rest.starts_with('/')))
            .max_by_key(|o| o.len())
            .map_or(path, |o| &path[o.len() + 1..]);
        path_role(rel)
    }

    pub fn collect(root: &Path) -> Repo {
        let mut r = Repo { attrs: read_attrs(root), ..Repo::default() };
        for e in walker(root).flatten() {
            if !e.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(rel) = e.path().strip_prefix(root) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let base = e.file_name().to_string_lossy().to_string();
            r.names.insert(rel.clone());
            r.names.insert(base.clone());
            r.paths.push(rel.clone());
            // Text read: source and configuration (package.json scripts included), not lockfiles or prose.
            let ext = base.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
            // Example env files only: a real `.env` may hold secrets (its text is never printed, but no need to read it).
            let dotenv = matches!(base.as_str(), ".env.example" | ".env.sample" | ".env.template" | ".env.dist");
            if LOCKFILES.contains(&base.as_str()) || !(TEXT_EXT.contains(&ext.as_str()) || dotenv) {
                continue;
            }
            if e.metadata().map(|m| m.len() > MAX_BYTES).unwrap_or(true) {
                continue;
            }
            if let Ok(t) = std::fs::read_to_string(e.path()) {
                r.files.push((rel, t));
            }
        }
        r.files.sort_by(|a, b| a.0.cmp(&b.0));
        r.paths.sort();
        r
    }
}

/// A search literal as written in a record, cleaned: trailing call parentheses, `/N` suffixes, backticks and
/// quotes removed; shorter than 4 characters is dropped (`fw_spike._lits`).
pub fn clean_lit(s: &str) -> Option<String> {
    let mut x = s.replace('`', "");
    if let Some(i) = x.find('(')
        && (x.ends_with(')') || x.ends_with('(')) {
            x.truncate(i);
        }
    if let Some((head, tail)) = x.rsplit_once('/')
        && !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            x = head.to_string();
        }
    let x = x.trim().trim_matches(['\'', '"']).to_string();
    (x.chars().count() >= 4).then_some(x)
}

fn is_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// The last segment after `.`, `:` or `#`, used as a token when at least 6 characters (`fw_spike._hit`).
fn tail_of(lit: &str) -> Option<String> {
    let t = lit.rsplit(['.', ':', '#']).next()?;
    (t.chars().count() >= 6 && t != lit && is_word(t)).then(|| t.to_string())
}

const ANY: u8 = 1;
const TOKEN: u8 = 2; // bounded by characters outside [\w$]
const WHOLE: u8 = 4; // bounded by characters outside [\w-] (the applied check)

/// Hits of a set of literals in the repository.
#[derive(Debug, Default)]
pub struct Hits {
    /// literal → files it was found in, application files first (by `Role`, then path).
    pub usage: HashMap<String, Vec<String>>,
    /// literal → files where it is a whole token (`[\w-]` boundaries) or the file's name.
    pub whole: HashMap<String, Vec<String>>,
}


impl Hits {
    pub fn used(&self, lit: &str) -> bool {
        self.usage.get(lit).is_some_and(|f| !f.is_empty())
    }
}

/// Match `usage_lits` (the ordering rule: a word literal as a token, anything else as a substring, or its tail
/// as a token) and `whole_lits` (whole tokens or file names only).
pub fn find(repo: &Repo, usage_lits: &BTreeSet<String>, whole_lits: &BTreeSet<String>) -> Hits {
    let mut patterns: Vec<String> = vec![];
    let mut idx: BTreeMap<String, usize> = BTreeMap::new();
    let mut add = |p: &str, patterns: &mut Vec<String>| {
        if !idx.contains_key(p) {
            idx.insert(p.to_string(), patterns.len());
            patterns.push(p.to_string());
        }
    };
    for l in usage_lits {
        add(l, &mut patterns);
        if let Some(t) = tail_of(l) {
            add(&t, &mut patterns);
        }
    }
    for l in whole_lits {
        add(l, &mut patterns);
    }
    let mut hits = Hits::default();
    if patterns.is_empty() {
        return hits;
    }
    let ac = AhoCorasick::builder().match_kind(MatchKind::Standard).build(&patterns).expect("literal automaton");
    let word = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80);
    let wordish = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-' || c >= 0x80);
    // Resolved once: each literal's pattern (and its tail's), and per pattern the literals it can satisfy, so a file
    // only evaluates the literals whose patterns occur in it.
    let usage_ix: Vec<(&String, usize, Option<usize>, bool)> =
        usage_lits.iter().map(|l| (l, idx[l], tail_of(l).and_then(|t| idx.get(&t).copied()), is_word(l))).collect();
    let whole_ix: Vec<(&String, usize)> = whole_lits.iter().map(|l| (l, idx[l])).collect();
    let mut usage_by_pat: Vec<Vec<usize>> = vec![vec![]; patterns.len()];
    for (i, (_, p, t, _)) in usage_ix.iter().enumerate() {
        usage_by_pat[*p].push(i);
        if let Some(t) = t {
            usage_by_pat[*t].push(i);
        }
    }
    let mut whole_by_pat: Vec<Vec<usize>> = vec![vec![]; patterns.len()];
    for (i, (_, p)) in whole_ix.iter().enumerate() {
        whole_by_pat[*p].push(i);
    }
    for (path, text) in &repo.files {
        let b = text.as_bytes();
        let mut bits: HashMap<usize, u8> = HashMap::new();
        for m in ac.find_overlapping_iter(text) {
            let before = if m.start() == 0 { None } else { Some(b[m.start() - 1]) };
            let after = b.get(m.end()).copied();
            let p = m.pattern().as_usize();
            let pat = patterns[p].as_bytes();
            let (first, last) = (Some(pat[0]), Some(pat[pat.len() - 1]));
            let mut v = ANY;
            // Only check a boundary where the literal itself starts/ends with a word character.
            if (!word(first) || !word(before)) && (!word(last) || !word(after)) {
                v |= TOKEN;
            }
            if (!wordish(first) || !wordish(before)) && (!wordish(last) || !wordish(after)) {
                v |= WHOLE;
            }
            *bits.entry(p).or_default() |= v;
        }
        if bits.is_empty() {
            continue;
        }
        let has = |p: usize, bit: u8| bits.get(&p).is_some_and(|v| v & bit != 0);
        let mut cand: Vec<usize> = bits.keys().flat_map(|p| usage_by_pat[*p].iter().copied()).collect();
        cand.sort_unstable();
        cand.dedup();
        for i in cand {
            let (l, p, t, word_lit) = usage_ix[i];
            let hit = if word_lit { has(p, TOKEN) } else { has(p, ANY) || t.is_some_and(|t| has(t, TOKEN)) };
            if hit {
                hits.usage.entry(l.clone()).or_default().push(path.clone());
            }
        }
        for i in bits.keys().flat_map(|p| whole_by_pat[*p].iter().copied()) {
            let (l, p) = whole_ix[i];
            if has(p, WHOLE) {
                hits.whole.entry(l.clone()).or_default().push(path.clone());
            }
        }
    }
    // A file-name literal (`middleware.ts`, `prisma/schema.prisma`) also matches a file of that name.
    for l in usage_lits {
        if !l.contains('.') || l.contains(char::is_whitespace) || !repo.names.contains(l) {
            continue;
        }
        let suffix = format!("/{l}");
        for p in repo.paths.iter().filter(|p| *p == l || p.ends_with(&suffix)) {
            hits.usage.entry(l.clone()).or_default().push(p.clone());
        }
    }
    // Application files first, so the evidence a reader sees (the first few) is production use when there is any.
    for files in hits.usage.values_mut() {
        files.sort_by_cached_key(|p| (repo.role(p), p.clone()));
        files.dedup();
    }
    for l in whole_lits {
        let suffix = format!("/{l}");
        if repo.names.contains(l) {
            for p in repo.paths.iter().filter(|p| *p == l || p.ends_with(&suffix)) {
                hits.whole.entry(l.clone()).or_default().push(p.clone());
            }
        }
    }
    hits
}

/// The central term-rarity sample (vault: Relevance Engine, "Where term weights are computed"): for each term, how
/// many of the sample repositories contain it, by exactly the rule the funnel ranks with (`find`'s usage match on
/// the term as `clean_lit` cleans it). A term `clean_lit` drops counts 0; the edge never matches it either.
pub fn sample_counts(repos: &[Repo], terms: &[String]) -> BTreeMap<String, u32> {
    let lits: BTreeMap<&String, String> = terms.iter().filter_map(|t| clean_lit(t).map(|l| (t, l))).collect();
    let set: BTreeSet<String> = lits.values().cloned().collect();
    let hits: Vec<Hits> = repos.iter().map(|r| find(r, &set, &BTreeSet::new())).collect();
    terms.iter().map(|t| (t.clone(), lits.get(t).map_or(0, |l| hits.iter().filter(|h| h.used(l)).count() as u32))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(files: &[(&str, &str)]) -> Repo {
        let mut r = Repo::default();
        for (p, t) in files {
            r.files.push((p.to_string(), t.to_string()));
            r.names.insert(p.to_string());
            r.names.insert(p.rsplit('/').next().unwrap().to_string());
            r.paths.push(p.to_string());
        }
        r
    }
    fn set(x: &[&str]) -> BTreeSet<String> {
        x.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cleaning() {
        assert_eq!(clean_lit("`setConnection(`").as_deref(), Some("setConnection"));
        assert_eq!(clean_lit("revalidateTag()").as_deref(), Some("revalidateTag"));
        assert_eq!(clean_lit("'next/image'").as_deref(), Some("next/image"));
        assert_eq!(clean_lit("node:sqlite/2").as_deref(), Some("node:sqlite"));
        assert_eq!(clean_lit("abc"), None);
    }

    #[test]
    fn word_literals_match_whole_tokens_only() {
        let r = repo(&[("a.ts", "const cacheLifeX = 1; useCache()"), ("b.ts", "import { cacheLife } from 'next/cache'")]);
        let h = find(&r, &set(&["cacheLife", "useCache", "next/cache"]), &set(&[]));
        assert_eq!(h.usage["cacheLife"], vec!["b.ts".to_string()], "cacheLifeX is not cacheLife");
        assert!(h.used("useCache"));
        assert_eq!(h.usage["next/cache"], vec!["b.ts".to_string()]);
    }

    #[test]
    fn dotted_literal_matches_by_substring_or_long_tail_token() {
        let r = repo(&[("next.config.ts", "export default { images: { minimumCacheTTL: 60 } }")]);
        let h = find(&r, &set(&["images.minimumCacheTTL", "experimental.ppr"]), &set(&[]));
        assert!(h.used("images.minimumCacheTTL"), "tail token minimumCacheTTL");
        assert!(!h.used("experimental.ppr"), "tail `ppr` is too short");
    }

    #[test]
    fn whole_token_applied_check_and_file_names() {
        let r = repo(&[("src/proxy.ts", "export function proxy() {}\nconst x = updateTagged;"), ("a.ts", "foo-updateTag")]);
        let h = find(&r, &set(&[]), &set(&["updateTag", "proxy.ts", "middleware.ts", "proxy"]));
        assert!(!h.whole.contains_key("updateTag"), "updateTagged and foo-updateTag are not whole tokens");
        assert!(h.whole.contains_key("proxy.ts"), "a file name counts");
        assert!(!h.whole.contains_key("middleware.ts"));
        assert!(h.whole.contains_key("proxy"));
    }

    #[test]
    fn file_name_literals_match_files() {
        let r = repo(&[("prisma/schema.prisma", "model User {}"), ("src/middleware.ts", "export {}")]);
        let h = find(&r, &set(&["schema.prisma", "middleware.ts", "proxy.ts"]), &set(&[]));
        assert_eq!(h.usage["schema.prisma"], vec!["prisma/schema.prisma".to_string()]);
        assert_eq!(h.usage["middleware.ts"], vec!["src/middleware.ts".to_string()]);
        assert!(!h.used("proxy.ts"));
    }

    #[test]
    fn collect_respects_gitignore_and_skips_node_modules_and_lockfiles() {
        let d = tempfile::tempdir().unwrap();
        let w = |p: &str, t: &str| {
            let p = d.path().join(p);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, t).unwrap();
        };
        w(".gitignore", "secret/\n");
        w("src/a.ts", "x");
        w("secret/b.ts", "x");
        w("node_modules/next/index.js", "x");
        w("pnpm-lock.yaml", "x");
        w("package.json", "{\"scripts\":{\"build\":\"next build\"}}");
        w("README.md", "prose");
        let r = Repo::collect(d.path());
        let paths: Vec<&str> = r.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["package.json", "src/a.ts"]);
        assert!(r.names.contains("README.md") && r.names.contains("pnpm-lock.yaml"));
        assert!(!r.names.contains("secret/b.ts"));
    }

    #[test]
    fn path_roles_follow_shared_conventions() {
        for (p, r) in [
            ("ui/app/(authorized)/task/utils/narrativeExportUtils.ts", Role::App),
            ("app/docs/page.tsx", Role::App),
            ("docs/guide/setup.ts", Role::Docs),
            ("scripts/autoresearch/section-detection/ground-truth.json", Role::Tooling),
            ("qa-tests/maps/a.json", Role::Test),
            ("ui/eval/cases.json", Role::Test),
            ("src/__tests__/a.ts", Role::Test),
            ("src/button.test.tsx", Role::Test),
            ("tests/test_client.py", Role::Test),
            (".github/workflows/ci.yml", Role::Tooling),
            (".pulumi-config/index.ts", Role::Tooling),
            ("deploy/k8s-local/policy.yaml", Role::Tooling),
            (".storybook/main.ts", Role::Example),
            ("examples/app/tests/a.ts", Role::Example),
            ("src/button.stories.tsx", Role::Example),
            ("src/__generated__/schema.ts", Role::Generated),
            ("public/lib.min.js", Role::Generated),
            ("third_party/x/index.js", Role::Vendored),
        ] {
            assert_eq!(path_role(p), r, "{p}");
        }
    }

    #[test]
    fn gitattributes_linguist_lines_override_conventions() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join(".gitattributes"),
            "# comment\nlib/sdk/** linguist-generated\nscripts/release/** -linguist-vendored\nassets/** linguist-vendored=true\nassets/own.ts linguist-vendored=false\n*.ts text eol=lf\n",
        )
        .unwrap();
        let r = Repo::collect(d.path());
        assert_eq!(r.role("lib/sdk/client.ts"), Role::Generated);
        assert_eq!(r.role("scripts/release/run.ts"), Role::App, "unset marks application code");
        assert_eq!(r.role("assets/x.js"), Role::Vendored);
        assert_eq!(r.role("assets/own.ts"), Role::App, "the last matching line wins");
        assert_eq!(r.role("scripts/other.ts"), Role::Tooling, "no line matches: conventions");
    }

    #[test]
    fn roles_are_judged_inside_the_package_that_declares_the_technology() {
        let r = Repo::default();
        assert_eq!(r.role("docs/next.config.mjs"), Role::Docs, "no owner: the path's own role");
        assert_eq!(r.role_for("docs/next.config.mjs", &[".", "docs"]), Role::App, "docs/ is its own Next.js package");
        assert_eq!(r.role_for("docs/app/tests/a.ts", &[".", "docs"]), Role::Test, "conventions still apply inside it");
        assert_eq!(r.role_for("docsite/x.ts", &["docs"]), Role::App, "a prefix must end at a directory");
        assert_eq!(r.role_for("scripts/autoresearch/truth.json", &[".", "ui"]), Role::Tooling, "scripts/ does not declare it");
        assert_eq!(r.role_for("ui/app/a.ts", &[".", "ui"]), Role::App);
    }

    #[test]
    fn applied_counts_application_and_test_code_not_fixtures_or_tooling() {
        for (role, path, applied) in [
            (Role::App, "src/a.json", true),
            (Role::Test, "tests/cache.test.ts", true),
            (Role::Test, "tests/fixtures/resp.json", false),
            (Role::Tooling, ".github/workflows/ci.yml", false),
            (Role::Docs, "docs/a.ts", false),
        ] {
            assert_eq!(counts_as_applied(role, path), applied, "{path}");
        }
    }

    #[test]
    fn another_ecosystems_code_never_evidences_a_technology() {
        assert!(foreign_code("sandbox/session.py", "npm"));
        assert!(foreign_code("ui/app/page.tsx", "pypi"));
        assert!(!foreign_code("ui/app/page.tsx", "npm"));
        assert!(!foreign_code("app/main.py", "pypi"));
        for shared in ["docker-compose.yml", "package.json", "pyproject.toml", ".env.template", "schema.sql"] {
            assert!(!foreign_code(shared, "npm") && !foreign_code(shared, "pypi"), "{shared}");
        }
    }

    #[test]
    fn evidence_lists_application_files_first() {
        let r = repo(&[
            ("scripts/autoresearch/truth.json", "PageNumber"),
            ("qa-tests/a.ts", "PageNumber"),
            ("ui/lib/export.ts", "import { PageNumber } from 'docx'"),
            ("ui/app/b.ts", "PageNumber.CURRENT"),
        ]);
        let h = find(&r, &set(&["PageNumber"]), &set(&[]));
        assert_eq!(h.usage["PageNumber"], vec!["ui/app/b.ts", "ui/lib/export.ts", "qa-tests/a.ts", "scripts/autoresearch/truth.json"]);
    }

    #[test]
    fn sample_counts_use_the_ranking_rule_per_repository() {
        let a = repo(&[("a.ts", "import { cacheLife } from 'next/cache'"), ("middleware.ts", "export {}")]);
        let b = repo(&[("b.ts", "const cacheLifeX = 1; images: { minimumCacheTTL: 1 }")]);
        let terms: Vec<String> = ["cacheLife()", "`next/cache`", "images.minimumCacheTTL", "middleware.ts", "abc", "unused"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let c = sample_counts(&[a, b], &terms);
        assert_eq!(c["cacheLife()"], 1, "cleaned to cacheLife; cacheLifeX is not a token match");
        assert_eq!(c["`next/cache`"], 1);
        assert_eq!(c["images.minimumCacheTTL"], 1, "tail token");
        assert_eq!(c["middleware.ts"], 1, "file name");
        assert_eq!(c["abc"], 0, "too short to match at the edge");
        assert_eq!(c["unused"], 0);
        assert_eq!(c.len(), 6);
    }
}
