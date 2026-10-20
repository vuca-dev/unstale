//! Lexical matching over the repository: no model, no index. Ported from the Slice 0 harness (`fw_spike._lits`, `_hit`;
//! the whole-token applied check from `replay.py`).

use aho_corasick::{AhoCorasick, MatchKind};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::cell::RefCell;
use std::sync::Mutex;

use crate::stack::walker;
use crate::util::{normalize_purl, purl_name};

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

/// Whether `path` is source code of `ecosystem`'s own languages.
pub fn own_code(path: &str, ecosystem: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    CODE_EXT.iter().any(|(e, exts)| *e == ecosystem && exts.contains(&ext.as_str()))
}

/// A literal that is one plain word (`cache`, `plugins`, `Comment`, `.extend`): every codebase writes it for its own
/// reasons, so on its own it is no sign of a technology. Identifiers of more than one word (`setTimeout`,
/// `minimumCacheTTL`), paths, qualified names (`z.object`) and file names are not plain words.
pub fn plain_word(lit: &str) -> bool {
    let s = lit.strip_prefix('.').unwrap_or(lit);
    let mut cs = s.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// A literal that is one identifier of more than one word (`defaultOptions`, `toBeCalledWith`, `.safeParse`): any code
/// can declare one of its own (a local `const defaultOptions`), so in a file that neither imports the technology nor is
/// named by its records it is no sign of the technology's API. Plain words, qualified names, hyphenated tokens
/// (`overflow-ellipsis`), paths and file names are not.
pub fn identifier(lit: &str) -> bool {
    let s = lit.strip_prefix('.').unwrap_or(lit);
    !plain_word(lit) && s.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '$') && is_word(s)
}

/// A literal that is a command-line flag (`--scope`, `--detect-async-leaks`, `--import tsx`): two dashes, then a letter.
/// Every CLI has flags of these names, so one counts only on a command line that runs the technology
/// (`command_words`, `Hits::flag_lines`). Single-dash literals are CSS (`-webkit-…`) or too short to be matched.
pub fn cli_flag(lit: &str) -> bool {
    lit.strip_prefix("--").is_some_and(|r| r.starts_with(|c: char| c.is_ascii_alphabetic()))
}

/// The words that run a package from a command line: its name, a scoped package's scope (`@playwright/test` runs as
/// `playwright`; its name only when one starts with the other, `@biomejs/biome`, since `test` or `cli` is any script's
/// word), and the name's first hyphen-separated word (`webpack-cli` as `webpack`, an `eslint-plugin-*` on an `eslint`
/// line). Lowercase.
pub fn command_words(purl: &str) -> Vec<String> {
    let Some(name) = purl_name(purl) else { return vec![] };
    let name = name.to_ascii_lowercase();
    let words: Vec<String> = match name.strip_prefix('@').and_then(|s| s.split_once('/')) {
        Some((scope, base)) if scope.starts_with(base) || base.starts_with(scope) => vec![scope.to_string(), base.to_string()],
        Some((scope, _)) => vec![scope.to_string()],
        None => vec![name.clone(), name.split('-').next().unwrap_or("").to_string()],
    };
    let mut out: Vec<String> = vec![];
    for w in words {
        if w.len() >= 2 && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// Words on the command line holding byte `at` of `text`: its line, joined with the lines a trailing `\` continues
/// from or into. Split at anything but `[A-Za-z0-9_-]` (`npx turbo`, `node_modules/.bin/turbo`), lowercase.
fn line_words(text: &str, at: usize) -> impl Iterator<Item = String> + '_ {
    let b = text.as_bytes();
    let continued = |end: usize| text[..end].trim_end_matches(['\r', ' ', '\t']).ends_with('\\');
    let mut start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    while start > 0 && continued(start - 1) {
        start = text[..start - 1].rfind('\n').map_or(0, |i| i + 1);
    }
    let mut end = text[at..].find('\n').map_or(b.len(), |i| at + i);
    while end < b.len() && continued(end) {
        end = text[end + 1..].find('\n').map_or(b.len(), |i| end + 1 + i);
    }
    text[start..end].split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).filter(|w| !w.is_empty()).map(str::to_ascii_lowercase)
}

/// Stylesheets, where `--name` is a custom property (`--spacing`), never a flag.
const STYLE_EXT: &[&str] = &["css", "scss", "sass", "less"];

/// The literals whose hits are the files that name a package, by the ecosystem's own syntax: a quoted npm specifier or
/// subpath (`'vitest'`, `"next/image"`; manifests, CSS `@import`) and the same at a module position in code
/// (`module_naming`), a Python `import`/`from` or a quoted requirement (`"pydantic>=2"` in `pyproject.toml`). Matched in
/// `find`'s one pass.
pub fn naming_lits(purl: &str) -> Vec<String> {
    let Some(name) = purl_name(purl) else { return vec![] };
    if normalize_purl(purl).starts_with("pkg:pypi/") {
        // A module boundary after the name, so `requests` is not named by `import requests_cache`.
        let module = name.to_ascii_lowercase().replace('-', "_");
        let mut out = vec![];
        for end in [" ", ".", ",", "\n", "\r", ";"] {
            out.push(format!("import {module}{end}"));
            out.push(format!("from {module}{end}"));
        }
        for q in ["'", "\""] {
            for end in [q, ">", "<", "=", "~", "!", "[", " ", ";"] {
                out.push(format!("{q}{name}{end}"));
            }
        }
        return out;
    }
    let quoted: Vec<String> = ["'", "\""].iter().flat_map(|q| [format!("{q}{name}{q}"), format!("{q}{name}/")]).collect();
    let module = NPM_MODULE_AT.iter().flat_map(|at| quoted.iter().map(move |q| format!("{at}{q}")));
    quoted.iter().cloned().chain(module).collect()
}

/// What precedes a quoted specifier where JavaScript code loads it as a module: `import … from`, a side-effect or
/// dynamic `import`, `require` and `require.resolve`, a test runner's module mock or original (`vi.mock`,
/// `jest.doMock`, `jest.requireActual`, `vi.importActual`), and a triple-slash `types` reference. Loader calls only:
/// `path.resolve('sharp')` or a local `mock('sharp')` is a string.
const NPM_MODULE_AT: &[&str] = &[
    "from ",
    "import ",
    "import(",
    "require(",
    "require.resolve(",
    "vi.mock(",
    "jest.mock(",
    "vi.doMock(",
    "jest.doMock(",
    "requireActual(",
    "importActual(",
    "requireMock(",
    "importMock(",
    "types=",
];

/// Whether a naming literal (`naming_lits`) names the package at a module position, which is what makes code about
/// it. A quoted name alone does not: `type Falloff = 'linear' | 'sharp'` is a string, not an import of sharp. In data
/// and config files (manifests, `tsconfig.json` types, CSS `@import`) any quoted form names it.
pub fn module_naming(lit: &str) -> bool {
    lit.starts_with("import ") || lit.starts_with("from ") || NPM_MODULE_AT.iter().any(|at| lit.starts_with(at))
}

/// A literal that is a relative path (`./src/*`, `../`): in a dependency's record it is a subpath of the dependency's
/// own package or a path of the repository, never the repository's own package layout.
pub fn relative_path(lit: &str) -> bool {
    lit.starts_with("./") || lit.starts_with("../")
}

/// The fields of an npm manifest that lay out the repository's own package: its entry points, export and import maps,
/// published files, binaries and workspaces. A relative path in them is this package's, so a dependency's literal
/// (`./src/*` from a record about vitest's exports) never matches there.
const OWN_LAYOUT_FIELDS: &[&str] = &[
    "main", "module", "browser", "react-native", "types", "typings", "exports", "imports", "files", "bin", "man", "directories",
    "workspaces", "typesVersions", "sideEffects", "unpkg", "jsdelivr", "source", "style",
];

/// A `package.json`'s text without its own-layout fields (`OWN_LAYOUT_FIELDS`); `None` when it is not a JSON object.
fn without_own_layout(text: &str) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(text).ok()?;
    let o = v.as_object_mut()?;
    for f in OWN_LAYOUT_FIELDS {
        o.remove(*f);
    }
    Some(v.to_string())
}

/// The package subpath a relative literal names (`./src/*` → `src/`, `./config` → `config`): a trailing `*` dropped,
/// at least one character left, no quote or whitespace. Whether the record means the package's subpath is the
/// caller's question (`funnel::tech_lits`).
pub fn subpath(lit: &str) -> Option<&str> {
    let x = lit.strip_prefix("./")?;
    let x = x.strip_suffix('*').unwrap_or(x);
    (!x.is_empty() && !x.starts_with(['/', '.', '*']) && !x.contains(|c: char| c.is_whitespace() || c == '\'' || c == '"' || c == '`' || c == '*'))
        .then_some(x)
}

/// The literals whose hits are the files that name subpath `x` of a package (`subpath`): `<package>/x` as a quoted
/// specifier, ending at the quote or a further `/` (`'vitest/src/`, `"knip/config"`), and the same at a module position
/// (`module_naming`). npm only; empty for other ecosystems.
pub fn subpath_lits(purl: &str, x: &str) -> Vec<String> {
    let Some(name) = purl_name(purl) else { return vec![] };
    if !normalize_purl(purl).starts_with("pkg:npm/") {
        return vec![];
    }
    let quoted: Vec<String> = ["'", "\""]
        .iter()
        .flat_map(|q| if x.ends_with('/') { vec![format!("{q}{name}/{x}")] } else { vec![format!("{q}{name}/{x}{q}"), format!("{q}{name}/{x}/")] })
        .collect();
    let module = NPM_MODULE_AT.iter().flat_map(|at| quoted.iter().map(move |q| format!("{at}{q}")));
    quoted.iter().cloned().chain(module).collect()
}

/// Which files can evidence one technology, and which of those are about it.
///
/// A file can use a technology when it is source code of the technology's ecosystem in a package that declares it
/// (any enclosing one: a workspace package may rely on the root's dependencies), or when it names the technology: its
/// text names one of its packages as a module (`naming_lits`; a manifest listing it), its path names a package
/// (`vitest.config.ts`, `.eslintrc.json`, `prisma/schema.prisma`, `*.prisma`), or the technology's records name it as a
/// file (`tsconfig.json`): a config file it reads. Data, config and markup files that do none of this (dashboard JSON,
/// translations, Go linter YAML, Kubernetes manifests) never evidence it, nor does another ecosystem's code.
///
/// A file is about the technology when it is code that imports it (a quoted specifier at a module position,
/// `module_naming`: a string such as `'sharp'` in a union type is not an import) or its path names it. Evidence lists
/// only files that hold the literal itself, by these rules, and files about the technology come first: they are where
/// its calls are.
/// - A plain word (`plain_word`) is shown only from files about the technology.
/// - An identifier (`identifier`) is shown only from those, or from a file the technology's records name.
/// - A qualified literal matched only by its tail is shown under the tail's rule when the tail is an identifier
///   (`expect.toBeCalledWith` written `expect(x).toBeCalledWith`), and never when it is a plain word: `node.properties`
///   is not `z.properties`.
///
/// The queue's order still counts every hit in a file that can use the technology (`Evidence::used`).
pub struct Scope<'a> {
    ecosystem: &'a str,
    owners: &'a [&'a str],
    /// Packages that declare the technology or depend on a workspace package that does (`with_reach`; else `owners`):
    /// where a file its records name (`middleware.ts`, `eslint.config.mjs`) is its file.
    reach: &'a [&'a str],
    /// Lowercase package names and npm scopes, for path names.
    stems: Vec<String>,
    naming: HashSet<&'a str>,
    /// Of `naming`, the files that name a package at a module position (`module_naming`).
    importing: HashSet<&'a str>,
    config_names: BTreeSet<String>,
    hits: &'a Hits,
    /// `Repo::paths`, which `Hits::ix` indexes.
    paths: &'a [String],
    /// Per path index: whether the file names the technology's packages, and whether at a module position; and its
    /// `file`, once (0 not yet; else 1 + `None`/`Some(false)`/`Some(true)`): the same files come up for every literal.
    named_at: Vec<(bool, bool)>,
    memo: RefCell<Vec<u8>>,
}

impl<'a> Scope<'a> {
    /// `purls`: the technology's components; `lits`: its literals (the file-name ones mark config files it reads).
    pub fn new<'l>(
        ecosystem: &'a str,
        owners: &'a [&'a str],
        purls: impl IntoIterator<Item = &'l String>,
        lits: impl IntoIterator<Item = &'l String>,
        hits: &'a Hits,
        paths: &'a [String],
    ) -> Self {
        let mut stems = vec![];
        let mut naming = HashSet::new();
        let mut importing = HashSet::new();
        let mut named_at = vec![(false, false); paths.len()];
        for p in purls {
            for l in naming_lits(p) {
                let module = module_naming(&l);
                let files = hits.usage.get(&l).into_iter().flatten().map(String::as_str);
                if module {
                    let files: Vec<&str> = files.collect();
                    naming.extend(files.iter().copied());
                    importing.extend(files);
                } else {
                    naming.extend(files);
                }
                for x in hits.ix.get(&l).into_iter().flatten() {
                    if let Some(n) = named_at.get_mut(*x as usize) {
                        n.0 = true;
                        n.1 |= module;
                    }
                }
            }
            let name = purl_name(p).unwrap_or_default().to_ascii_lowercase();
            // `@playwright/test` names `playwright`, not every `test/` directory; `vitest` names `vitest`.
            let stem = name.strip_prefix('@').map_or(name.as_str(), |scoped| scoped.split('/').next().unwrap_or(""));
            if stem.len() >= 3 && !stems.iter().any(|s| s == stem) {
                stems.push(stem.to_string());
            }
        }
        let config_names = lits
            .into_iter()
            .filter(|l| l.contains('.') && !l.contains(char::is_whitespace) && !l.contains('/'))
            .map(|l| l.to_ascii_lowercase())
            .collect();
        let memo = RefCell::new(vec![0; paths.len()]);
        Scope { ecosystem, owners, reach: owners, stems, naming, importing, config_names, hits, paths, named_at, memo }
    }

    /// `reach`: the packages that declare the technology or depend, through the repository's own packages, on one that
    /// does (a package whose ESLint config comes from a workspace config package).
    pub fn with_reach(mut self, reach: &'a [&'a str]) -> Self {
        self.reach = reach;
        self
    }

    /// Whether the path names one of the technology's packages: a directory, the base name's head or first word, or
    /// the extension equal to it, or to it plus `rc` (`.eslintrc`), or a prefix of it of 5 or more characters that
    /// ends inside a word (`tailwind` for tailwindcss, not `react` for react-icons).
    fn path_names(&self, path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        let (dirs, base) = lower.rsplit_once('/').unwrap_or(("", lower.as_str()));
        let bare = base.trim_start_matches('.');
        let head = bare.split('.').next().unwrap_or("");
        let word = head.split(['-', '_']).next().unwrap_or("");
        let ext = bare.rsplit_once('.').map_or("", |(_, x)| x);
        let mut segs = dirs.split('/').filter(|d| !d.is_empty()).map(|d| d.trim_start_matches('.')).chain([head, word, ext]);
        segs.any(|seg| {
            self.stems.iter().any(|s| {
                seg == s
                    || seg.strip_prefix(s.as_str()) == Some("rc")
                    || (seg.len() >= 5 && s.strip_prefix(seg).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_alphanumeric())))
            })
        })
    }

    /// The files that name one of the technology's packages at a module position (import it, or configure it).
    pub fn importers(&self) -> impl Iterator<Item = &str> + '_ {
        self.importing.iter().copied()
    }

    /// Whether the path names one of the technology's packages (`path_names`): `.eslintrc.json`, `next.config.js`.
    pub fn names_path(&self, path: &str) -> bool {
        self.path_names(path)
    }

    #[cfg(test)]
    fn path_names_for_test(self) -> impl Fn(&str) -> bool {
        move |p| self.path_names(p)
    }

    /// `None` when the file cannot evidence the technology; else whether it is about it.
    pub fn file(&self, path: &str) -> Option<bool> {
        self.classify(path, (self.naming.contains(path), self.importing.contains(path)))
    }

    /// `file` for the path at index `x` of `Repo::paths`, once per file.
    fn file_at(&self, x: u32) -> Option<bool> {
        let path = self.paths.get(x as usize)?;
        let x = x as usize;
        let known = self.memo.borrow()[x];
        if known != 0 {
            return [None, Some(false), Some(true)][known as usize - 1];
        }
        let f = self.classify(path, self.named_at[x]);
        self.memo.borrow_mut()[x] = match f {
            None => 1,
            Some(false) => 2,
            Some(true) => 3,
        };
        f
    }

    /// Whether a file that can use the technology may be cited as evidence of it. A file that can use it only because
    /// its records name the file (`middleware.ts`, `route.tsx`, `manifest.ts`) is cited only inside a package that has
    /// the technology (`with_reach`): Expo Router's own `middleware.ts` is not Next.js's. Its hits still order the queue
    /// (eligibility, as measured by the release gate).
    fn citable(&self, x: u32) -> bool {
        let Some(path) = self.paths.get(x as usize) else { return false };
        let (named, imports) = self.named_at[x as usize];
        if named || self.owners.is_empty() || under(path, self.reach) || self.path_names(path) {
            return true;
        }
        let code = own_code(path, self.ecosystem);
        (code && imports) || (code && under(path, self.owners))
    }

    /// `named`: the file names a package (`naming_lits`), and whether at a module position (`module_naming`).
    fn classify(&self, path: &str, (named, imports): (bool, bool)) -> Option<bool> {
        if foreign_code(path, self.ecosystem) {
            return None;
        }
        let code = own_code(path, self.ecosystem);
        if self.path_names(path) || (code && imports) {
            return Some(true);
        }
        let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
        if named || self.config_names.contains(&base) {
            return Some(false);
        }
        (code && under(path, self.owners)).then_some(false)
    }

    /// Whether a whole-token hit of `lit` in `path` (one of its `Hits::whole` files) shows the technology in use, by the
    /// rule evidence is shown with: the applied check.
    pub fn counts(&self, lit: &str, path: &str) -> bool {
        self.file(path).is_some_and(|about| about || !plain_word(lit))
    }

    /// A literal's evidence in one pass over its hits (`by_path`: `role` is the path's own role, which `find`'s order
    /// already follows, so only the first file is asked).
    pub fn evidence(&self, lit: &str, role: impl Fn(&str) -> Role, by_path: bool) -> Evidence {
        self.evidence_with(lit, role, by_path, false, |_| true)
    }

    /// `evidence` from files holding the whole literal: a dotted literal matched only by its tail (a plain word or
    /// not) is left out everywhere. For a deprecated key that word is often the successor's name (`browser.isolate`, replaced by
    /// `isolate`), so a tail match would cite the code that already moved.
    #[cfg(test)]
    pub fn exact_evidence(&self, lit: &str, role: impl Fn(&str) -> Role, by_path: bool) -> Evidence {
        self.evidence_with(lit, role, by_path, true, |_| true)
    }

    /// `exact_evidence` from the files `keep` accepts (`live_site`: a deprecated literal in a comment, or kept as the
    /// fallback beside its replacement, is not live use). A file left out still orders the queue (`Evidence::used`).
    pub fn exact_evidence_where(&self, lit: &str, role: impl Fn(&str) -> Role, by_path: bool, keep: impl Fn(&str) -> bool) -> Evidence {
        self.evidence_with(lit, role, by_path, true, keep)
    }

    /// Whether the code file at `path` configures the technology or calls its API: it imports one of its packages, or is
    /// a config file named for it (`tsdown.config.ts`, `.eslintrc.js`). Not a path that only names it in a directory
    /// (`src/types/` for TypeScript), nor a generic file its records name (`index.ts`): a configuration option written
    /// there is another tool's or the application's own key.
    pub fn configures(&self, path: &str) -> bool {
        self.importing.contains(path) || config_tool(path).is_some_and(|t| self.path_names(&t))
    }

    /// Whether the file at `path` is one the technology runs from rather than imports: a config file named for it
    /// (`vite.config.ts`, `.eslintrc.json`), or a configuration-format file its records name (`tsconfig.json`). A
    /// compiler or build tool used only through such files is still used by the package holding them.
    pub fn runs_from(&self, path: &str) -> bool {
        const CONFIG_EXT: &[&str] = &["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg"];
        let ext = path.rsplit_once('.').map_or("", |(_, x)| x).to_ascii_lowercase();
        config_tool(path).is_some_and(|t| self.path_names(&t)) || (self.record_named(path) && CONFIG_EXT.contains(&ext.as_str()))
    }

    /// Whether the technology's records name the file at `path` (`tsconfig.json`): a config file it reads.
    fn record_named(&self, path: &str) -> bool {
        self.config_names.contains(&path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase())
    }

    fn evidence_with(&self, lit: &str, role: impl Fn(&str) -> Role, by_path: bool, exact: bool, keep: impl Fn(&str) -> bool) -> Evidence {
        let plain = plain_word(lit);
        let ident = identifier(lit);
        let tails = self.hits.tail_only.get(lit);
        let by_tail = self.hits.by_tail.get(lit);
        let mut best: Vec<(bool, Role, usize, &str)> = Vec::with_capacity(4);
        let mut e = Evidence::default();
        let mut cited = 0;
        for (i, x) in self.hits.ix.get(lit).into_iter().flatten().enumerate() {
            let Some(about) = self.file_at(*x) else { continue };
            let tail_hit = by_tail.is_some_and(|t| t.contains(x));
            if exact && tail_hit {
                continue;
            }
            let p = &self.paths[*x as usize];
            let r = if by_path {
                if !e.used {
                    e.app = role(p) == Role::App;
                }
                Role::App
            } else {
                let r = role(p);
                e.app |= r == Role::App;
                r
            };
            e.used = true;
            if tails.is_some_and(|t| t.contains(x)) || (!about && (plain || ((ident || tail_hit) && !self.record_named(p)))) {
                continue;
            }
            let key = (!about, r, i, p.as_str());
            // A deprecated literal counts every citable file, so a capped list can say how many it leaves out.
            let better = best.len() < 3 || key < best[2];
            if (better || exact) && self.citable(*x) && keep(p) {
                cited += 1;
                if better {
                    let at = best.partition_point(|k| *k < key);
                    best.insert(at, key);
                    best.truncate(3);
                }
            }
        }
        e.more = if exact { cited - best.len() } else { 0 };
        e.files = best.into_iter().map(|(not_about, _, _, p)| (p.to_string(), !not_about)).collect();
        e
    }
}

/// Whether `path` is inside one of the package directories `dirs` (`.` is the root; none known: every file).
fn under(path: &str, dirs: &[&str]) -> bool {
    dirs.is_empty() || dirs.iter().any(|o| *o == "." || path.strip_prefix(*o).is_some_and(|rest| rest.starts_with('/')))
}

/// A literal's evidence for one technology (`Scope::evidence`).
#[derive(Debug, Default)]
pub struct Evidence {
    /// Up to three files that show it is used, files about the technology first, then by role, then in `find`'s
    /// order; each with whether it is about the technology.
    pub files: Vec<(String, bool)>,
    /// For a deprecated literal (`exact_evidence_where`): how many more files would be cited than `files` holds.
    pub more: usize,
    /// It occurs in a file that can use the technology, which is what orders the queue. A plain word counts too:
    /// ignoring it outside files about the technology lost a held-out key change in the release gate.
    pub used: bool,
    /// One of those files is application code.
    pub app: bool,
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

/// Lines either side of a deprecated literal within which its replacement makes the site a fallback (`live_site`):
/// `try { require('new') } catch { require('old') }`, `obj.newApi ? obj.newApi() : obj.oldApi()`.
pub const SITE_LINES: usize = 5;

/// How comments are written in a file, by extension: C-style (`//`, `/* */`) in the JS family and JSONC, `#` in
/// Python, YAML and TOML, block comments only in stylesheets.
#[derive(Clone, Copy, PartialEq)]
enum CommentStyle {
    CLike,
    Hash,
    Block,
    None,
}

fn comment_style(path: &str) -> CommentStyle {
    let ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" | "astro" | "jsonc" | "json5" | "prisma" | "graphql" | "gql" => {
            CommentStyle::CLike
        }
        "py" | "pyi" | "yml" | "yaml" | "toml" => CommentStyle::Hash,
        "css" | "scss" => CommentStyle::Block,
        _ => CommentStyle::None,
    }
}

/// Byte ranges of `text` that are comments, skipping string literals (`'…'`, `"…"`, `` `…` ``, with escapes) so a URL
/// in a string is not a `//` comment. A lexer, not a parser: regular-expression literals are read as code.
fn comment_spans(path: &str, text: &str) -> Vec<(usize, usize)> {
    let style = comment_style(path);
    let mut out = vec![];
    if style == CommentStyle::None {
        return out;
    }
    let b = text.as_bytes();
    let mut i = 0;
    let line_end = |from: usize| text[from..].find('\n').map_or(b.len(), |n| from + n);
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        match c {
            b'\'' | b'"' | b'`' if style != CommentStyle::Block || c != b'`' => {
                let q = c;
                i += 1;
                while i < b.len() && b[i] != q {
                    // A quote's string ends at the line's end, except a template literal or a Python triple quote.
                    if b[i] == b'\n' && q != b'`' {
                        break;
                    }
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            b'/' if style != CommentStyle::Hash && next == Some(b'*') => {
                let end = text[i + 2..].find("*/").map_or(b.len(), |n| i + 2 + n + 2);
                out.push((i, end));
                i = end;
            }
            b'/' if style == CommentStyle::CLike && next == Some(b'/') => {
                let end = line_end(i);
                out.push((i, end));
                i = end;
            }
            b'#' if style == CommentStyle::Hash => {
                let end = line_end(i);
                out.push((i, end));
                i = end;
            }
            _ => i += 1,
        }
    }
    out
}

/// Whether `text` (the file at `path`) uses deprecated literal `lit` live at some site: an occurrence as a whole token
/// that is not in a comment and has none of `replacements` (the record's named successor) within `SITE_LINES` lines.
/// Code that loads the replacement and keeps the old API only as a fallback beside it, or a test exercising both, has
/// already moved. A file named `lit` (`middleware.ts`) is its use, and for a file-name literal (`file_name`) only it.
#[cfg(test)]
pub fn live_site(path: &str, text: &str, lit: &str, replacements: &[String]) -> bool {
    live_site_near(path, text, lit, replacements, None, false)
}

/// `live_site`, and with `context` (`Some`) a site counts only where one of those literals also occurs (whole token,
/// outside comments) within `SITE_LINES` lines: a namespace the technology's other APIs live under (`pytest.mark`,
/// `namespace_of`) says nothing about which of them is used, so it takes the record's specific literals beside it
/// (`@pytest.mark.tryfirst` above `def pytest_addoption`). `Some(&[])`: never.
///
/// `keyed`: the record's deprecated API is an object property or option key (`keyed_api`), so in JavaScript-family code
/// a site counts only where the identifier is written as a key or a member (`key_or_member`): a module-level
/// `const defaultOptions = {...}` and its references are a variable of the same name, not the property.
#[cfg(test)]
pub fn live_site_near(path: &str, text: &str, lit: &str, replacements: &[String], context: Option<&[String]>, keyed: bool) -> bool {
    live_site_under(path, text, lit, replacements, context, keyed, None)
}

/// `live_site_near`, and with `parent` (`Some`) a site counts only where it is written under that key (`under_key`): an
/// option value the record names as the option of one key (`as-needed` of ESLint's `radix`) is not that option under
/// another key in the same file (`'@stylistic/arrow-parens': ['error', 'as-needed']`).
pub fn live_site_under(path: &str, text: &str, lit: &str, replacements: &[String], context: Option<&[String]>, keyed: bool, parent: Option<&str>) -> bool {
    if parent.is_some_and(|k| !text.contains(k)) {
        return false;
    }
    if context.is_some_and(|c| c.is_empty()) {
        return false;
    }
    if is_file(path, lit) {
        return true;
    }
    if file_name(lit) {
        return false;
    }
    let comments = comment_spans(path, text);
    let in_comment = |at: usize| {
        let k = comments.partition_point(|(s, _)| *s <= at);
        k > 0 && at < comments[k - 1].1
    };
    let b = text.as_bytes();
    let wordish = |c: Option<&u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-' || *c >= 0x80);
    let sites = |needle: &str| -> Vec<usize> {
        let n = needle.as_bytes();
        let (first, last) = (n.first(), n.last());
        text.match_indices(needle)
            .filter(|(at, _)| {
                let before = at.checked_sub(1).and_then(|i| b.get(i));
                let after = b.get(at + n.len());
                (!wordish(first) || !wordish(before)) && (!wordish(last) || !wordish(after))
            })
            .map(|(at, _)| at)
            .filter(|at| !in_comment(*at))
            .collect()
    };
    let starts: Vec<usize> = text.match_indices('\n').map(|(i, _)| i).collect();
    let line_of = |at: usize| starts.partition_point(|&n| n < at);
    let near: Vec<usize> = replacements.iter().flat_map(|r| sites(r)).map(line_of).collect();
    let beside: Option<Vec<usize>> = context.map(|c| c.iter().flat_map(|x| sites(x)).map(line_of).collect());
    let keyed = keyed && js_code(path);
    let prefix = name_prefix(lit) && !style_file(path);
    sites(lit)
        .into_iter()
        .filter(|at| !keyed || key_or_member(b, *at, lit.len()))
        .filter(|at| !prefix || class_site(b, *at))
        .filter(|at| parent.is_none_or(|k| under_key(b, *at, k, !js_code(path))))
        .map(line_of)
        .filter(|l| beside.as_ref().is_none_or(|b| b.iter().any(|x| x.abs_diff(*l) <= SITE_LINES)))
        .any(|l| !near.iter().any(|r| r.abs_diff(l) <= SITE_LINES))
}

/// Whether `lit` names a family of names by their common prefix (`start-` of a record's `start-*`): class, utility or
/// attribute names, which are written in markup and stylesheets, so in other code only a class context is its use
/// (`class_site`). A word or hyphenated word ending in `-`; not a flag or custom property (`--x`).
pub fn name_prefix(lit: &str) -> bool {
    lit.len() >= 3
        && lit.ends_with('-')
        && lit.starts_with(|c: char| c.is_ascii_alphabetic())
        && lit.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Whether `path` is a stylesheet (`STYLE_EXT`).
fn style_file(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, x)| STYLE_EXT.contains(&x.to_ascii_lowercase().as_str()))
}

/// Whether `s` (a string literal's content) reads as a class list: two or more space-separated tokens of class
/// characters, at least two of them compound (`-` or `:`: `flex start-0 md:px-2`), not prose or one name (`start-1`).
fn class_list(s: &str) -> bool {
    let toks: Vec<&str> = s.split_ascii_whitespace().collect();
    let classy = |t: &str| t.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_:/.[]!#%(),${}".contains(&c));
    toks.len() >= 2 && toks.iter().all(|t| classy(t)) && toks.iter().filter(|t| t.contains(['-', ':'])).count() >= 2
}

/// The string literals in `b[from..to]` (quotes on one line), contents only.
fn strings_in(b: &[u8], from: usize, to: usize) -> Vec<&str> {
    let (mut out, mut i) = (vec![], from);
    while i < to {
        let q = b[i];
        if matches!(q, b'\'' | b'"' | b'`')
            && let Some(k) = b[i + 1..to].iter().position(|x| *x == q || *x == b'\n')
                && b[i + 1 + k] == q
            {
                out.push(std::str::from_utf8(&b[i + 1..i + 1 + k]).unwrap_or(""));
                i += k + 2;
                continue;
            }
        i += 1;
    }
    out
}

/// Whether the occurrence at `at` is in a class context of markup or code: its string is a class list (`class_list`);
/// it is the value of an attribute or key named for classes (`class="…"`, `className={…}`, `:class`, `classes: {…}`),
/// directly or inside an expression there (`className={cn('a', x && 'start-0')}`); an argument of a call named for
/// classes (`clsx(…)`, `classList.add(…)`) or of one whose other arguments are class lists (`cn('flex px-2', …)`); or
/// on an `@apply` line. Within the enclosing statement, tag or 600 bytes; a lexer's view, like `under_key`. A test
/// recording `'start-1'` or `` `end-${id}` `` in an array is none of these.
fn class_site(b: &[u8], at: usize) -> bool {
    let line_start = b[..at].iter().rposition(|c| *c == b'\n').map_or(0, |i| i + 1);
    if b[line_start..at].windows(6).any(|w| w == b"@apply") {
        return true;
    }
    // Named for classes: `class` or its common abbreviation `cls` in the name (`className`, `clsx`, `btnCls`).
    let classy_name = |s: &[u8]| {
        let s = s.to_ascii_lowercase();
        s.windows(5).any(|w| w == b"class") || s.windows(3).any(|w| w == b"cls")
    };
    let ident_before = |end: usize| -> &[u8] {
        let mut e = end;
        while e > 0 && matches!(b[e - 1], b' ' | b'\t') {
            e -= 1;
        }
        if e > 0 && matches!(b[e - 1], b'\'' | b'"') {
            e -= 1;
        }
        let mut s = e;
        while s > 0 && (b[s - 1].is_ascii_alphanumeric() || matches!(b[s - 1], b'_' | b'-' | b'$' | b':' | b'.')) {
            s -= 1;
        }
        &b[s..e]
    };
    // The site's own string literal (quotes on its line).
    let mut j = at;
    if let Some(k) = b[line_start..at].iter().rposition(|c| matches!(c, b'\'' | b'"' | b'`')) {
        let q = b[line_start + k];
        let open = line_start + k;
        if let Some(e) = b[at..].iter().position(|c| *c == q || *c == b'\n')
            && b[at + e] == q
        {
            if class_list(std::str::from_utf8(&b[open + 1..at + e]).unwrap_or("")) {
                return true;
            }
            j = open;
        }
    }
    let lo = at.saturating_sub(600);
    let mut depth = 0usize;
    while j > lo {
        j -= 1;
        let c = b[j];
        match c {
            b'\'' | b'"' | b'`' => {
                if let Some(k) = b[lo..j].iter().rposition(|x| *x == c || *x == b'\n')
                    && b[lo + k] == c
                {
                    j = lo + k;
                }
            }
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' => {
                if classy_name(ident_before(j)) {
                    return true;
                }
                let end = (j + 2000).min(b.len());
                let mut d = 0usize;
                let close = b[j..end].iter().position(|x| {
                    match x {
                        b'(' => d += 1,
                        b')' => d -= 1,
                        _ => {}
                    }
                    d == 0
                });
                if strings_in(b, j, close.map_or(end, |k| j + k)).into_iter().any(class_list) {
                    return true;
                }
            }
            b';' | b'<' if depth == 0 => return false,
            b'>' if depth == 0 && (j == 0 || b[j - 1] != b'=') => return false,
            b'=' | b':' if depth == 0 && !matches!(b.get(j + 1), Some(b'=' | b'>' | b':')) && (j == 0 || !matches!(b[j - 1], b'=' | b'!' | b'<' | b'>' | b':'))
                && classy_name(ident_before(j)) => {
                    return true;
                }
            _ => {}
        }
    }
    false
}

/// Whether `path` is JavaScript-family code (TypeScript, JSX, Vue, Svelte, Astro).
fn js_code(path: &str) -> bool {
    let ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" | "astro")
}

/// Whether the token at `at` (`len` bytes) is written as an object key or a member: `name: …` or `'name': …` after `{`,
/// `,` or `;` (an object literal or a type's members), `{ name }` / `, name,` shorthand inside braces, or `x.name`. Not a binding
/// (`const name = …`, `const name: T`, a parameter `(name: T)`), a reference (`name.field`, `f(name)`) or a spread
/// (`...name`). A lexer's view: a ternary's `? name :` is not a key either.
fn key_or_member(b: &[u8], at: usize, len: usize) -> bool {
    let ws = |c: u8| c.is_ascii_whitespace();
    let prev_at = |mut i: usize| {
        while i > 0 && ws(b[i - 1]) {
            i -= 1;
        }
        i.checked_sub(1).map(|j| (j, b[j]))
    };
    let next_at = |mut i: usize| {
        while i < b.len() && ws(b[i]) {
            i += 1;
        }
        b.get(i).map(|c| (i, *c))
    };
    if at > 0 && b[at - 1] == b'.' && (at < 2 || b[at - 2] != b'.') {
        return true;
    }
    let (mut start, mut end) = (at, at + len);
    if let (Some(&q), Some(&q2)) = (at.checked_sub(1).and_then(|i| b.get(i)), b.get(end))
        && (q == b'\'' || q == b'"')
        && q2 == q
    {
        (start, end) = (at - 1, end + 1);
    }
    let Some((_, before)) = prev_at(start) else { return false };
    if !matches!(before, b'{' | b',' | b';') {
        return false;
    }
    match next_at(end) {
        Some((i, b'?')) => matches!(next_at(i + 1), Some((j, b':')) if b.get(j + 1) != Some(&b':')),
        Some((i, b':')) => b.get(i + 1) != Some(&b':'),
        Some((_, b',' | b'}')) => start == at && opener(b, start) == Some(b'{'),
        _ => false,
    }
}

/// The unmatched bracket before `at` (`{` of an object literal, `(` of a call's arguments), by counting brackets back.
/// Whether the value at `at` is written under the key `key`: one of the nearest three keys of the containers enclosing
/// it, innermost first, is `key` (quoted or not), within 4000 bytes. `'as-needed'` is under `radix` in
/// `radix: ['error', 'as-needed']`, `"radix": ["error", "as-needed"]` and a YAML `radix: [error, as-needed]`; not in
/// `'@stylistic/arrow-parens': ['error', 'as-needed']` beside `radix: 'error'`. A key ends at `:` (and at `=` when
/// `assign`: TOML, INI); a sibling's key (after a `,` or `;`) is skipped. A lexer's view; quoted strings are skipped.
fn under_key(b: &[u8], at: usize, key: &str, assign: bool) -> bool {
    let key_at = |end: usize| -> &[u8] {
        let mut e = end;
        while e > 0 && b[e - 1].is_ascii_whitespace() && b[e - 1] != b'\n' {
            e -= 1;
        }
        let quoted = e > 0 && matches!(b[e - 1], b'\'' | b'"');
        if quoted {
            e -= 1;
        }
        let mut s = e;
        while s > 0 && (b[s - 1].is_ascii_alphanumeric() || matches!(b[s - 1], b'_' | b'-' | b'$' | b'@' | b'/' | b'.')) {
            s -= 1;
        }
        &b[s..e]
    };
    let lo = at.saturating_sub(4000);
    let (mut depth, mut sibling, mut keys) = (0usize, false, 0);
    // From before the value's own opening quote.
    let mut j = if at > 0 && matches!(b[at - 1], b'\'' | b'"' | b'`') { at - 1 } else { at };
    while j > lo {
        j -= 1;
        let c = b[j];
        match c {
            b'\'' | b'"' | b'`' => {
                // The string's opening quote on the same line.
                if let Some(k) = b[lo..j].iter().rposition(|x| *x == c || *x == b'\n')
                    && b[lo + k] == c
                {
                    j = lo + k;
                }
            }
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth > 0 => depth -= 1,
            b'(' | b'[' | b'{' => sibling = false,
            b',' | b';' if depth == 0 => sibling = true,
            b':' | b'=' if depth == 0 && !sibling && (c == b':' || assign) && b.get(j + 1) != Some(&c) && (j == 0 || b[j - 1] != c) => {
                if key_at(j) == key.as_bytes() {
                    return true;
                }
                keys += 1;
                if keys == 3 {
                    return false;
                }
                sibling = true;
            }
            _ => {}
        }
    }
    false
}

fn opener(b: &[u8], at: usize) -> Option<u8> {
    let mut depth = 0usize;
    for &c in b[..at].iter().rev() {
        match c {
            b')' | b']' | b'}' => depth += 1,
            b'(' | b'[' | b'{' if depth == 0 => return Some(c),
            b'(' | b'[' | b'{' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// The tool a config file is named for (`vite` for `vite.config.ts`, `prettier` for `.prettierrc.json`): the head of a
/// `<tool>.config.<ext>` or `.<tool>rc[.<ext>]` base name, lowercase.
pub fn config_tool(path: &str) -> Option<String> {
    let base = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    if let Some((head, _)) = base.trim_start_matches('.').split_once(".config.") {
        return Some(head.to_string()).filter(|h| !h.is_empty());
    }
    let head = base.strip_prefix('.')?.split('.').next()?.strip_suffix("rc")?;
    Some(head.to_string()).filter(|h| !h.is_empty())
}

/// The words of an identifier, lowercase, split at `_`, `-` and lower-to-upper case changes (`NextProxy` → `next`,
/// `proxy`; `HTTPServer` stays one word).
pub fn camel_words(id: &str) -> Vec<String> {
    let mut out = vec![];
    for part in id.split(|c: char| !c.is_ascii_alphanumeric()) {
        let mut cur = String::new();
        let mut prev_lower = false;
        for c in part.chars() {
            if c.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
                out.push(std::mem::take(&mut cur).to_ascii_lowercase());
            }
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
            cur.push(c);
        }
        if !cur.is_empty() {
            out.push(cur.to_ascii_lowercase());
        }
    }
    out
}

/// Whether `text` imports, from one of `modules` (the technology's package names, or a subpath of one), a name with
/// one of `words` among its words (`camel_words`): `import { type NextProxy, NextResponse } from 'next/server'` for
/// Next.js's successor `proxy`. A file named for a deprecated convention that does so is already written against the
/// successor. JavaScript-family `import … from` statements only.
pub fn imports_successor(text: &str, modules: &[String], words: &[String]) -> bool {
    !words.is_empty() && imported_names(text, modules).iter().any(|n| camel_words(n).iter().any(|w| words.contains(w)))
}

/// The local names `text` imports from one of `modules` (a package name or a subpath of one), JavaScript-family
/// `import … from` statements: `streamText` from `import { streamText, type UIMessage } from 'ai'`; the alias of
/// `x as y`.
pub fn imported_names(text: &str, modules: &[String]) -> Vec<String> {
    let mut out = vec![];
    let mut rest = text;
    while let Some(i) = rest.find("from") {
        let after = rest[i + 4..].trim_start();
        let head = &rest[..i];
        rest = &rest[i + 4..];
        let Some(q) = after.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
        let spec = after[1..].split(q).next().unwrap_or("");
        if !modules.iter().any(|m| spec == m || spec.strip_prefix(m.as_str()).is_some_and(|r| r.starts_with('/'))) {
            continue;
        }
        let Some(start) = head.rfind("import") else { continue };
        let names = &head[start + 6..];
        if names.contains(';') {
            continue;
        }
        let toks: Vec<&str> = names.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')).filter(|n| !n.is_empty() && *n != "type").collect();
        let mut k = 0;
        while k < toks.len() {
            if toks.get(k + 1) == Some(&"as") {
                if let Some(alias) = toks.get(k + 2) {
                    out.push(alias.to_string());
                }
                k += 3;
            } else {
                out.push(toks[k].to_string());
                k += 1;
            }
        }
    }
    out
}

/// Whether `text` calls `lit` somewhere: the whole identifier followed by `(` (spaces allowed), not where it is
/// declared (`def`, `function`, `fn`, `func`). A record that writes its deprecated API as a call (`json_schema()`) is
/// about calls: the same word as a parameter, a keyword argument or a module path (`json_schema=…`,
/// `utils.json_schema`) is the code's own name.
pub fn called(text: &str, lit: &str) -> bool {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    text.match_indices(lit).any(|(i, _)| {
        let before = &text[..i];
        if before.chars().next_back().is_some_and(word) {
            return false;
        }
        let after = &text[i + lit.len()..];
        if after.chars().next().is_some_and(word) || !after.trim_start_matches([' ', '\t']).starts_with('(') {
            return false;
        }
        let prev = before.trim_end_matches([' ', '\t']).rsplit(|c: char| !word(c)).next().unwrap_or("");
        !matches!(prev, "def" | "function" | "fn" | "func")
    })
}

/// Whether `text` (JavaScript-family code) writes `lit` as a key of an object literal passed straight to a function it
/// imports from one of `modules`: `streamText({ model, system: prompt })` with `streamText` from `ai`. A plain-word
/// option (`system`) is too common to show its API anywhere else; here the call names whose option it is.
pub fn call_key(text: &str, lit: &str, modules: &[String]) -> bool {
    let names = imported_names(text, modules);
    if names.is_empty() {
        return false;
    }
    let b = text.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut from = 0;
    while let Some(i) = text[from..].find(lit).map(|i| i + from) {
        from = i + lit.len();
        if (i > 0 && word(b[i - 1])) || b.get(from).is_some_and(|c| word(*c)) {
            continue;
        }
        let line = text[..i].rsplit('\n').next().unwrap_or("").trim_start();
        if line.contains("//") || line.starts_with('*') {
            continue;
        }
        let tail = text[from..].trim_start_matches([' ', '\t']);
        if !(tail.starts_with(':') || tail.starts_with("?:")) || !matches!(text[..i].trim_end().bytes().last(), Some(b'{' | b',')) {
            continue;
        }
        // The object's opening brace, then the call it is the first argument of: `name(` or `name<T>(` before it.
        let mut depth = 0usize;
        let mut at = None;
        for j in (i.saturating_sub(4000)..i).rev() {
            match b[j] {
                b'}' | b')' | b']' => depth += 1,
                b'{' | b'(' | b'[' if depth > 0 => depth -= 1,
                b'{' => {
                    at = Some(j);
                    break;
                }
                b'(' | b'[' => break,
                _ => {}
            }
        }
        let Some(open) = at else { continue };
        let before = text[..open].trim_end();
        let Some(call) = before.strip_suffix('(') else { continue };
        let call = call.trim_end();
        let call = if call.ends_with('>') { call.rsplit_once('<').map_or(call, |(h, _)| h) } else { call };
        let callee: String = call.bytes().rev().take_while(|c| word(*c)).map(char::from).collect::<Vec<_>>().into_iter().rev().collect();
        if names.contains(&callee) {
            return true;
        }
    }
    false
}

/// Whether `lit` is a bare file name (`middleware.ts`, `next.config.js`): no directory, no whitespace, and a text file
/// extension. Such a literal is a file convention of the technology: only the file itself is its use, never the name
/// written inside other content (`./src/plugins/og.middleware.ts` in an Astro config).
pub fn file_name(lit: &str) -> bool {
    !lit.contains(['/', '\\']) && !lit.contains(char::is_whitespace) && lit.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.trim_start_matches('.').is_empty() && TEXT_EXT.contains(&ext.to_ascii_lowercase().as_str())
    })
}

/// Whether `path` is the file `lit` names (its base name, or the path itself).
pub fn is_file(path: &str, lit: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.eq_ignore_ascii_case(lit) || path.eq_ignore_ascii_case(lit) || path.to_ascii_lowercase().ends_with(&format!("/{}", lit.to_ascii_lowercase()))
}

/// Whether `lit` is a qualified name: identifiers joined by `.` (`pytest.mark`, `config.inicfg`), not a file name
/// (`middleware.ts`, `next.config.js`) and not a member written alone (`.extend`).
pub fn qualified_name(lit: &str) -> bool {
    let parts: Vec<&str> = lit.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|p| is_word(p) && !p.starts_with(|c: char| c.is_ascii_digit()))
        && !TEXT_EXT.contains(&parts[parts.len() - 1].to_ascii_lowercase().as_str())
}

/// Whether `name` names a member of the qualified name `ns`, or something under one (`pytest.mark.parametrize`,
/// `@pytest.mark.xfail(strict=True)` under `pytest.mark`): `ns.` then an identifier that is not a file extension
/// (`next.config.js` is a file, not a member of `next.config`).
pub fn member_of(name: &str, ns: &str) -> bool {
    let Some(rest) = name.strip_prefix('@').unwrap_or(name).strip_prefix(ns).and_then(|r| r.strip_prefix('.')) else { return false };
    let member: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$').collect();
    !member.is_empty() && !member.starts_with(|c: char| c.is_ascii_digit()) && !TEXT_EXT.contains(&member.to_ascii_lowercase().as_str())
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
    /// Each path's `.gitattributes` role once: matching is a glob set per line, asked for every hit file of every
    /// technology.
    attr_roles: Mutex<HashMap<String, Option<Role>>>,
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
    /// A read file's text (`files` is sorted by path).
    pub fn text(&self, path: &str) -> Option<&str> {
        self.files.binary_search_by(|(p, _)| p.as_str().cmp(path)).ok().map(|i| self.files[i].1.as_str())
    }

    /// A file's role: the last matching `.gitattributes` linguist line, else the path's conventions.
    pub fn role(&self, path: &str) -> Role {
        self.role_for(path, &[])
    }

    /// A file's role for one technology: relative to the deepest of `owners` (directories of packages whose manifest
    /// declares the technology) that contains it, so a package's own code is application code for what it declares
    /// whatever its directory is called (`docs/` holding its own Next.js app). `.gitattributes` lines still win.
    pub fn role_for(&self, path: &str, owners: &[&str]) -> Role {
        if !self.attrs.is_empty() {
            let mut memo = self.attr_roles.lock().unwrap_or_else(|e| e.into_inner());
            let attr = *memo.entry(path.to_string()).or_insert_with(|| {
                self.attrs.iter().rev().find(|(g, _)| g.matched_path_or_any_parents(path, false).is_ignore()).map(|(_, r)| *r)
            });
            if let Some(r) = attr {
                return r;
            }
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
        // The reads, most of the time on a large repository, run on every core once the walk has listed the files.
        let mut to_read: Vec<(String, std::path::PathBuf)> = vec![];
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
            to_read.push((rel, e.path().to_path_buf()));
        }
        let texts = par_map(&to_read, |(_, p)| std::fs::read_to_string(p).ok());
        r.files = to_read.into_iter().zip(texts).filter_map(|((rel, _), t)| t.map(|t| (rel, t))).collect();
        r.files.sort_by(|a, b| a.0.cmp(&b.0));
        r.paths.sort();
        r
    }
}

/// `f` over `items` on every core, results in order.
fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get()).min(16);
    if threads < 2 || items.len() < 64 {
        return items.iter().map(&f).collect();
    }
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = items.chunks(chunk).map(|c| scope.spawn(|| c.iter().map(&f).collect::<Vec<R>>())).collect();
        handles.into_iter().flat_map(|h| h.join().expect("worker thread")).collect()
    })
}

/// A search literal as written in a record, cleaned: trailing call parentheses, `/N` suffixes, backticks and
/// quotes removed; shorter than 4 characters is dropped (`fw_spike._lits`).
/// Whether `lit` only loads one of the packages `names` (`from 'chat'`, `require("chat")`, `'chat'`), the whole
/// package rather than an API, entry point or subpath of it.
pub fn loads_only(lit: &str, names: &[String]) -> bool {
    let mut x = lit.trim();
    for p in ["from ", "import(", "import ", "require.resolve(", "require("] {
        if let Some(r) = x.strip_prefix(p) {
            x = r;
            break;
        }
    }
    let x = x.trim().trim_matches(|c: char| c == '\'' || c == '"' || c == '`' || c == '(' || c == ')' || c == ';' || c.is_whitespace());
    names.iter().any(|n| n == x)
}

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
    /// literal → the same files as `usage`, in its order, as indices into `Repo::paths`: per-technology work over
    /// millions of hits indexes rather than hashes paths.
    pub ix: HashMap<String, Vec<u32>>,
    /// Qualified literal → files (indices into `Repo::paths`) it matched only by a plain-word tail (`test.describe` as
    /// `describe`, not the whole literal). Such a hit orders the queue but is never shown as evidence (`Scope`).
    pub tail_only: HashMap<String, HashSet<u32>>,
    /// Qualified literal → files it matched only by its tail, plain word or not (`test.beforeAll` as `beforeAll`): left
    /// out of `Scope::exact_evidence`, and elsewhere shown only under the identifier rule.
    pub by_tail: HashMap<String, HashSet<u32>>,
    /// CLI-flag literal (`cli_flag`) → file (index into `Repo::paths`) → the command words (`find_with_commands`'
    /// `commands`) on the lines holding it; `*` when one occurrence is a CSS custom property (a stylesheet,
    /// `var(--x`, `--x:`). The funnel keeps a flag's hit only where a word runs its technology (`flag_filtered`).
    pub flag_lines: HashMap<String, HashMap<u32, BTreeSet<String>>>,
}

/// Mark in `Hits::flag_lines` for an occurrence that is a CSS custom property.
pub const CSS_PROPERTY: &str = "*";


impl Hits {
    pub fn used(&self, lit: &str) -> bool {
        self.usage.get(lit).is_some_and(|f| !f.is_empty())
    }
}

/// Match `usage_lits` (the ordering rule: a word literal as a token, anything else as a substring, or its tail
/// as a token) and `whole_lits` (whole tokens or file names only).
pub fn find(repo: &Repo, usage_lits: &BTreeSet<String>, whole_lits: &BTreeSet<String>) -> Hits {
    find_with_commands(repo, usage_lits, whole_lits, &BTreeSet::new())
}

/// `find`, also noting for each CLI-flag literal which of `commands` (lowercase words that run a technology,
/// `command_words`) share a command line with it (`Hits::flag_lines`). Empty `commands`: no flag is noted.
pub fn find_with_commands(repo: &Repo, usage_lits: &BTreeSet<String>, whole_lits: &BTreeSet<String>, commands: &BTreeSet<String>) -> Hits {
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
    // Literals whose tail is a plain word: a hit by the tail alone is recorded as such.
    let plain_tail: Vec<bool> = usage_ix.iter().map(|(_, _, t, _)| t.is_some_and(|t| plain_word(&patterns[t]))).collect();
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
    // Per file, the usage and whole literals it holds; files are matched on every core and merged in file order.
    let is_flag: Vec<bool> = patterns.iter().map(|p| cli_flag(p)).collect();
    let flag_pat: Vec<bool> = is_flag.iter().map(|f| *f && !commands.is_empty()).collect();
    let per_file = par_map(&repo.files, |(path, text)| {
        let b = text.as_bytes();
        let mut bits: HashMap<usize, u8> = HashMap::new();
        let style = path.rsplit_once('.').is_some_and(|(_, x)| STYLE_EXT.contains(&x.to_ascii_lowercase().as_str()));
        let mut flags: Vec<(usize, BTreeSet<String>)> = vec![];
        for m in ac.find_overlapping_iter(text) {
            let p = m.pattern().as_usize();
            // A flag is a whole word: `--run` is not in `--runner`, `--runInBand`, `var(--run-data--color)` or `--custom--run`.
            if is_flag[p] && (wordish(m.start().checked_sub(1).map(|i| b[i])) || wordish(b.get(m.end()).copied())) {
                continue;
            }
            if flag_pat[p] {
                let css = style || text[..m.start()].ends_with("var(") || b.get(m.end()) == Some(&b':');
                let words: BTreeSet<String> = if css {
                    [CSS_PROPERTY.to_string()].into()
                } else {
                    line_words(text, m.start()).filter(|w| commands.contains(w)).collect()
                };
                match flags.iter_mut().find(|(q, _)| *q == p) {
                    Some((_, ws)) => ws.extend(words),
                    None => flags.push((p, words)),
                }
            }
            let before = if m.start() == 0 { None } else { Some(b[m.start() - 1]) };
            let after = b.get(m.end()).copied();
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
        // A relative path in a manifest's own layout (`"exports": {"./src/*": …}`) is the repository's package, not a
        // dependency's: such a literal counts there only when it also occurs outside those fields.
        // Its tail (`client` of `./src/setup.client`) does not stand in for it there either.
        let mut own_layout: HashSet<usize> = HashSet::new();
        if path.rsplit('/').next() == Some("package.json") && bits.keys().any(|p| relative_path(&patterns[*p])) {
            let rest = without_own_layout(text);
            own_layout = bits
                .keys()
                .copied()
                .filter(|p| relative_path(&patterns[*p]) && rest.as_ref().is_some_and(|r| !r.contains(patterns[*p].as_str())))
                .collect();
            bits.retain(|p, _| !own_layout.contains(p));
        }
        let (mut usage, mut whole, mut tail): (Vec<usize>, Vec<usize>, Vec<(usize, bool)>) = (vec![], vec![], vec![]);
        if bits.is_empty() {
            return (usage, whole, tail, flags);
        }
        let has = |p: usize, bit: u8| bits.get(&p).is_some_and(|v| v & bit != 0);
        let mut cand: Vec<usize> = bits.keys().flat_map(|p| usage_by_pat[*p].iter().copied()).collect();
        cand.sort_unstable();
        cand.dedup();
        for i in cand {
            let (_, p, t, word_lit) = usage_ix[i];
            if own_layout.contains(&p) {
                continue;
            }
            let full = if word_lit { has(p, TOKEN) } else { has(p, ANY) };
            let by_tail = !word_lit && !full && t.is_some_and(|t| has(t, TOKEN));
            if full || by_tail {
                usage.push(i);
            }
            if by_tail {
                tail.push((i, plain_tail[i]));
            }
        }
        for i in bits.keys().flat_map(|p| whole_by_pat[*p].iter().copied()) {
            if has(whole_ix[i].1, WHOLE) {
                whole.push(i);
            }
        }
        (usage, whole, tail, flags)
    });
    // Hit files by index into `repo.files` (sorted by path) until the end: a large repository has millions of
    // literal × file hits.
    let at: HashMap<&str, u32> = repo.paths.iter().enumerate().map(|(i, p)| (p.as_str(), i as u32)).collect();
    let path_ix: Vec<u32> = repo.files.iter().map(|(p, _)| at.get(p.as_str()).copied().unwrap_or(u32::MAX)).collect();
    let mut usage_files: Vec<Vec<usize>> = vec![vec![]; usage_ix.len()];
    for (f, (usage, whole, tail, flags)) in per_file.into_iter().enumerate() {
        for (p, words) in flags {
            hits.flag_lines.entry(patterns[p].clone()).or_default().entry(path_ix[f]).or_default().extend(words);
        }
        for i in usage {
            usage_files[i].push(f);
        }
        for (i, plain) in tail {
            if plain {
                hits.tail_only.entry(usage_ix[i].0.clone()).or_default().insert(path_ix[f]);
            }
            hits.by_tail.entry(usage_ix[i].0.clone()).or_default().insert(path_ix[f]);
        }
        for i in whole {
            hits.whole.entry(whole_ix[i].0.clone()).or_default().push(repo.files[f].0.clone());
        }
    }
    // Application files first, so the evidence a reader sees (the first few) is production use when there is any;
    // then by path. A file's role is computed once, however many literals it holds.
    let mut roles: Vec<Option<Role>> = vec![None; repo.files.len()];
    let mut by_path: Vec<usize> = (0..repo.files.len()).collect();
    by_path.sort_unstable_by(|a, b| repo.files[*a].0.cmp(&repo.files[*b].0));
    let mut rank = vec![0; repo.files.len()];
    for (r, f) in by_path.into_iter().enumerate() {
        rank[f] = r;
    }
    for (i, files) in usage_files.into_iter().enumerate() {
        let l = usage_ix[i].0;
        let mut ranked: Vec<(Role, usize, &str, u32)> = files
            .into_iter()
            .map(|f| (*roles[f].get_or_insert_with(|| repo.role(&repo.files[f].0)), rank[f], repo.files[f].0.as_str(), path_ix[f]))
            .collect();
        ranked.sort_unstable();
        // A file-name literal (`middleware.ts`, `prisma/schema.prisma`) also matches a file of that name.
        if l.contains('.') && !l.contains(char::is_whitespace) && repo.names.contains(l) {
            let suffix = format!("/{l}");
            let mut named: Vec<(Role, &str, u32)> = ranked.iter().map(|(r, _, p, x)| (*r, *p, *x)).collect();
            named.extend(
                repo.paths.iter().enumerate().filter(|(_, p)| *p == l || p.ends_with(&suffix)).map(|(x, p)| (repo.role(p), p.as_str(), x as u32)),
            );
            named.sort_unstable();
            named.dedup();
            ranked = named.into_iter().map(|(r, p, x)| (r, 0, p, x)).collect();
        }
        if !ranked.is_empty() {
            hits.ix.insert(l.clone(), ranked.iter().map(|(.., x)| *x).collect());
            hits.usage.insert(l.clone(), ranked.into_iter().map(|(_, _, p, _)| p.to_string()).collect());
        }
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

/// The central term-rarity sample: for each term, how many of the sample repositories contain it, by exactly the rule
/// the funnel ranks with (`find`'s usage match on the term as `clean_lit` cleans it). A term `clean_lit` drops counts
/// 0; the edge never matches it either.
pub fn sample_counts(repos: &[Repo], terms: &[String]) -> BTreeMap<String, u32> {
    let lits: BTreeMap<&String, String> = terms.iter().filter_map(|t| clean_lit(t).map(|l| (t, l))).collect();
    let set: BTreeSet<String> = lits.values().cloned().collect();
    let hits: Vec<Hits> = repos.iter().map(|r| find(r, &set, &BTreeSet::new())).collect();
    terms.iter().map(|t| (t.clone(), lits.get(t).map_or(0, |l| hits.iter().filter(|h| h.used(l)).count() as u32))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_is_the_identifier_then_a_parenthesis_not_a_declaration_or_a_name() {
        assert!(called("schema = Model.json_schema()", "json_schema"));
        assert!(called("x = json_schema (m)", "json_schema"));
        assert!(!called("args_schema=json_schema_to_model(json_schema=params)", "json_schema"), "a keyword and a longer helper");
        assert!(!called("from composio.utils.json_schema import dereference_json_schema\ndereference_json_schema(s)", "json_schema"));
        assert!(!called("def json_schema(self):", "json_schema"), "its own definition");
        assert!(!called("function json_schema() {}", "json_schema"));
    }

    fn repo(files: &[(&str, &str)]) -> Repo {
        let mut r = Repo::default();
        for (p, t) in files {
            r.files.push((p.to_string(), t.to_string()));
            r.names.insert(p.to_string());
            r.names.insert(p.rsplit('/').next().unwrap().to_string());
            r.paths.push(p.to_string());
        }
        r.files.sort_by(|a, b| a.0.cmp(&b.0));
        r
    }
    fn set(x: &[&str]) -> BTreeSet<String> {
        x.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn cli_flags_are_whole_words_and_note_the_command_line() {
        let r = repo(&[
            ("package.json", "{\"bench\": \"vitest bench --run\",\n\"x\": \"node s.mjs --runner direct\"}"),
            ("a.vue", "<style>.a { color: var(--run-data--color) }</style>"),
            ("b.css", ".b { --run: 1 }"),
            ("c.json", "{\"x\": \"vitest --custom--run\"}"),
        ]);
        let h = find_with_commands(&r, &set(&["--run"]), &set(&[]), &set(&["vitest", "node"]));
        assert_eq!(h.usage["--run"], vec!["b.css".to_string(), "package.json".to_string()], "not `--runner` nor `--run-data`");
        let words = &h.flag_lines["--run"];
        assert_eq!(words[&0], set(&["vitest"]), "package.json: the words of the line holding it");
        assert_eq!(words[&2], set(&[CSS_PROPERTY]));
        assert!(cli_flag("--scope") && cli_flag("--import tsx") && !cli_flag("-webkit-mask") && !cli_flag("--") && !cli_flag("---"));
        assert_eq!(command_words("pkg:npm/%40playwright/test"), vec!["playwright"], "`test` is any script's name");
        assert_eq!(command_words("pkg:npm/%40biomejs/biome"), vec!["biomejs", "biome"]);
        assert_eq!(command_words("pkg:npm/webpack-cli"), vec!["webpack-cli", "webpack"]);
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
    fn plain_words_are_one_lowercase_or_capitalised_word() {
        for w in ["cache", "plugins", "Comment", ".extend", "regex", "json2"] {
            assert!(plain_word(w), "{w}");
        }
        for w in ["setTimeout", "minimumCacheTTL", "z.object", "next/cache", "NODE_ENV", "eslint:recommended", "@apply", "schema.prisma", "URL"] {
            assert!(!plain_word(w), "{w}");
        }
    }

    #[test]
    fn naming_literals_follow_each_ecosystems_module_syntax() {
        let vt = naming_lits("pkg:npm/vitest");
        assert_eq!(vt[..4], ["'vitest'", "'vitest/", "\"vitest\"", "\"vitest/"]);
        for at in [
            "import { x } from 'vitest'",
            "import 'vitest/globals'",
            "await import(\"vitest\")",
            "require('vitest')",
            "vi.mock('vitest/x')",
            "vi.doMock(\"vitest\", () => ({}))",
            "await vi.importActual('vitest')",
            "/// <reference types=\"vitest\" />",
        ] {
            assert!(vt.iter().any(|l| module_naming(l) && at.contains(l.as_str())), "{at}");
        }
        for not in ["type T = 'vitest' | 'jest'", "path.resolve('vitest')", "const m = mock('vitest')"] {
            assert!(!vt.iter().any(|l| module_naming(l) && not.contains(l.as_str())), "a string is not an import: {not}");
        }
        assert_eq!(naming_lits("pkg:npm/%40playwright/test")[0], "'@playwright/test'");
        let py = naming_lits("pkg:pypi/requests");
        for named in ["import requests\n", "from requests.adapters", "\"requests>=2", "'requests'"] {
            assert!(py.iter().any(|l| named.contains(l.as_str())), "{named}");
        }
        for other in ["import requests_cache\n", "from requests_oauthlib import x", "\"requests-toolbelt>=1"] {
            assert!(!py.iter().any(|l| other.contains(l.as_str())), "{other}");
        }
        assert!(naming_lits("pkg:cargo/serde").is_empty());
    }

    /// `find` over `files` with the literals and each package's naming literals, then a scope for those packages.
    fn scoped(r: &Repo, lits: &[&str], purls: &[&str]) -> Hits {
        let mut usage = set(lits);
        usage.extend(purls.iter().flat_map(|p| naming_lits(p)));
        find(r, &usage, &set(&[]))
    }

    #[test]
    fn only_files_that_can_use_a_technology_evidence_it() {
        let r = repo(&[
            ("src/app.ts", "const x = 1"),
            ("src/client.test.ts", "import { describe } from 'vitest'"),
            ("vitest.config.ts", "export default {}"),
            ("devenv/dashboards/table.json", "{\"cache\": true}"),
            ("public/locales/en-US/app.json", "{\"plugins\": \"Plugins\"}"),
            (".golangci.yml", "plugins: []"),
            ("package.json", "{\"devDependencies\": {\"vitest\": \"4\"}}"),
            ("sandbox/run.py", "cache = {}"),
            ("tsconfig.json", "{}"),
            ("backend/server.ts", "export {}"),
        ]);
        let purls = vec!["pkg:npm/vitest".to_string()];
        let h = scoped(&r, &[], &["pkg:npm/vitest"]);
        let lits = vec!["tsconfig.json".to_string()];
        let root = ["."];
        let s = Scope::new("npm", &root, &purls, &lits, &h, &r.paths);
        assert_eq!(s.file("src/app.ts"), Some(false), "the ecosystem's code in a package declaring it");
        assert_eq!(s.file("src/client.test.ts"), Some(true), "imports it");
        assert_eq!(s.file("vitest.config.ts"), Some(true), "its path names it");
        assert_eq!(s.file("package.json"), Some(false), "a manifest listing it: can use it, but is not about it");
        assert_eq!(s.file("tsconfig.json"), Some(false), "a file its records name: a config file it reads");
        for none in ["devenv/dashboards/table.json", "public/locales/en-US/app.json", ".golangci.yml", "sandbox/run.py"] {
            assert_eq!(s.file(none), None, "{none}");
        }
        let owners = ["frontend"];
        let s = Scope::new("npm", &owners, &purls, &lits, &h, &r.paths);
        assert_eq!(s.file("backend/server.ts"), None, "no package declaring it encloses the file");
    }

    #[test]
    fn a_quoted_name_in_code_is_not_an_import() {
        // DavidHDev/react-bits: `type Falloff = 'linear' | 'smooth' | 'sharp'` in React components made them "about"
        // sharp, so its plain-word terms (`width`, `left`, `background`) were cited from component code.
        let r = repo(&[
            ("src/CursorGrid.tsx", "export type Falloff = 'linear' | 'sharp'; const width = 1"),
            ("scripts/og.js", "import sharp from 'sharp'; const width = 1"),
            ("scripts/thumbs.cjs", "const s = require(\"sharp\"); s().resize({ width: 1 })"),
            ("package.json", "{\"devDependencies\": {\"sharp\": \"^0.34.5\"}}"),
            ("tools/run.py", "import sharp\nwidth = 1"),
            ("tools/req.py", "deps = ['sharp']"),
        ]);
        let purls = vec!["pkg:npm/sharp".to_string()];
        let h = scoped(&r, &["width"], &["pkg:npm/sharp"]);
        let s = Scope::new("npm", &["."], &purls, &[], &h, &r.paths);
        assert_eq!(s.file("src/CursorGrid.tsx"), Some(false), "code in a package declaring it: can use it, not about it");
        assert_eq!(s.file("scripts/og.js"), Some(true));
        assert_eq!(s.file("scripts/thumbs.cjs"), Some(true));
        assert_eq!(s.file("package.json"), Some(false), "a manifest names it quoted");
        let files: Vec<String> = s.evidence("width", |p: &str| path_role(p), true).files.into_iter().map(|(p, _)| p).collect();
        assert_eq!(files, vec!["scripts/og.js", "scripts/thumbs.cjs"]);
        let py = vec!["pkg:pypi/sharp".to_string()];
        let h = scoped(&r, &[], &["pkg:pypi/sharp"]);
        let s = Scope::new("pypi", &["."], &py, &[], &h, &r.paths);
        assert_eq!(s.file("tools/run.py"), Some(true));
        assert_eq!(s.file("tools/req.py"), Some(false), "a quoted requirement in code is a string");
    }

    #[test]
    fn a_file_a_record_names_counts_only_in_a_package_declaring_the_technology() {
        // expo/expo: only `docs/` declares next; Expo Router's own `middleware.ts`, `Route.tsx` and `manifest.ts` are
        // not Next.js's middleware, route handler or metadata file.
        let r = repo(&[
            ("docs/middleware.ts", "export function middleware() {}"),
            ("packages/expo-server/src/utils/middleware.ts", "export function run() {}"),
            ("packages/expo-router/src/Route.tsx", "/** Returns the exports from +middleware.ts */"),
            ("tsconfig.json", "{}"),
        ]);
        let purls = vec!["pkg:npm/next".to_string()];
        let lits = vec!["middleware.ts".to_string(), "route.tsx".to_string(), "tsconfig.json".to_string()];
        let h = scoped(&r, &["middleware.ts", "strictNullChecks"], &["pkg:npm/next"]);
        let cited = |s: &Scope, lit: &str| -> Vec<String> { s.evidence(lit, |p: &str| path_role(p), true).files.into_iter().map(|(p, _)| p).collect() };
        let s = Scope::new("npm", &["docs"], &purls, &lits, &h, &r.paths);
        let e = s.evidence("middleware.ts", |p: &str| path_role(p), true);
        assert_eq!(e.files, vec![("docs/middleware.ts".to_string(), false)], "Expo's own files are not Next.js's");
        assert!(e.used);
        assert_eq!(s.file("packages/expo-router/src/Route.tsx"), Some(false), "it still orders the queue (eligibility)");
        let reach = ["docs", "packages/expo-server"];
        let via = Scope::new("npm", &["docs"], &purls, &lits, &h, &r.paths).with_reach(&reach);
        let mut c = cited(&via, "middleware.ts");
        c.sort();
        assert_eq!(c, vec!["docs/middleware.ts", "packages/expo-server/src/utils/middleware.ts"], "through a workspace dependency that declares it");
        let none = Scope::new("npm", &[], &purls, &lits, &h, &r.paths);
        assert_eq!(cited(&none, "middleware.ts").len(), 3, "no manifest says: as before");
    }

    #[test]
    fn a_namespace_needs_a_specific_literal_beside_it() {
        assert!(qualified_name("pytest.mark") && qualified_name("config.inicfg") && qualified_name("np.testing.assert_warns"));
        assert!(!qualified_name("middleware.ts") && !qualified_name("next.config.js") && !qualified_name(".extend") && !qualified_name("toBeCalled"));
        assert!(member_of("pytest.mark.parametrize", "pytest.mark") && member_of("@pytest.mark.xfail(strict=True)", "pytest.mark"));
        assert!(!member_of("next.config.js", "next.config") && !member_of("pytest.marker", "pytest.mark") && !member_of("pytest.mark", "pytest.mark"));
        let ctx = vec!["pytest_addoption".to_string()];
        let tests = "@pytest.mark.parametrize('x', [1])\ndef test_a(x): ...\n";
        let key = |t: &str| live_site_near("r.ts", t, "defaultOptions", &[], None, true);
        assert!(key("createRule({\n  defaultOptions: [],\n});"));
        assert!(key("const r = { 'defaultOptions': [] };") && key("f({ defaultOptions })") && key("x = { a, defaultOptions, b }"));
        assert!(key("rule.defaultOptions = [];") && key("type R = { name: string; defaultOptions?: unknown }"));
        assert!(!key("const defaultOptions = { a: 1 };\nconst s = defaultOptions.a;\nObject.assign({}, defaultOptions, b);"), "a variable");
        assert!(!key("function f(defaultOptions: X) {}") && !key("const defaultOptions: X = y;") && !key("g({ ...defaultOptions })"));
        assert!(!key("const v = c ? defaultOptions : 1;"), "a ternary is not a key");
        assert!(live_site_near("r.json", "{\"defaultOptions\": 1}", "defaultOptions", &[], None, true), "keyed applies to code only");
        assert!(live_site_near("r.ts", "const defaultOptions = 1;", "defaultOptions", &[], None, false), "not keyed: as before");
        let under = |t: &str, lit: &str, k: &str| live_site_under("x.yml", t, lit, &[], None, false, Some(k));
        assert!(under("rules:\n  radix: [error, as-needed]\n", "as-needed", "radix"));
        assert!(under("rules:\n  radix:\n    - error\n    - as-needed\n", "as-needed", "radix"), "block YAML");
        assert!(under("{\"radix\": [\"error\", {\"mode\": \"as-needed\"}]}", "as-needed", "radix"), "nested option object");
        assert!(!under("radix: error\narrow-parens:\n  - error\n  - as-needed\n", "as-needed", "radix"));
        assert!(!under("{\"arrow-parens\": [\"error\", \"as-needed\"], \"radix\": \"error\"}", "as-needed", "radix"));
        assert_eq!(camel_words("NextProxy"), ["next", "proxy"]);
        assert_eq!(camel_words("createI18nMiddleware"), ["create", "i18n", "middleware"]);
        assert_eq!(camel_words("HTTPServer_x"), ["httpserver", "x"]);
        let words = ["proxy".to_string()];
        let next = ["next".to_string()];
        assert!(imports_successor("import { type NextProxy, NextResponse } from 'next/server';", &next, &words));
        assert!(imports_successor("import type {\n  NextProxy,\n} from \"next/server\";", &next, &words));
        assert!(!imports_successor("import { NextResponse } from 'next/server';\nconst proxy = 1;", &next, &words));
        assert!(!imports_successor("import { createProxy } from 'http-proxy';", &next, &words));
        assert!(!imports_successor("import { NextProxy } from 'nextra';", &next, &words));
        let ai = ["ai".to_string()];
        let chat = "import {\n  streamText,\n  type UIMessage,\n} from 'ai';\nconst result = streamText({\n  model,\n  tools: { search: { x: 1 } },\n  system: systemPrompt,\n});\n";
        assert!(call_key(chat, "system", &ai));
        assert!(call_key("import { generateText as gen } from 'ai';\nawait gen<T>({ system: 'x' });", "system", &ai));
        assert!(!call_key("import { streamText } from 'ai';\nconst m = [{ role: 'system', content: 'x' }];\nconst o = { system: 1 };", "system", &ai));
        assert!(!call_key("import { streamText } from 'ai';\nfoo({ system: 1 });", "system", &ai));
        assert!(!call_key("import { streamText } from 'ai';\nstreamText({ model, // system: x\n});", "system", &ai));
        assert!(!call_key("import { streamText } from 'ai';\nstreamText({ opts: { system: 1 } });", "system", &ai), "a nested object is another API's");
        assert_eq!(config_tool("docs/vite.config.ts").as_deref(), Some("vite"));
        assert_eq!(config_tool(".prettierrc.json").as_deref(), Some("prettier"));
        assert_eq!(config_tool(".eslintrc").as_deref(), Some("eslint"));
        assert_eq!(config_tool("tsconfig.json"), None);
        assert_eq!(config_tool("src/rc.ts"), None);
        assert!(live_site_near("t.py", tests, "pytest.mark", &[], None, false), "no context asked: as before");
        assert!(!live_site_near("t.py", tests, "pytest.mark", &[], Some(&ctx), false));
        assert!(!live_site_near("t.py", tests, "pytest.mark", &[], Some(&[]), false), "no specific literal: never");
        let hook = "@pytest.mark.tryfirst\ndef pytest_addoption(parser): ...\n";
        assert!(live_site_near("p.py", hook, "pytest.mark", &[], Some(&ctx), false));
        let far = format!("def pytest_addoption(parser): ...\n{}@pytest.mark.skip\ndef test_b(): ...\n", "x = 1\n".repeat(SITE_LINES + 1));
        assert!(!live_site_near("p.py", &far, "pytest.mark", &[], Some(&ctx), false), "the hook elsewhere in the file");
        assert!(!live_site_near("p.py", "# pytest_addoption\n@pytest.mark.skip\n", "pytest.mark", &[], Some(&ctx), false), "a comment is not context");
    }

    #[test]
    fn a_name_prefix_counts_only_in_class_contexts() {
        let live = |p: &str, t: &str| live_site(p, t, "start-", &[]);
        assert!(name_prefix("start-") && name_prefix("bg-opacity-") && !name_prefix("--tw-") && !name_prefix("start"));
        let test = "it('runs', async () => {\n  const run = async (id) => {\n    executionOrder.push(`start-${id}`);\n  };\n  expect(order).toEqual(['start-[1]', `end-${2}`]);\n});\n";
        assert!(!live("src/__tests__/project.test.ts", test), "string literals in a test are not class names");
        assert!(!live("src/log.ts", "log(`start-${id}`, 'started');"));
        assert!(live("src/a.tsx", "<div className={`start-${n}`} />"));
        assert!(live("src/b.tsx", "<div\n  className={cn(\n    'flex',\n    open && `start-${n}`,\n  )}\n/>"));
        assert!(live("src/c.ts", "const v = clsx(`start-${n}`);"));
        assert!(live("src/d.ts", "const v = cva('flex items-center px-2', { variants: { s: { a: `start-${n}` } } });"));
        assert!(live("src/e.ts", "const base = `flex items-center start-${n}`;"));
        assert!(live("src/f.vue", "<div :class=\"{ 'start-[2px]': x }\"></div>"));
        assert!(live("src/g.vue", "<style>\n.a { @apply start-[2px]; }\n</style>"));
        assert!(live("src/h.css", ".a { --x: start-[2px]; }"), "a stylesheet is its context");
        assert!(live("index.html", "<div class=\"start-[2px]\"></div>"));
    }

    #[test]
    fn a_file_name_literal_is_live_only_as_the_file() {
        assert!(file_name("middleware.ts") && file_name("next.config.js") && file_name(".eslintrc.json"));
        assert!(!file_name("z.object") && !file_name("pytest.mark") && !file_name("prisma/schema.prisma") && !file_name(".ts"));
        assert!(live_site("src/middleware.ts", "export {}", "middleware.ts", &[]));
        assert!(!live_site("astro.config.mjs", "plugins: ['./src/plugins/og.middleware.ts', 'middleware.ts']", "middleware.ts", &[]));
    }

    #[test]
    fn a_deprecated_literal_is_live_outside_comments_and_away_from_its_replacement() {
        let old = "react-native/Libraries/Core/InitializeCore";
        let new = vec!["react-native/setup-env".to_string()];
        let fallback = "try {\n  require('react-native/setup-env');\n} catch {\n  // NOTE: fallback for React Native < 0.87\n  require('react-native/Libraries/Core/InitializeCore');\n}\n";
        assert!(!live_site("src/setup.ts", fallback, old, &new), "kept only as a fallback beside the replacement");
        assert!(live_site("src/setup.ts", fallback, old, &[]), "with no replacement known, it is a use");
        let far = format!("require('react-native/setup-env');\n{}require('react-native/Libraries/Core/InitializeCore');\n", "x();\n".repeat(SITE_LINES + 1));
        assert!(live_site("src/a.ts", &far, old, &new), "the replacement elsewhere in the file: this site has not moved");
        let commented = "/** Loads `react-native/Libraries/Core/InitializeCore` first. */\nconst url = 'http://x';// react-native/Libraries/Core/InitializeCore\n";
        assert!(!live_site("src/b.ts", commented, old, &new), "comments only");
        assert!(live_site("src/c.ts", "const u = 'http://react-native/Libraries/Core/InitializeCore';", old, &new), "`//` inside a string is not a comment");
        assert!(!live_site("conf.yaml", "# toBeCalledWith\nkey: 1", "toBeCalledWith", &[]));
        assert!(live_site("app/middleware.ts", "export default function m() {}", "middleware.ts", &[]), "the file of that name is its use");
        assert!(!live_site("src/a.ts", "x.toBeCalledWithArgs()", "toBeCalledWith", &[]), "whole literal only");
        let names = vec!["chat".to_string()];
        assert!(loads_only("from 'chat", &names) && loads_only("require(\"chat\")", &names) && loads_only("chat", &names));
        assert!(!loads_only("from 'chat/ai", &names) && !loads_only("toAiMessages", &names));
    }

    #[test]
    fn paths_name_packages_by_directory_head_or_extension() {
        let h = Hits::default();
        let s = |purl: &str| Scope::new("npm", &[], &[purl.to_string()], &[], &h, &[]).path_names_for_test();
        let eslint = s("pkg:npm/eslint");
        assert!(eslint(".eslintrc.json") && eslint("eslint.config.js") && !eslint("src/lint.ts"));
        let tw = s("pkg:npm/tailwindcss");
        assert!(tw("tailwind.config.js") && tw("src/tailwindcss/theme.css"));
        let pw = s("pkg:npm/%40playwright/test");
        assert!(pw("playwright.config.ts") && pw("e2e/playwright/a.ts") && !pw("src/test/a.ts"), "the scope, not `test`");
        let prisma = s("pkg:npm/prisma");
        assert!(prisma("db/schema.prisma") && prisma("prisma/seed.ts"));
        let icons = s("pkg:npm/react-icons");
        assert!(!icons("src/react/app.tsx"), "`react` is a prefix of react-icons at a word boundary only");
    }

    #[test]
    fn a_plain_word_counts_only_where_the_technology_is_named_and_named_files_come_first() {
        let r = repo(&[
            ("src/a/cache.ts", "export const cache = new Map(); test.describe('x')"),
            ("src/b/store.test.ts", "import { vi } from 'vitest'; const cache = vi.fn(); describe('y')"),
            ("src/c/helper.ts", "beforeAll(() => {}); const cache = 1"),
            ("tests/d/spec.test.ts", "import { test } from 'vitest'; beforeAll(() => {}); test.describe('z')"),
        ]);
        let purls = vec!["pkg:npm/vitest".to_string()];
        let h = scoped(&r, &["cache", "beforeAll", "test.describe"], &["pkg:npm/vitest"]);
        let s = Scope::new("npm", &[], &purls, &[], &h, &r.paths);
        let role = |p: &str| path_role(p);
        let e = s.evidence("cache", role, true);
        assert_eq!(e.files, vec![("src/b/store.test.ts".to_string(), true)], "a plain word, only in the file importing vitest");
        assert!(e.used && e.app, "it still orders the queue, as application code");
        let e = s.evidence("beforeAll", role, true);
        let files: Vec<&str> = e.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(files, vec!["tests/d/spec.test.ts"], "an identifier only where vitest is imported, not a helper's own `beforeAll`");
        assert!(e.used && e.app, "the helper still orders the queue");
        let e = s.evidence("test.describe", role, true);
        let files: Vec<&str> = e.files.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(files, vec!["tests/d/spec.test.ts", "src/a/cache.ts"], "the whole literal; files importing it first");
        let r = repo(&[("src/a.ts", "describe('x')"), ("src/b.test.ts", "import 'vitest'; describe('y')")]);
        let h = scoped(&r, &["test.describe"], &["pkg:npm/vitest"]);
        let s = Scope::new("npm", &[], &purls, &[], &h, &r.paths);
        let e = s.evidence("test.describe", role, true);
        assert!(e.files.is_empty(), "a plain-word tail is not the literal, even where vitest is imported: {:?}", e.files);
        assert!(e.used, "it still orders the queue");
    }

    #[test]
    fn a_term_is_cited_only_from_files_holding_it() {
        // udecode/plate: `z.properties` was cited from files holding only `node.properties`, and typescript-eslint's
        // `defaultOptions` from a local `const defaultOptions` in a package that does not import it.
        let r = repo(&[
            ("src/schema.ts", "import { z } from 'zod'; const s = z.object({}); node.properties.x = 1"),
            ("src/hast.ts", "export const f = (node) => node.properties"),
            ("src/scroll.ts", "const defaultOptions = { block: 'nearest' }"),
            ("src/rule.ts", "import { ESLintUtils } from '@typescript-eslint/utils'; export const r = { defaultOptions: [] }"),
            ("src/view.tsx", "<div className=\"overflow-ellipsis\" />"),
            ("tsconfig.json", "{\"compilerOptions\": {\"strictNullChecks\": true}}"),
            ("src/spec.test.ts", "import { vi } from 'vitest'; expect(f).toBeCalledWith(1)"),
            ("src/jest.test.ts", "expect(f).toBeCalledWith(1)"),
        ]);
        let role = |p: &str| path_role(p);
        let zod = vec!["pkg:npm/zod".to_string()];
        let h = scoped(&r, &["z.properties", "z.object"], &["pkg:npm/zod"]);
        let s = Scope::new("npm", &[], &zod, &[], &h, &r.paths);
        let e = s.evidence("z.properties", role, true);
        assert!(e.files.is_empty() && e.used, "its plain-word tail orders the queue but is not the term: {:?}", e.files);
        assert_eq!(s.evidence("z.object", role, true).files, vec![("src/schema.ts".to_string(), true)]);

        let tse = vec!["pkg:npm/typescript-eslint".to_string(), "pkg:npm/%40typescript-eslint/utils".to_string()];
        let lits = vec!["defaultOptions".to_string(), "tsconfig.json".to_string()];
        let h = scoped(&r, &["defaultOptions", "strictNullChecks"], &["pkg:npm/typescript-eslint", "pkg:npm/%40typescript-eslint/utils"]);
        let s = Scope::new("npm", &[], &tse, &lits, &h, &r.paths);
        for e in [s.evidence("defaultOptions", role, true), s.exact_evidence("defaultOptions", role, true)] {
            assert_eq!(e.files, vec![("src/rule.ts".to_string(), true)], "not a local constant in code that only could use it");
            assert!(e.used);
        }
        assert_eq!(s.evidence("strictNullChecks", role, true).files, vec![("tsconfig.json".to_string(), false)], "a file its records name");

        let tw = vec!["pkg:npm/tailwindcss".to_string()];
        let h = scoped(&r, &["overflow-ellipsis"], &["pkg:npm/tailwindcss"]);
        let s = Scope::new("npm", &[], &tw, &[], &h, &r.paths);
        assert_eq!(s.exact_evidence("overflow-ellipsis", role, true).files, vec![("src/view.tsx".to_string(), false)], "no code declares a class name");

        let vt = vec!["pkg:npm/vitest".to_string()];
        let h = scoped(&r, &["expect.toBeCalledWith"], &["pkg:npm/vitest"]);
        let s = Scope::new("npm", &[], &vt, &[], &h, &r.paths);
        let e = s.evidence("expect.toBeCalledWith", role, true);
        assert_eq!(e.files, vec![("src/spec.test.ts".to_string(), true)], "an identifier tail is the call, where vitest is imported");
        assert!(s.exact_evidence("expect.toBeCalledWith", role, true).files.is_empty());
    }

    #[test]
    fn identifiers_are_single_tokens_of_more_than_one_word() {
        for y in ["defaultOptions", "toBeCalledWith", ".safeParse", "ES2022", "_internal", "$state"] {
            assert!(identifier(y), "{y}");
        }
        for n in ["cache", ".extend", "Comment", "z.object", "overflow-ellipsis", "next/image", "tsconfig.json", "2fa"] {
            assert!(!identifier(n), "{n}");
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
