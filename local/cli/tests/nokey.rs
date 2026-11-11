//! No-key mode end to end: a fixture repository and a fixture catalog with change events, driven through the binary.
//! With the edge-inference switch on and no model provider chosen, the report carries the raw change events of newer
//! releases that have no catalog records; with the switch off, or a provider chosen, it does not. No model is called.

#[path = "../src/testcat.rs"]
mod testcat;

use std::path::Path;
use std::process::Command;
use testcat::{FixtureCatalog, event, rec};

struct Env {
    repo: tempfile::TempDir,
    cache: tempfile::TempDir,
    config: tempfile::TempDir,
}

impl Env {
    fn new() -> Env {
        let repo = tempfile::tempdir().unwrap();
        write(
            repo.path(),
            "package.json",
            r#"{"name":"shop","private":true,"dependencies":{"next":"^16.0.0","react":"^19.0.0"}}"#,
        );
        write(
            repo.path(),
            "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      next:\n        specifier: ^16.0.0\n        version: 16.0.1(react@19.2.0)\n      react:\n        specifier: ^19.0.0\n        version: 19.2.0\n",
        );
        write(
            repo.path(),
            "src/middleware.ts",
            "import { NextResponse } from 'next/server';\nexport function middleware() { return NextResponse.next(); }\n",
        );
        Env {
            repo,
            cache: tempfile::tempdir().unwrap(),
            config: tempfile::tempdir().unwrap(),
        }
    }

    fn init(&self, cat: &FixtureCatalog, switch: bool) -> String {
        let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
        c.args([
            "init",
            "--service",
            cat.loc(),
            "--mode",
            "local",
            "--yes",
            "--wait",
            "0",
            "--no-animation",
        ])
        .current_dir(self.repo.path())
        .env("UNSTALE_CACHE_DIR", self.cache.path())
        .env("UNSTALE_CONFIG_DIR", self.config.path())
        .env("UNSTALE_TODAY", "2026-10-15")
        .env("UNSTALE_NO_REGISTRY", "1")
        .env_remove("UNSTALE_CATALOG")
        .env_remove("UNSTALE_EDGE_INFERENCE")
        .stdin(std::process::Stdio::null());
        if switch {
            c.env("UNSTALE_EDGE_INFERENCE", "1");
        }
        let out = c.output().unwrap();
        assert!(
            out.status.success(),
            "stdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        std::fs::read_to_string(self.repo.path().join(".unstale/onboarding-report.md")).unwrap()
    }

    fn events_file(&self) -> Option<String> {
        std::fs::read_to_string(self.repo.path().join(".unstale/change-events.md")).ok()
    }
}

fn write(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// next 16.0.1 is installed. The catalog has a record for 16.0.3 and change events for 16.0.0, 16.0.3, 16.1.0 and
/// 16.2.0 (the last repeating a passage of 16.1.0); react 19.2.0 is installed and has nothing newer.
fn publish(cat: &FixtureCatalog) {
    cat.tech_events(
        "next",
        0,
        &[("16", vec![rec("next:cache-fix", "pkg:npm/next", "16.0.3")])],
        &[(
            "16",
            vec![
                event("next", "16.0.0", "- released before the installed version"),
                event("next", "16.0.3", "- a release the catalog has records for"),
                event(
                    "next",
                    "16.1.0",
                    "- The middleware file convention is renamed to proxy.",
                ),
                event(
                    "next",
                    "16.2.0",
                    "- The middleware file convention is renamed to proxy.",
                ),
            ],
        )],
    );
    cat.tech_events(
        "react",
        0,
        &[],
        &[(
            "19",
            vec![event("react", "19.2.0", "- the installed release")],
        )],
    );
}

#[test]
fn with_the_switch_on_and_no_provider_the_report_carries_the_raw_change_events_of_newer_releases() {
    let cat = FixtureCatalog::new();
    publish(&cat);
    let env = Env::new();
    let report = env.init(&cat, true);
    assert!(report.contains("## Unparsed release notes"), "{report}");
    assert!(report.contains("No model provider is chosen"), "{report}");
    assert!(report.contains("`.unstale/change-events.md` holds the release-note text of 1 release newer than the installed versions, across 1 dependency"), "{report}");
    assert!(report.contains("1 repeated passage removed"), "{report}");
    assert!(report.contains("next 16.0.1 → 16.1.0: 1 of 1"), "{report}");
    let file = env.events_file().expect("the events file is written");
    assert!(file.starts_with("# Unparsed release notes\n\nRelease-note text of releases newer than the versions this repository installs, as upstream published it. No model read it"), "{file}");
    assert_eq!(
        file.matches("The middleware file convention is renamed to proxy.")
            .count(),
        1,
        "an identical passage is shown once:\n{file}"
    );
    for absent in [
        "released before the installed version",
        "a release the catalog has records for",
        "the installed release",
        "react",
    ] {
        assert!(!file.contains(absent), "{absent}:\n{file}");
    }
    // The deterministic sections and the catalog's own records are still there.
    assert!(report.contains("## Coverage"), "{report}");
    assert!(
        report.contains("next:cache-fix") || report.contains("next 16.0.1 → 16.0.3"),
        "the record's release is reported from the record:\n{report}"
    );
}

#[test]
fn with_the_switch_off_or_a_provider_chosen_nothing_changes() {
    let cat = FixtureCatalog::new();
    publish(&cat);
    // Switch off: no section, no file, no events fetched.
    let off = Env::new();
    let report = off.init(&cat, false);
    assert!(!report.contains("Unparsed release notes"), "{report}");
    assert_eq!(off.events_file(), None);
    assert!(!off.cache.path().join("v1/events").exists());
    // Switch on, a provider chosen in the user's config: the model steps own the events, the report does not show them.
    let chosen = Env::new();
    write(
        chosen.config.path(),
        "config.json",
        r#"{"inference":{"provider":"codex"}}"#,
    );
    let report = chosen.init(&cat, true);
    assert!(!report.contains("Unparsed release notes"), "{report}");
    assert_eq!(chosen.events_file(), None);
    // The same repository once no provider is chosen (`none`), then with one again: the file comes and goes.
    write(
        chosen.config.path(),
        "config.json",
        r#"{"inference":{"provider":"none"}}"#,
    );
    assert!(
        chosen
            .init(&cat, true)
            .contains("## Unparsed release notes")
    );
    assert!(chosen.events_file().is_some());
    write(
        chosen.config.path(),
        "config.json",
        r#"{"inference":{"provider":"codex"}}"#,
    );
    assert!(!chosen.init(&cat, true).contains("Unparsed release notes"));
    assert_eq!(
        chosen.events_file(),
        None,
        "a file from an earlier run is removed"
    );
}
