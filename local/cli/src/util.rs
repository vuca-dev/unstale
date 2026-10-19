//! Small helpers: dates without a calendar crate, lenient npm versions, package URLs, atomic writes.

use anyhow::{Context, Result};
use semver::Version;
use std::path::Path;

/// Today as `YYYY-MM-DD` (UTC). `UNSTALE_TODAY` overrides it, for tests and reproducible runs.
pub fn today() -> String {
    if let Ok(t) = std::env::var("UNSTALE_TODAY")
        && parse_date(&t).is_some() {
            return t;
        }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_days(secs.div_euclid(86_400))
}

/// Days since 1970-01-01 for a `YYYY-MM-DD` date (Howard Hinnant's algorithm).
pub fn parse_date(s: &str) -> Option<i64> {
    let s = s.get(..10)?;
    let mut it = s.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: i64 = it.next()?.parse().ok()?;
    let d: i64 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

pub fn format_days(z: i64) -> String {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn add_days(date: &str, n: i64) -> Option<String> {
    parse_date(date).map(|d| format_days(d + n))
}

/// A version as npm writes it, leniently: `v16`, `16.1`, `=16.1.0`, `16.0.0-canary.3`. Partial versions are
/// padded with zeros.
pub fn parse_version(s: &str) -> Option<Version> {
    let s = s.trim().trim_start_matches(['v', 'V', '=']).trim();
    if s.is_empty() || !s.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    if let Ok(v) = Version::parse(s) {
        return Some(v);
    }
    // Pad a partial version; drop `x` / `*` wildcards (they mean the lowest value).
    let (core, rest) = match s.find(['-', '+']) {
        Some(i) => (&s[..i], &s[i..]),
        None => (s, ""),
    };
    let mut parts: Vec<String> = vec![];
    for p in core.split('.') {
        if p == "x" || p == "X" || p == "*" {
            break;
        }
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts.push(p.trim_start_matches('0').to_string());
    }
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    while parts.len() < 3 {
        parts.push("0".into());
    }
    let parts: Vec<String> = parts.into_iter().map(|p| if p.is_empty() { "0".into() } else { p }).collect();
    Version::parse(&format!("{}{}", parts.join("."), rest)).ok()
}

/// The lowest version an npm range admits (`^16.1.0` → 16.1.0, `>=18 <21 || 22` → 18.0.0). `None` for ranges
/// with no floor (`*`, `latest`, tags, `workspace:`, `file:`, git URLs).
pub fn range_floor(range: &str) -> Option<Version> {
    let range = range.trim();
    let range = range.strip_prefix("npm:").map(|r| r.rsplit_once('@').map(|(_, v)| v).unwrap_or(r)).unwrap_or(range);
    let mut best: Option<Version> = None;
    for alt in range.split("||") {
        let first = alt.split_whitespace().next().unwrap_or("");
        let tok = first.trim_start_matches(['^', '~', '>', '=', '<']);
        // `<2.0.0` alone has no lower bound other than 0.
        let v = if first.starts_with('<') { parse_version("0.0.0") } else { parse_version(tok) };
        let Some(v) = v else { continue };
        if best.as_ref().is_none_or(|b| &v < b) {
            best = Some(v);
        }
    }
    best
}

/// Whether `v` falls in an npm range (`^`, `~`, comparators, `x` wildcards, partial versions, hyphen ranges,
/// `||`). `None` when the range isn't a version range (tags, `workspace:`, `file:`, git URLs), so a caller keeps
/// what it had. Prerelease tags are ignored: this decides staleness, not installability.
pub fn npm_satisfies(v: &Version, range: &str) -> Option<bool> {
    let range = range.trim();
    let range = range.strip_prefix("npm:").map(|r| r.rsplit_once('@').map(|(_, v)| v).unwrap_or(r)).unwrap_or(range);
    let v = &Version::new(v.major, v.minor, v.patch);
    let mut any = false;
    for alt in range.split("||") {
        let toks: Vec<&str> = alt.split_whitespace().collect();
        let ok = if toks.len() == 3 && toks[1] == "-" {
            let (lo, hi) = (partial(toks[0])?, partial(toks[2])?);
            v >= &lo.0
                && match hi.1 {
                    Some(end) => v < &end,
                    None => v <= &hi.0,
                }
        } else {
            let mut all = true;
            let mut i = 0;
            while i < toks.len() {
                // `>= 1.2` is sometimes written with a space; join a lone operator to its version.
                let mut t = toks[i].to_string();
                if t.chars().all(|c| matches!(c, '<' | '>' | '=' | '^' | '~')) && i + 1 < toks.len() {
                    i += 1;
                    t.push_str(toks[i]);
                }
                all &= comparator(v, &t)?;
                i += 1;
            }
            all
        };
        any |= ok;
    }
    Some(any)
}

/// A possibly partial version (`1`, `1.2`, `1.2.x`, `1.2.3`): its floor, the exclusive end of what a partial one
/// covers (`1.2` → 1.3.0), and how many parts it gave. `*` / `x` alone give no parts.
fn partial(tok: &str) -> Option<(Version, Option<Version>, usize)> {
    let tok = tok.trim_start_matches(['v', 'V', '=']);
    let core = tok.split(['-', '+']).next().unwrap_or("");
    let nums: Vec<u64> = core.split('.').map_while(|p| p.parse().ok()).collect();
    if nums.is_empty() {
        return if core.is_empty() || core.starts_with(['x', 'X', '*']) { Some((Version::new(0, 0, 0), None, 0)) } else { None };
    }
    let floor = Version::new(nums[0], *nums.get(1).unwrap_or(&0), *nums.get(2).unwrap_or(&0));
    let end = match nums.len() {
        1 => Some(Version::new(nums[0] + 1, 0, 0)),
        2 => Some(Version::new(nums[0], nums[1] + 1, 0)),
        _ => None,
    };
    Some((floor, end, nums.len().min(3)))
}

fn comparator(v: &Version, t: &str) -> Option<bool> {
    let op_end = t.find(|c: char| !matches!(c, '<' | '>' | '=' | '^' | '~')).unwrap_or(t.len());
    let (op, ver) = t.split_at(op_end);
    if ver.is_empty() {
        return if op.is_empty() { Some(true) } else { None };
    }
    let (base, end, parts) = partial(ver)?;
    if parts == 0 {
        return Some(!matches!(op, "<" | ">")); // `*`, `>=*`; `<*` admits nothing
    }
    Some(match op {
        "" | "=" => match &end {
            Some(e) => v >= &base && v < e,
            None => v == &base,
        },
        ">=" => v >= &base,
        ">" => match &end {
            Some(e) => v >= e,
            None => v > &base,
        },
        "<" => v < &base,
        "<=" => match &end {
            Some(e) => v < e,
            None => v <= &base,
        },
        "~" | "~>" => {
            let e = if parts == 1 { Version::new(base.major + 1, 0, 0) } else { Version::new(base.major, base.minor + 1, 0) };
            v >= &base && v < &e
        }
        "^" => {
            let e = if base.major > 0 || parts == 1 {
                Version::new(base.major + 1, 0, 0)
            } else if base.minor > 0 || parts == 2 {
                Version::new(0, base.minor + 1, 0)
            } else {
                Version::new(0, 0, base.patch + 1)
            };
            v >= &base && v < &e
        }
        _ => return None,
    })
}

/// Canonical npm package URL: `pkg:npm/next`, `pkg:npm/%40prisma/client` (the contract's encoding).
pub fn npm_purl(name: &str) -> String {
    match name.strip_prefix('@') {
        Some(rest) => format!("pkg:npm/%40{rest}"),
        None => format!("pkg:npm/{name}"),
    }
}

/// Normalise a package URL for comparison: `@` scope written raw becomes `%40`, version and qualifiers are dropped.
pub fn normalize_purl(p: &str) -> String {
    let p = p.trim();
    let p = p.split(['?', '#']).next().unwrap_or(p);
    let Some(rest) = p.strip_prefix("pkg:") else { return p.to_string() };
    let (ty, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.replacen('@', "%40", if path.starts_with('@') { 1 } else { 0 });
    // A version is written `name@version`; after the scope is encoded, any remaining `@` starts it.
    let path = path.split('@').next().unwrap_or(&path).to_string();
    let path = if ty.eq_ignore_ascii_case("npm") { path.to_lowercase() } else { path };
    format!("pkg:{}/{}", ty.to_lowercase(), path)
}

/// The package name in a package URL of an ecosystem the client reads (`pkg:npm/%40a/b` → `@a/b`, `pkg:pypi/x` → `x`).
pub fn purl_name(purl: &str) -> Option<String> {
    let p = normalize_purl(purl);
    p.strip_prefix("pkg:pypi/").map(String::from).or_else(|| npm_name(&p))
}

/// The npm package name in a package URL, if it is one.
pub fn npm_name(purl: &str) -> Option<String> {
    let p = normalize_purl(purl);
    let path = p.strip_prefix("pkg:npm/")?;
    Some(path.replace("%40", "@").replace("%2F", "/").replace("%2f", "/"))
}

/// A type-stubs package: npm `@types/*`, PyPI `types-*` (typeshed) and `*-stubs` (PEP 561). It ships types only, so
/// it has no runtime release notes, and in a technology beside its runtime package it never names the release.
pub fn stub_package(purl: &str) -> bool {
    let p = normalize_purl(purl);
    if let Some(n) = p.strip_prefix("pkg:npm/") {
        return n.starts_with("%40types/");
    }
    p.strip_prefix("pkg:pypi/").is_some_and(|n| n.starts_with("types-") || n.ends_with("-stubs"))
}

/// Write a file atomically: a temporary sibling, then a rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("path has no parent")?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

/// Catalog text as one line of at most `max` characters, for the skill files and the terminal: control characters,
/// line and paragraph separators and bidirectional overrides become spaces, so upstream text cannot forge headings,
/// instructions or terminal sequences around itself.
pub fn one_line(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max * 4));
    for c in s.chars() {
        let blank = c.is_control() || c.is_whitespace() || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}');
        if blank {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
    }
    let out = out.trim_end();
    match out.char_indices().nth(max) {
        None => out.to_string(),
        Some(_) => format!("{}…", out.chars().take(max.saturating_sub(1)).collect::<String>().trim_end()),
    }
}

/// A Markdown code block around upstream text, its fence longer than any backtick run inside so the text cannot close it.
pub fn fenced(value: &str) -> String {
    let longest = value.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(3.max(longest + 1));
    format!("{fence}text\n{value}\n{fence}\n")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(bytes);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Requests sent at once by `concurrent`: enough that a few hundred round trips take seconds, few enough for one host.
pub const REQUESTS_AT_ONCE: usize = 16;

/// `work` over `items` on up to `width` threads. `each` runs on the calling thread as each result arrives, in completion
/// order, so progress can be shown as it happens; returning false sends nothing further (work under way finishes). A
/// worker hands over each result before taking the next item, so none runs ahead of `each`.
pub fn concurrent<T: Sync, R: Send>(items: &[T], width: usize, work: impl Fn(&T) -> R + Sync, mut each: impl FnMut(usize, R) -> bool) {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (next, stop) = (AtomicUsize::new(0), AtomicBool::new(false));
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel(0);
        for _ in 0..width.clamp(1, items.len().max(1)) {
            let (tx, next, stop, work) = (tx.clone(), &next, &stop, &work);
            scope.spawn(move || {
                while !stop.load(Ordering::Acquire) {
                    let i = next.fetch_add(1, Ordering::AcqRel);
                    let Some(item) = items.get(i) else { break };
                    if tx.send((i, work(item))).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);
        for (i, r) in rx {
            if !each(i, r) {
                stop.store(true, Ordering::Release);
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_reports_every_result_and_stops_when_asked() {
        let items: Vec<usize> = (0..100).collect();
        let mut seen = vec![];
        concurrent(&items, 8, |n| n * 2, |i, r| {
            seen.push((i, r));
            true
        });
        seen.sort();
        assert_eq!(seen, items.iter().map(|&n| (n, n * 2)).collect::<Vec<_>>());
        let mut taken = 0;
        concurrent(&items, 4, |n| *n, |_, _| {
            taken += 1;
            taken < 3
        });
        assert_eq!(taken, 3);
        concurrent(&[] as &[u8], 4, |_| (), |_, _| true);
    }

    #[test]
    fn upstream_text_stays_on_one_line_inside_its_fence() {
        assert_eq!(one_line("a\n\n## Instructions\r\nrun\tthis\x1b[2J", 100), "a ## Instructions run this [2J");
        assert_eq!(one_line("x\u{202E}y\u{2028}z", 100), "x y z");
        assert_eq!(one_line("abcdef", 4), "abc…");
        assert_eq!(fenced("a ``` b"), "````text\na ``` b\n````\n");
    }

    #[test]
    fn dates_round_trip() {
        for d in ["1970-01-01", "2000-02-29", "2026-10-15", "2026-12-31"] {
            assert_eq!(format_days(parse_date(d).unwrap()), d);
        }
        assert_eq!(add_days("2026-10-15", 30).unwrap(), "2026-11-14");
        assert_eq!(add_days("2026-12-20", 14).unwrap(), "2027-01-03");
    }

    #[test]
    fn versions_and_floors() {
        assert_eq!(parse_version("v16").unwrap(), Version::new(16, 0, 0));
        assert_eq!(parse_version("16.1").unwrap(), Version::new(16, 1, 0));
        assert_eq!(range_floor("^16.0.3").unwrap(), Version::new(16, 0, 3));
        assert_eq!(range_floor(">=18 <21 || 22").unwrap(), Version::new(18, 0, 0));
        assert_eq!(range_floor("16.x").unwrap(), Version::new(16, 0, 0));
        assert_eq!(range_floor("~5.2.1").unwrap(), Version::new(5, 2, 1));
        assert!(range_floor("*").is_none());
        assert!(range_floor("workspace:*").is_none());
        assert!(range_floor("latest").is_none());
        assert_eq!(parse_version("16.0.0-canary.3").unwrap().pre.as_str(), "canary.3");
    }

    #[test]
    fn npm_satisfies_ranges() {
        let ok = |v: &str, r: &str| npm_satisfies(&parse_version(v).unwrap(), r);
        // A stale lockfile against its manifest (AuditAI ui/: package-lock.json beside pnpm-lock.yaml).
        assert_eq!(ok("15.2.4", "16.3.1"), Some(false));
        assert_eq!(ok("3.8.0", "^4.14.1"), Some(false));
        assert_eq!(ok("4.14.1", "^4.14.1"), Some(true));
        assert_eq!(ok("0.2.9", "^0.2.3"), Some(true));
        assert_eq!(ok("0.3.0", "^0.2.3"), Some(false));
        assert_eq!(ok("0.0.4", "^0.0.3"), Some(false));
        assert_eq!(ok("5.2.9", "~5.2.1"), Some(true));
        assert_eq!(ok("5.3.0", "~5.2.1"), Some(false));
        assert_eq!(ok("16.9.0", "16.x"), Some(true));
        assert_eq!(ok("17.0.0", "16"), Some(false));
        assert_eq!(ok("20.1.0", ">=18 <21 || 22"), Some(true));
        assert_eq!(ok("21.0.0", ">=18 <21 || 22"), Some(false));
        assert_eq!(ok("22.4.0", ">=18 <21 || 22"), Some(true));
        assert_eq!(ok("1.5.0", "1.2.3 - 1.9"), Some(true));
        assert_eq!(ok("1.10.0", "1.2.3 - 1.9"), Some(false));
        assert_eq!(ok("2.0.0", ">= 1.2"), Some(true));
        assert_eq!(ok("1.0.5", "npm:diff-match-patch@^1.0.5"), Some(true));
        assert_eq!(ok("16.0.0-canary.3", "^16.0.0"), Some(true));
        assert_eq!(ok("1.0.0", "*"), Some(true));
        assert_eq!(ok("1.0.0", ""), Some(true));
        for r in ["latest", "workspace:*", "file:../x", "github:a/b", "https://x/y.tgz", "catalog:"] {
            assert_eq!(ok("1.0.0", r), None, "{r}");
        }
    }

    #[test]
    fn purls() {
        assert_eq!(npm_purl("@prisma/client"), "pkg:npm/%40prisma/client");
        assert_eq!(normalize_purl("pkg:npm/@prisma/client"), "pkg:npm/%40prisma/client");
        assert_eq!(normalize_purl("pkg:npm/next@16.0.0"), "pkg:npm/next");
        assert_eq!(npm_name("pkg:npm/%40nestjs/core").unwrap(), "@nestjs/core");
    }
}
