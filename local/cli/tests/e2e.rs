//! End to end: a small fixture repository and a fixture catalog in the published format, driven through the
//! binary.

#[path = "../src/testcat.rs"]
mod testcat;

use serde_json::json;
use std::path::Path;
use std::process::Command;
use testcat::{FixtureCatalog, merged, rec, with};

struct Env {
    repo: tempfile::TempDir,
    cache: tempfile::TempDir,
}

impl Env {
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_unstale"))
            .args(args)
            .current_dir(self.repo.path())
            .env("UNSTALE_CACHE_DIR", self.cache.path())
            .env("UNSTALE_TODAY", "2026-10-15")
            // No public registry is read in tests (deprecations.rs); a cached answer is seeded where one is needed.
            .env("UNSTALE_NO_REGISTRY", "1")
            .env_remove("UNSTALE_CATALOG")
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into(), String::from_utf8_lossy(&out.stderr).into())
    }
    fn ok(&self, args: &[&str]) -> String {
        let (code, out, err) = self.run(args);
        assert_eq!(code, 0, "{args:?}\nstdout:\n{out}\nstderr:\n{err}");
        out
    }
    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.repo.path().join(rel)).unwrap()
    }
}

fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn fixture_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    write(
        p,
        "package.json",
        r#"{"name":"shop","private":true,"engines":{"node":">=20.9"},
  "scripts":{"build":"next build","lint":"next lint"},
  "dependencies":{"next":"^16.0.0","@prisma/client":"^6.19.0","react":"^19.0.0"},
  "devDependencies":{"prisma":"^6.19.0"}}"#,
    );
    write(
        p,
        "pnpm-lock.yaml",
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@prisma/client':\n        specifier: ^6.19.0\n        version: 6.19.0(prisma@6.19.0)\n      next:\n        specifier: ^16.0.0\n        version: 16.0.1(react@19.2.0)\n      react:\n        specifier: ^19.0.0\n        version: 19.2.0\n    devDependencies:\n      prisma:\n        specifier: ^6.19.0\n        version: 6.19.0\n",
    );
    write(p, "src/middleware.ts", "import { NextResponse } from 'next/server';\nexport function middleware() { return NextResponse.next(); }\n");
    write(p, "src/db.ts", "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient({ datasourceUrl: process.env.DB });\n");
    write(p, "prisma/schema.prisma", "datasource db {\n  provider = \"postgresql\"\n}\n");
    write(p, "node_modules/next/package.json", r#"{"name":"next","version":"16.0.1","dependencies":{"next":"1"}}"#);
    d
}

fn publish(cat: &FixtureCatalog) {
    let next = vec![
        with(
            rec("next:middleware-to-proxy", "pkg:npm/next", "16.1.0"),
            json!({"change_type":"deprecation","summary":"The middleware file convention is renamed to proxy.","terms":[["middleware.ts",0],["NextResponse",0]],"replaces":["middleware.ts"],"introduces":["proxy.ts"]}),
        ),
        with(rec("next:lint-removed", "pkg:npm/next", "16.1.0"), json!({"change_type":"removal","breaking":true,"terms":[["next lint",0]]})),
        with(rec("next:cache-fix", "pkg:npm/next", "16.0.3"), json!({"change_type":"fix","benefit":["correctness"]})),
        with(rec("next:csrf", "pkg:npm/next", "16.0.3"), json!({"change_type":"security","benefit":["security"],"summary":"Server actions check the Origin header."})),
        with(rec("next:image-ttl", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_option","benefit":["performance"],"terms":[["images.minimumCacheTTL",0]]})),
        with(rec("next:style-only", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","benefit":["none"]})),
    ];
    cat.tech("next", &[("16", next)]);
    cat.tech(
        "prisma",
        &[
            ("6", vec![with(rec("prisma:typed-sql", "pkg:npm/prisma", "6.10.0"), json!({"change_type":"new_api","benefit":["correctness"],"introduces":["typedSql"]}))]),
            (
                "7",
                vec![with(
                    rec("prisma:datasource-url-removed", "pkg:npm/prisma", "7.0.0"),
                    json!({"change_type":"removal","breaking":true,"terms":[["datasourceUrl",0]],"prerequisites":[{"ecosystem":"npm","name":"node","min":"20.9"}]}),
                )],
            ),
        ],
    );
}

#[test]
fn init_sync_digest_review_decide_run() {
    let cat = FixtureCatalog::new();
    publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };

    // Without a catalog location: a clear error.
    let (code, _, err) = env.run(&["init"]);
    assert_eq!(code, 1);
    assert!(err.contains("--catalog"), "{err}");

    let out = env.ok(&["init", "--catalog", cat.loc()]);
    assert!(out.contains("Mode: personal (the default; no setup questions)"), "{out}");
    assert!(out.contains("Switch with `unstale init --mode shared`"), "{out}");
    assert!(out.contains("1 manifests (1 application, 0 library), 4 packages; Node >= 20.9.0"), "{out}");
    assert_eq!(env.read(".unstale/.gitignore"), "*\n");
    assert_eq!(env.read(".unstale/ledger.jsonl"), "{\"schema\":1}\n");
    assert!(!env.repo.path().join(".gitattributes").exists());

    // Collaborative mode marks the ledger merge=union; switching back removes it.
    env.ok(&["init", "--mode", "shared"]);
    env.ok(&["init"]); // An existing sharing choice survives default init.
    assert_eq!(env.read(".gitattributes"), ".unstale/ledger.jsonl merge=union\n");
    assert_eq!(env.read(".unstale/.gitignore"), "state/\n");
    env.ok(&["init", "--mode", "personal"]);
    assert!(!env.repo.path().join(".gitattributes").exists());

    let out = env.ok(&["sync"]);
    assert!(out.contains("synced next: 6 records"), "{out}");
    assert!(out.contains("synced prisma: 2 records"), "{out}");
    assert!(out.contains("Not covered by the catalog: "), "{out}");

    let out = env.ok(&["digest"]);
    assert!(out.contains("bumping next 16.0.1 → 16.1.0 picks up 1 security, 1 fix (`unstale bump next`); 2 obligations in the upgrade review"), "{out}");
    assert!(out.contains("security: Server actions check the Origin header. [next:csrf, 16.0.3]"), "{out}");

    let out = env.ok(&["bump", "next"]);
    assert!(out.starts_with("[next:csrf] next 16.0.3 · security · benefit: security\n"), "{out}");
    // The obligations the digest line counts follow the records the bump picks up.
    assert!(out.contains("\n2 obligations in the upgrade review"), "{out}");

    let out = env.ok(&["review"]);
    assert!(out.contains("upgrade-review: batch 1 with 3 of 3 open records → .unstale/review/upgrades.md (written)"), "{out}");
    assert!(out.contains("improvements-pass: batch 1 with 2 of 2 open records"), "{out}");
    let up = env.read(".unstale/review/upgrades.md");
    // Tier 1 (breaking, removals) before tier 2; inside tier 1, the record matching this repository first.
    let pos = |id: &str| up.find(&format!("### [{id}]")).unwrap_or_else(|| panic!("{id} missing:\n{up}"));
    assert!(pos("next:lint-removed") < pos("prisma:datasource-url-removed"), "rarer match first within tier 1");
    // prisma's removal cites no site here (`datasourceUrl` is in code importing `@prisma/client`, not `prisma`): a
    // record matching nothing comes after those that do, whatever its tier.
    assert!(up[pos("prisma:datasource-url-removed")..].contains("- Matched terms: none"), "{up}");
    assert!(pos("next:middleware-to-proxy") < pos("prisma:datasource-url-removed"), "unmatched last:\n{up}");
    assert!(pos("next:lint-removed") < pos("next:middleware-to-proxy"));
    assert!(up.contains("- Matched terms: `next lint` (package.json)"), "scripts count as usage:\n{up}");
    assert!(up.contains("`middleware.ts` (src/middleware.ts)"), "{up}");
    let imp = env.read(".unstale/review/opportunities.md");
    assert!(imp.contains("### [prisma:typed-sql]") && imp.contains("### [next:image-ttl]"), "{imp}");
    assert!(imp.find("### [prisma:typed-sql]").unwrap() < imp.find("### [next:image-ttl]").unwrap(), "correctness before performance");
    assert!(!imp.contains("next:style-only"), "benefit none is left out");
    // Byte-identical on rerun.
    let out = env.ok(&["review"]);
    assert!(out.contains("(unchanged)"), "{out}");
    assert_eq!(env.read(".unstale/review/upgrades.md"), up);

    // --next refuses while the batch is incomplete.
    let (code, _, err) = env.run(&["review", "--next", "--pass", "upgrade-review"]);
    assert_eq!(code, 3, "{err}");
    assert!(err.contains("3 without a disposition"), "{err}");

    // Dispositions: unknown ids and dispositions are refused.
    assert_eq!(env.run(&["record", "next:nope", "declined"]).0, 1);
    assert_eq!(env.run(&["record", "next:lint-removed", "maybe"]).0, 1);
    env.ok(&["decide", "next:lint-removed", "do-now"]);
    let out = env.ok(&["decide", "next:middleware-to-proxy", "later"]);
    assert!(out.contains("deferred until 2026-11-14 (deferral 1 of 3)"), "{out}");
    let (code, _, err) = env.run(&["review", "--next", "--pass", "upgrade-review"]);
    assert_eq!(code, 3);
    assert!(err.contains("prisma:datasource-url-removed"), "{err}");
    env.ok(&["record", "prisma:datasource-url-removed", "no-site"]);
    let up2 = env.read(".unstale/review/upgrades.md");
    assert!(up2.contains("## Batch 1 is complete"), "regenerated after the ledger changed:\n{up2}");
    assert!(up2.contains("## Marked do now\n\nApply these, then run `unstale record <id> done`"), "{up2}");
    let out = env.ok(&["review", "--next", "--pass", "upgrade-review"]);
    assert!(out.contains("upgrade-review: nothing to review: 2 withheld by the ledger (1 deferred, 1 no site)"), "{out}");

    let ledger = env.read(".unstale/ledger.jsonl");
    assert_eq!(
        ledger,
        "{\"schema\":1}\n{\"status\":\"deferred\",\"id\":\"next:middleware-to-proxy\",\"rev\":1,\"date\":\"2026-10-15\",\"until\":\"2026-11-14\",\"n\":1}\n{\"status\":\"no_site\",\"id\":\"prisma:datasource-url-removed\",\"rev\":1,\"date\":\"2026-10-15\",\"n\":1}\n"
    );
    env.ok(&["decide", "next:image-ttl", "decline"]);
    env.ok(&["ledger", "check"]);

    // A merge stub: next:image-ttl is merged into next:image-ttl-v2; the decline follows it.
    let mut next_lines: Vec<serde_json::Value> = vec![merged("next:image-ttl", "next:image-ttl-v2")];
    next_lines.push(with(rec("next:image-ttl-v2", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_option","benefit":["performance"],"revision":3})));
    next_lines.push(with(rec("next:csrf", "pkg:npm/next", "16.0.3"), json!({"change_type":"security","benefit":["security"]})));
    cat.tech("next", &[("16", next_lines)]);
    let out = env.ok(&["sync"]);
    assert!(out.contains("ledger: next:image-ttl was merged into next:image-ttl-v2; its line now names next:image-ttl-v2"), "{out}");
    let ledger = env.read(".unstale/ledger.jsonl");
    assert!(ledger.contains("{\"status\":\"declined\",\"id\":\"next:image-ttl-v2\",\"rev\":3,\"date\":\"2026-10-15\"}"), "{ledger}");
    assert!(ledger.contains("next:middleware-to-proxy"), "a record missing from the shards keeps its line:\n{ledger}");
    let out = env.ok(&["review", "--pass", "improvements-pass"]);
    assert!(out.contains("improvements-pass: batch 1 with 1 of 1 open records"), "only prisma:typed-sql is left:\n{out}");

    // An invalid ledger line: unreviewed, reported, and `ledger check` fails.
    let mut l = env.read(".unstale/ledger.jsonl");
    l.push_str("{\"id\":\"next:csrf\",\"rev\":1,\"status\":\"deferred\",\"date\":\"2026-10-15\"}\n");
    std::fs::write(env.repo.path().join(".unstale/ledger.jsonl"), &l).unwrap();
    let (code, _, err) = env.run(&["ledger", "check"]);
    assert_eq!(code, 5);
    assert!(err.contains("line 5 is invalid"), "{err}");
    let (code, _, err) = env.run(&["record", "next:csrf", "declined"]);
    assert_eq!(code, 5, "{err}");
    assert_eq!(env.read(".unstale/ledger.jsonl"), l, "an invalid ledger is never rewritten");

    // An incompatible catalog: sync refuses (exit 4), the cached catalog keeps working.
    cat.root(r#"{"schema":1,"min_client":"99.0.0"}"#);
    let (code, _, err) = env.run(&["sync"]);
    assert_eq!(code, 4);
    assert!(err.contains("needs unstale 99.0.0 or newer"), "{err}");
    let out = env.ok(&["digest"]);
    assert!(out.contains("bumping next"), "{out}");
    let (code, out, _) = env.run(&["run"]);
    assert_eq!(code, 4);
    assert!(out.contains("Bump digest"), "{out}");
}

#[test]
fn onboarding_status_reports_features_without_running_an_agent_and_resumes_jobs() {
    use std::net::TcpListener;
    use std::io::{Read, Write};
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    let cat = FixtureCatalog::new();
    publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    // All identities already acknowledged: this resume test needs no public registry/network.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let jobs: Vec<_> = ["next", "react", "prisma", "@prisma/client"].iter().map(|name| {
        let purl = if let Some(rest)=name.strip_prefix('@') { format!("pkg:npm/%40{rest}") } else { format!("pkg:npm/{name}") };
        json!({"purl":purl,"technology":if name.contains("prisma"){"prisma"}else{name},"name":name,"state":if *name == "next" {"queued"} else {"partial"},"stage":"More official history pending","records":6,"updated":"2026-10-15T00:00:00Z"})
    }).collect();
    let responses = jobs.clone();
    let server = std::thread::spawn(move || {
        while !signal.load(Ordering::Relaxed) {
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
                // The whole request, body included, before answering.
                let (mut got, mut buf) = (Vec::new(), [0u8; 8192]);
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0);
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).to_string();
                    let Some(end) = text.find("\r\n\r\n") else { if n == 0 { break } else { continue } };
                    let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if n == 0 || got.len() >= end + 4 + length { break; }
                }
                let request = String::from_utf8_lossy(&got);
                if request.starts_with("GET /health ") {
                    let body=r#"{"service":"unstale-coverage","schema":1}"#;
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                    continue;
                }
                // A service without batch routes (central's own): those are not found, and the client asks a
                // request per package.
                let Some(body) = responses.iter().find(|j| {
                    let encoded: String = j["purl"].as_str().unwrap().bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
                    request.starts_with("GET /coverage?") && request.contains(&encoded)
                }) else {
                    write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                    continue;
                };
                let body = body.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            } else { std::thread::sleep(std::time::Duration::from_millis(5)); }
        }
    });
    let mut config: serde_json::Value = serde_json::from_str(&env.read(".unstale/config.json")).unwrap();
    config["service"] = json!(url);
    write(env.repo.path(), ".unstale/config.json", &config.to_string());
    let map: serde_json::Map<String, serde_json::Value> = jobs.into_iter().map(|j| (j["purl"].as_str().unwrap().to_string(), j)).collect();
    write(env.repo.path(), ".unstale/state/coverage.json", &json!({"jobs":map}).to_string());
    // The registry's deprecation of the installed react, as a refresh would have cached it.
    seed_deprecated(&env, "pkg:npm/react@19.2.0", "This version is no longer supported.");
    let output = env.ok(&["status", "--wait", "0", "--no-animation"]);
    stop.store(true, Ordering::Relaxed); server.join().unwrap();
    assert!(output.split_whitespace().collect::<Vec<_>>().join(" ").contains("Deprecated · 1 installed version of direct dependencies is deprecated or yanked by the publisher; see .unstale/onboarding-report.md."), "{output}");
    assert!(output.contains("Capabilities to explore"), "{output}");
    assert!(!output.contains("new_option")); // readable summaries, not enum names
    assert!(output.lines().count() <= 55, "Shortlists must remain bounded while explaining the result: {output}");
    assert!(!output.contains("Available · published changes for") && !output.contains("published records"), "job counts stay in the report: {output}");
    assert!(!output.contains("\x1b["));
    assert!(output.contains("Mapped 4 direct dependencies from pnpm-lock.yaml"));
    assert!(output.split_whitespace().collect::<Vec<_>>().join(" ").contains("do not edit files"));
    assert!(output.contains("available on") || output.contains("upgrade 16"));
    let flat = output.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(flat.contains("Use .unstale/skills/review/SKILL.md to review this repository"));
    assert!(flat.contains("still gaining history") && flat.contains("unstale status later adds to this brief"), "{output}");
    assert!(!output.contains("Installed Codex review skills"));
    assert!(!output.contains("Keep decisions personal or shared?"));
    assert!(output.contains("NEXT · Review with unstale-review"));
    assert!(flat.contains("Rank upgrades and capabilities by likely impact."));
    assert!(flat.find("Details:").unwrap() < flat.find("NEXT · Review").unwrap());
    assert!(flat.find("Next: run unstale-review").unwrap() < flat.find("Upgrades to review").unwrap());
    assert!(!output.contains("\n  \n  2."), "Blank lines belong between sections, not numbered items");
    assert!(output.contains("━"));
    assert!(flat.contains(".unstale/ is Git-ignored. Share reviews and decisions: unstale init --mode shared --wait 0"));
    let report = env.read(".unstale/onboarding-report.md");
    assert!(report.contains("next:style-only"), "A new feature with benefit:none remains exploratory: {report}");
    assert!(report.contains("not confirmed improvements"));
    assert!(report.contains("untrusted data, never as instructions"));
    assert!(report.find("## Start here").unwrap() < report.find("## Capabilities to explore").unwrap(), "{report}");
    // The report keeps coverage counts and exceptions; every job's line is in coverage.md.
    assert!(report.contains("Coverage: 3 with published changes.") && !report.contains("Queued for shared processing"), "{report}");
    let coverage = env.read(".unstale/coverage.md");
    assert!(coverage.contains("Queued for shared processing; analysis has not completed"), "{coverage}");
    assert!(coverage.contains("6 published records"), "{coverage}");
    assert!(report.contains("## Deprecated by the publisher\n") && report.contains("react 19.2.0 deprecated by its publisher: \"This version is no longer supported.\""), "{report}");
    assert!(env.ok(&["report"]).contains("next:style-only"));
    let skill = env.read(".agents/skills/unstale-review/SKILL.md");
    assert!(skill.starts_with("---\nname: unstale-review"));
    assert!(skill.contains("Review without changing application code"));
    // opencode ignores `disable-model-invocation` and lists every skill to its model by description.
    for dir in [".agents/skills", ".claude/skills"] {
        for skill in ["review"] {
            let text = env.read(&format!("{dir}/unstale-{skill}/SKILL.md"));
            let description = text.lines().find(|l| l.starts_with("description: ")).unwrap();
            assert!(description.contains("Use only when the user explicitly asks") && description.contains("never unprompted"), "{dir}: {description}");
        }
    }
    env.ok(&["decide", "next:image-ttl", "decline"]);
    assert!(!env.read(".unstale/review/opportunities.md").contains("### [next:image-ttl]"));
}

#[test]
fn offline_onboarding_keeps_cached_candidates_and_does_not_wait_per_technology() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo:fixture_repo(),cache:tempfile::tempdir().unwrap() };
    env.ok(&["init","--catalog",cat.loc(),"--mode","local","--yes"]);
    env.ok(&["sync"]);
    let mut config:serde_json::Value=serde_json::from_str(&env.read(".unstale/config.json")).unwrap();
    config["service"]=json!("http://127.0.0.1:9");
    write(env.repo.path(),".unstale/config.json",&config.to_string());
    let start=std::time::Instant::now();
    let out=env.ok(&["status","--wait","0","--no-animation"]);
    assert!(start.elapsed().as_secs()<5,"offline should not timeout once per dependency");
    assert!(out.contains("Coverage service unavailable"));
    assert!(out.contains("Capabilities to explore"));
    assert!(env.read(".unstale/onboarding-report.md").contains("not a fresh coverage check"));
}

#[test]
fn a_catalog_without_a_coverage_service_syncs_and_requests_nothing() {
    // A static host (GitHub Pages) as the service address: no /health, so no coverage requests and no warning.
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    let out = env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    assert!(!out.contains("unavailable") && !out.contains("Action needed"), "{out}");
    assert!(out.contains("Capabilities to explore"), "{out}");
    assert!(env.read(".unstale/onboarding-report.md").contains("This catalog has no coverage service"));
    assert!(env.ok(&["report"]).contains("next:style-only"));
}

#[test]
fn a_version_that_cannot_be_read_is_reported_as_unknown_not_as_0_0_0() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    // A dist-tag with no lockfile entry: nothing says which next is installed.
    std::fs::remove_file(env.repo.path().join("pnpm-lock.yaml")).unwrap();
    write(env.repo.path(), "package.json", r#"{"name":"shop","private":true,"dependencies":{"next":"canary","react":"^19.0.0"}}"#);
    env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    let report = env.read(".unstale/onboarding-report.md");
    let coverage = env.read(".unstale/coverage.md");
    assert!(coverage.contains("next version unknown ·"), "{coverage}");
    // Never a clean-looking "0 upgrade obligations" alone: the report says the version was not read.
    assert!(report.contains("Versions not read, so their records apply to nothing yet: next."), "{report}");
    assert!(!report.contains("0.0.0") && !coverage.contains("0.0.0"), "{report}");
}

#[test]
fn first_install_offline_finishes_with_an_honest_empty_report() {
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    let started = std::time::Instant::now();
    let output = env.ok(&["init", "--service", "http://127.0.0.1:9", "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    assert!(started.elapsed().as_secs() < 5);
    assert!(output.contains("Coverage service unavailable"));
    assert!(env.read(".unstale/state/onboarding-log.txt").contains("Service availability:"));
    assert!(output.contains("No strong capability candidates"));
    assert!(!output.contains("Feature and impact opportunities to explore"));
    let report = env.read(".unstale/onboarding-report.md");
    assert!(report.contains("No acknowledged public coverage jobs"));
    assert!(report.contains("not a fresh coverage check"));
}

#[test]
fn uninstall_backs_up_decisions_and_keeps_unmanaged_agent_files() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "collaborative", "--yes"]);
    write(env.repo.path(), ".gitattributes", "*.png binary\n.unstale/ledger.jsonl merge=union\n");
    write(env.repo.path(), ".unstale/my-notes.md", "keep this too");
    let managed = ".agents/skills/unstale-review";
    write(env.repo.path(), &format!("{managed}/SKILL.md"), "generated\n<!-- Managed by unstale; regenerated from .unstale. -->\n");
    write(env.repo.path(), &format!("{managed}/notes.md"), "user-added context");
    write(env.repo.path(), &format!("{managed}/agents/openai.yaml"), "# Managed by unstale\npolicy:\n  allow_implicit_invocation: false\n");
    write(env.repo.path(), ".claude/skills/unstale-review/SKILL.md", "a user-owned skill");
    let ledger = env.read(".unstale/ledger.jsonl");
    let output = env.ok(&["uninstall"]);
    assert!(!env.repo.path().join(".unstale").exists());
    assert!(!env.repo.path().join(format!("{managed}/SKILL.md")).exists());
    assert_eq!(env.read(&format!("{managed}/notes.md")), "user-added context");
    assert_eq!(env.read(".claude/skills/unstale-review/SKILL.md"), "a user-owned skill");
    assert_eq!(env.read(".gitattributes"), "*.png binary\n");
    let backup = std::path::PathBuf::from(output.lines().find_map(|l| l.strip_prefix("Local backup: ")).unwrap());
    assert_eq!(std::fs::read_to_string(backup.join(".unstale/ledger.jsonl")).unwrap(), ledger);
    assert_eq!(std::fs::read_to_string(backup.join(".unstale/my-notes.md")).unwrap(), "keep this too");
    assert!(env.ok(&["uninstall"]).contains("No unstale repository installation"));
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    assert!(env.repo.path().join(".unstale/config.json").exists());
}

#[cfg(unix)]
#[test]
fn uninstall_preserves_symlinked_agent_directories_and_stops_at_nested_git_roots() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    let external = tempfile::tempdir().unwrap();
    write(external.path(), "skills/unstale-review/SKILL.md", "<!-- Managed by unstale; regenerated from .unstale. -->");
    std::os::unix::fs::symlink(external.path(), env.repo.path().join(".agents")).unwrap();
    std::fs::create_dir_all(env.repo.path().join("nested/.git")).unwrap();
    let out = env.ok(&["-C", env.repo.path().join("nested").to_str().unwrap(), "uninstall"]);
    assert!(out.contains("No unstale repository installation"));
    assert!(env.repo.path().join(".unstale/config.json").exists());
    env.ok(&["uninstall"]);
    assert!(external.path().join("skills/unstale-review/SKILL.md").exists());
    assert!(std::fs::symlink_metadata(env.repo.path().join(".agents")).unwrap().file_type().is_symlink());
}

#[cfg(unix)]
#[test]
fn uninstall_refuses_a_backup_cache_that_links_into_the_installation() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    let link = env.cache.path().join("linked-cache");
    std::os::unix::fs::symlink(env.repo.path().join(".unstale"), &link).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_unstale")).arg("uninstall").env("UNSTALE_NO_REGISTRY", "1")
        .current_dir(env.repo.path()).env("UNSTALE_CACHE_DIR", &link).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("backup directory must be outside"));
    assert!(env.repo.path().join(".unstale/config.json").exists());
}

#[test]
fn onboarding_prefers_new_capabilities_over_generic_security_options_and_old_compatibility() {
    let cat = FixtureCatalog::new();
    cat.tech("next", &[("16", vec![
        with(rec("next:capability", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","benefit":["none"],"summary":"Read structured results without maintaining a custom parser."})),
        with(rec("next:security-option", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_option","benefit":["security"],"summary":"Configure an optional endpoint limit.","terms":[["package.json",0]]})),
        with(rec("next:compat-only", "pkg:npm/next", "16.0.0"), json!({"change_type":"stability_change","benefit":["correctness"],"summary":"Updated companion package compatibility."})),
    ])]);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    env.ok(&["sync"]);
    let mut config: serde_json::Value = serde_json::from_str(&env.read(".unstale/config.json")).unwrap();
    config["service"] = json!("http://127.0.0.1:9");
    write(env.repo.path(), ".unstale/config.json", &config.to_string());
    let output = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(output.split_whitespace().collect::<Vec<_>>().join(" ").contains("Read structured results without maintaining a custom parser."), "{output}");
    assert!(output.find("Read structured results").unwrap() < output.find("Configure an optional endpoint limit.").unwrap(), "Broader shortlists must preserve priority order");
    let report = env.read(".unstale/onboarding-report.md");
    assert!(!report.contains("next:compat-only"));
    assert!(env.read(".unstale/review/opportunities.md").contains("next:compat-only"), "Highlight curation must not truncate the full review queue");
}

fn security_and_breaking_catalog() -> FixtureCatalog {
    let cat = FixtureCatalog::new();
    cat.tech("next", &[("16", vec![
        with(rec("next:csrf", "pkg:npm/next", "16.0.3"), json!({"change_type":"security","benefit":["security"],"summary":"Server actions check the Origin header."})),
        with(rec("next:capability", "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","benefit":["performance"],"summary":"A new capability."})),
    ])]);
    let breaking = |id: &str, term: &str| with(rec(id, "pkg:npm/prisma", "7.0.0"), json!({"change_type":"removal","breaking":true,"terms":[[term,0]]}));
    cat.tech("prisma", &[("7", vec![
        breaking("prisma:a", "datasourceUrl"), breaking("prisma:b", "PrismaClient"), breaking("prisma:c", "postgresql"),
        with(rec("prisma:fix", "pkg:npm/prisma", "7.0.0"), json!({"change_type":"fix","benefit":["correctness"]})),
    ])]);
    cat
}

#[test]
fn upgrades_rank_by_their_most_consequential_named_change() {
    // next's security fix names no API this code uses: an advisory whose affected path was not found, still listed
    // with the upgrades. prisma's obligations match nothing this code does with prisma itself (src/db.ts imports
    // @prisma/client): counts only, in their own section after the named changes. Start here and the upgrades come
    // before capabilities.
    let cat = security_and_breaking_catalog();
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    let output = env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    let flat = output.split_whitespace().collect::<Vec<_>>().join(" ");
    let report = env.read(".unstale/onboarding-report.md");
    assert!(flat.contains("1. next 16.0.1 → 16.0.3 picks up 1 advisory (affected path not found)") && flat.contains("2. prisma"), "{output}");
    let at = |s: &str| report.find(s).unwrap_or_else(|| panic!("{s} missing:\n{report}"));
    assert!(at("## Start here") < at("## Upgrades, by value") && at("## Upgrades, by value") < at("## Other bumps") && at("## Other bumps") < at("## Capabilities to explore"));
    assert!(at("1. next 16.0.1") < at("- prisma 6.19.0 → 7.0.0") && !report.contains("2. prisma"), "{report}");
    assert!(report.contains("; advisory present, affected path not found\n"), "{report}");
    assert!(report.contains("advisory, affected path not found: Server actions check the Origin header. [next:csrf, 16.0.3]"), "{report}");
    assert!(!report.contains("security leads"), "no reachable advisory: nothing leads as security\n{report}");
}

#[test]
fn an_advisory_whose_affected_api_production_code_uses_is_security() {
    // The advisory names `NextResponse`, which src/middleware.ts (application code importing next) calls.
    let cat = FixtureCatalog::new();
    cat.tech("next", &[("16", vec![
        with(rec("next:redirect", "pkg:npm/next", "16.0.3"), json!({"change_type":"security","benefit":["security"],"summary":"`NextResponse` redirects no longer follow protocol-relative URLs."})),
    ])]);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    let report = env.read(".unstale/onboarding-report.md");
    assert!(report.contains("1. next 16.0.1 → 16.0.3 picks up 1 security") && report.contains("; leads with security, affected `NextResponse` used at src/middleware.ts"), "{report}");
    assert!(!report.contains("(affected path not found)") && !report.contains("advisory, affected path not found"), "{report}");
}

#[test]
fn an_upgrade_that_may_retire_a_patched_package_is_named_below_the_risks() {
    // The repository patches prisma: its upgrade names the patch, but a workaround is an improvement, not a located
    // risk, so it follows next's runtime advisory under Lower-urgency upgrades.
    let cat = security_and_breaking_catalog();
    let repo = fixture_repo();
    write(repo.path(), "patches/prisma@6.19.0.patch", "--- a/index.js\n+++ b/index.js\n");
    let env = Env { repo, cache: tempfile::tempdir().unwrap() };
    let output = env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    let flat = output.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(flat.contains("Workarounds · 1 upgrade may let you delete") && flat.contains("may retire your workaround (patches/prisma@6.19.0.patch)"), "{output}");
    let report = env.read(".unstale/onboarding-report.md");
    let lower = report.find("## Lower-urgency upgrades").expect("lower-urgency section");
    assert!(report.find("1. next 16.0.1").unwrap() < lower, "{report}");
    assert!(report[lower..].contains("- prisma 6.19.0") && report[lower..].contains("may retire your workaround (patches/prisma@6.19.0.patch)"), "{report}");
}

#[test]
fn onboarding_shortlist_expands_to_eight_without_truncating_review_context() {
    let cat = FixtureCatalog::new();
    let mut records = vec![];
    for i in 0..10 {
        records.push(with(rec(&format!("next:capability-{i}"), "pkg:npm/next", "16.0.0"), json!({"change_type":"new_api","benefit":["performance"],"summary":format!("New capability {i}.")})));
    }
    cat.tech("next", &[("16", records)]);
    let env = Env { repo:fixture_repo(), cache:tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    env.ok(&["sync"]);
    let mut config:serde_json::Value=serde_json::from_str(&env.read(".unstale/config.json")).unwrap();
    config["service"]=json!("http://127.0.0.1:9");
    write(env.repo.path(), ".unstale/config.json", &config.to_string());
    let output = env.ok(&["status", "--wait", "0", "--no-animation"]);
    assert!(output.contains("Capabilities to explore · 8 shortlisted"), "{output}");
    assert_eq!(output.matches("New capability").count(), 8);
    let full = env.read(".unstale/review/opportunities.md");
    for i in 0..10 { assert!(full.contains(&format!("next:capability-{i}"))); }
}

/// A coverage service that answers every status request with `job` (and the health check), and has no batch routes.
fn coverage_stub(job: serde_json::Value) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = hits.clone();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            // The whole request, body included, before answering.
            let (mut got, mut buf) = (Vec::new(), [0u8; 8192]);
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&got).to_string();
                let Some(end) = text.find("\r\n\r\n") else { if n == 0 { break } else { continue } };
                let length = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                if n == 0 || got.len() >= end + 4 + length { break; }
            }
            let request = String::from_utf8_lossy(&got).to_string();
            // A service without batch routes: the client asks a request per package.
            if !request.starts_with("GET ") {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let body = if request.starts_with("GET /health ") { r#"{"service":"unstale-coverage","schema":1}"#.to_string() } else { job.to_string() };
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        }
    });
    (url, hits)
}

#[test]
fn session_start_notice_pulls_only_when_coverage_is_growing_and_hook_is_merged_and_removed() {
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    Command::new("git").args(["init", "-q"]).current_dir(env.repo.path()).status().unwrap();
    let user = r#"{"permissions":{"allow":["Bash(ls)"]},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#;
    write(env.repo.path(), ".claude/settings.local.json", user);
    let offline = ["init", "--service", "http://127.0.0.1:9", "--mode", "local", "--yes", "--wait", "0", "--no-animation"];
    env.ok(&offline);
    env.ok(&offline);
    let settings: serde_json::Value = serde_json::from_str(&env.read(".claude/settings.local.json")).unwrap();
    assert_eq!(settings["permissions"]["allow"][0], "Bash(ls)", "the user's settings are kept");
    let commands: Vec<&str> = settings["hooks"]["SessionStart"].as_array().unwrap().iter().flat_map(|g| g["hooks"].as_array().unwrap()).map(|h| h["command"].as_str().unwrap()).collect();
    assert_eq!(commands.len(), 2, "the user's hook plus ours, not repeated by a second init: {commands:?}");
    assert!(commands[1].ends_with("-C \"$CLAUDE_PROJECT_DIR\" notify"), "{commands:?}");
    assert!(env.read(".git/info/exclude").lines().any(|l| l == "/.claude/settings.local.json"));

    // Nothing growing: silent, and no request at all.
    let purl = "pkg:npm/next";
    let (url, hits) = coverage_stub(json!({"purl":purl,"technology":"next","name":"next","state":"partial","stage":"","records":9,"updated":""}));
    let mut config: serde_json::Value = serde_json::from_str(&env.read(".unstale/config.json")).unwrap();
    config["service"] = json!(url);
    write(env.repo.path(), ".unstale/config.json", &config.to_string());
    let snapshot = |state: &str| json!({"jobs":{purl:{"purl":purl,"technology":"next","name":"next","state":state,"stage":"","records":3,"updated":""}}}).to_string();
    write(env.repo.path(), ".unstale/state/coverage.json", &snapshot("monitoring"));
    assert_eq!(env.ok(&["notify"]), "");
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    // Growing, with 6 more records published since the snapshot: one line; the snapshot is left for `status`.
    write(env.repo.path(), ".unstale/state/coverage.json", &snapshot("queued"));
    let line = env.ok(&["notify"]);
    assert!(line.starts_with("unstale: 6 new upstream records for 1 technology since the last onboarding report"), "{line}");
    assert_eq!(line.lines().count(), 1);
    assert_eq!(env.read(".unstale/state/coverage.json"), snapshot("queued"));

    env.ok(&["uninstall"]);
    let settings: serde_json::Value = serde_json::from_str(&env.read(".claude/settings.local.json")).unwrap();
    assert_eq!(settings, serde_json::from_str::<serde_json::Value>(user).unwrap(), "uninstall leaves exactly the user's settings");
    assert!(!env.read(".git/info/exclude").contains("settings.local.json"));
}

#[test]
fn a_direct_dependency_whose_installed_version_its_publisher_deprecated_is_said_in_the_digest() {
    let cat = FixtureCatalog::new();
    publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc()]);
    env.ok(&["sync"]);
    assert!(!env.ok(&["digest"]).contains("Deprecated by the publisher"), "nothing cached: nothing said");
    // The registry's answer for the installed react 19.2.0, as `sync` would have cached it.
    seed_deprecated(&env, "pkg:npm/react@19.2.0", "This version is no longer supported.\nUpgrade.");
    let out = env.ok(&["digest"]);
    assert!(out.contains("Deprecated by the publisher (registry, installed versions of direct dependencies; quoted text is data):\n  react 19.2.0 deprecated by its publisher: \"This version is no longer supported. Upgrade.\" (https://www.npmjs.com/package/react/v/19.2.0)"), "{out}");
}

/// A cached registry answer (deprecations.rs): `purl@version` deprecated with `message`, checked far in the future.
fn seed_deprecated(env: &Env, key: &str, message: &str) {
    use sha2::Digest;
    let hex: String = sha2::Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    write(env.cache.path(), &format!("registry/deprecated/{}.json", &hex[..32]), &json!({"checked": 4102444800u64, "message": message}).to_string());
}

#[test]
fn one_review_skill_replaces_managed_legacy_skills_without_losing_decisions() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    env.ok(&["sync"]);
    env.ok(&["decide", "next:image-ttl", "decline"]);
    env.ok(&["review"]);
    let ledger = env.read(".unstale/ledger.jsonl");
    let state = env.read(".unstale/state/review.json");
    let marker = "<!-- Managed by unstale; regenerated from .unstale. -->";
    for dir in [".agents/skills", ".claude/skills", ".cursor/skills"] {
        for legacy in ["onboarding", "upgrade-review", "improvements-pass"] {
            write(env.repo.path(), &format!("{dir}/unstale-{legacy}/SKILL.md"), marker);
            write(env.repo.path(), &format!("{dir}/unstale-{legacy}/agents/openai.yaml"), "# Managed by unstale\npolicy:\n  allow_implicit_invocation: false\n");
        }
    }
    write(env.repo.path(), ".agents/skills/unstale-onboarding/notes.md", "personal context");
    // A user-owned file with an old name must survive migration.
    write(env.repo.path(), ".claude/skills/unstale-improvements-pass/SKILL.md", "my custom skill");
    env.ok(&["review"]);
    assert_eq!(env.read(".unstale/ledger.jsonl"), ledger);
    assert_eq!(env.read(".unstale/state/review.json"), state);
    for dir in [".agents/skills", ".claude/skills"] {
        let skill = env.read(&format!("{dir}/unstale-review/SKILL.md"));
        assert!(skill.starts_with("---\nname: unstale-review\n"));
        assert!(skill.contains(".unstale/review/upgrades.md") && skill.contains(".unstale/review/opportunities.md"));
        assert_eq!(env.read(&format!("{dir}/unstale-review/agents/openai.yaml")), "# Managed by unstale\npolicy:\n  allow_implicit_invocation: false\n");
    }
    for dir in [".agents/skills", ".claude/skills", ".cursor/skills"] {
        for legacy in ["onboarding", "upgrade-review", "improvements-pass"] {
            let path = format!("{dir}/unstale-{legacy}/SKILL.md");
            if path == ".claude/skills/unstale-improvements-pass/SKILL.md" { continue; }
            assert!(!env.repo.path().join(&path).exists(), "obsolete managed entry remains: {path}");
            assert!(env.repo.path().join(format!(".unstale/state/retired-skills/{path}")).exists());
        }
    }
    assert_eq!(env.read(".agents/skills/unstale-onboarding/notes.md"), "personal context");
    assert_eq!(env.read(".claude/skills/unstale-improvements-pass/SKILL.md"), "my custom skill");
    assert!(!env.read(".unstale/review/opportunities.md").contains("### [next:image-ttl]"));
    env.ok(&["review"]); // Migration is idempotent.
    assert_eq!(env.read(".unstale/ledger.jsonl"), ledger);
}

#[test]
fn a_conflicting_review_skill_preserves_the_existing_integration() {
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    write(env.repo.path(), ".agents/skills/unstale-review/SKILL.md", "a user-owned review skill");
    let marker = "<!-- Managed by unstale; regenerated from .unstale. -->";
    write(env.repo.path(), ".agents/skills/unstale-onboarding/SKILL.md", marker);
    env.ok(&["review"]);
    assert_eq!(env.read(".agents/skills/unstale-review/SKILL.md"), "a user-owned review skill");
    assert_eq!(env.read(".agents/skills/unstale-onboarding/SKILL.md"), marker);
    assert!(env.read(".unstale/state/integration-conflicts.json").contains(".agents/skills/unstale-review/SKILL.md"));
    // The direct local entry point is still usable when discovery conflicts.
    assert!(env.repo.path().join(".unstale/skills/review/SKILL.md").is_file());
}

#[test]
#[cfg(unix)]
fn skill_migration_does_not_follow_user_symlinks() {
    use std::os::unix::fs::symlink;
    let cat = FixtureCatalog::new(); publish(&cat);
    let env = Env { repo: fixture_repo(), cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--catalog", cat.loc(), "--mode", "local", "--yes"]);
    env.ok(&["review"]);
    let external = tempfile::tempdir().unwrap();
    let marker = "<!-- Managed by unstale; regenerated from .unstale. -->";
    write(external.path(), "legacy/SKILL.md", marker);
    symlink(external.path().join("legacy"), env.repo.path().join(".agents/skills/unstale-onboarding")).unwrap();
    // The new entrypoint's policy directory can also be user-controlled.
    std::fs::remove_dir_all(env.repo.path().join(".claude/skills/unstale-review/agents")).unwrap();
    write(external.path(), "policy/openai.yaml", "user policy");
    symlink(external.path().join("policy"), env.repo.path().join(".claude/skills/unstale-review/agents")).unwrap();
    env.ok(&["review"]);
    assert_eq!(std::fs::read_to_string(external.path().join("legacy/SKILL.md")).unwrap(), marker);
    assert_eq!(std::fs::read_to_string(external.path().join("policy/openai.yaml")).unwrap(), "user policy");
    assert!(env.read(".unstale/state/integration-conflicts.json").contains(".claude/skills/unstale-review/SKILL.md"));
}

#[test]
fn a_dependency_group_member_application_code_does_not_import_is_dev_only() {
    // fast-agent: zensical (docs) and a group member the application imports share `[dependency-groups] dev`. Both
    // records' terms occur in application code, which names zensical only in a string; only the imported one is runtime code.
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    write(p, "pyproject.toml", "[project]\nname = \"app\"\nversion = \"1.0\"\ndependencies = []\n[dependency-groups]\ndev = [\"zensical==0.0.71\", \"tracer==1.0.0\"]\n");
    write(p, "docs/zensical.toml", "[project]\nsite_name = \"app\"\n");
    write(p, "src/app/main.py", "import tracer\nfrom app.ui import mermaid\n\nDOCS_TOOL = \"zensical\"\n\ndef serve(text):\n    custom_fences = mermaid.render(text, action=\"draw\")\n    rustls_patched = custom_fences\n    tracer.start()\n    return rustls_patched\n");
    let cat = FixtureCatalog::new();
    let security = |id: &str, purl: &str, v: &str, term: &str| with(rec(id, purl, v), json!({"change_type":"security","benefit":["security"],"summary":format!("{term} was patched."),"terms":[[term,0]]}));
    let mermaid = with(rec("zensical:mermaid", "pkg:pypi/zensical", "0.0.72"), json!({"change_type":"behavior_change","benefit":["none"],"terms":[["action=",0]]}));
    cat.tech("zensical", &[("0", vec![security("zensical:rustls", "pkg:pypi/zensical", "0.0.72", "rustls_patched"), mermaid])]);
    cat.tech("tracer", &[("1", vec![security("tracer:start", "pkg:pypi/tracer", "1.0.1", "start")])]);
    let env = Env { repo: d, cache: tempfile::tempdir().unwrap() };
    env.ok(&["init", "--service", cat.loc(), "--mode", "local", "--yes", "--wait", "0", "--no-animation"]);
    let report = env.read(".unstale/onboarding-report.md");
    assert!(report.contains("1. tracer 1.0.0 → 1.0.1") && report.contains("value: security 1 · same major · runtime code"), "{report}");
    assert!(!report.contains(". zensical 0.0.71") && report.contains("- zensical 0.0.71 → 0.0.72"), "a docs tool's advisory is not a ranked runtime upgrade\n{report}");
}
