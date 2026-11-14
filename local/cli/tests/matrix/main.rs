#![cfg(unix)]
//! The environment matrix: the client run end to end in simulated developer environments, each with its own HOME,
//! PATH, environment and fixture repositories, a mock catalog, a mock model provider and a fake `codex`, all on this
//! machine. Every scenario is checked against the hold-the-line properties (docs/edge-inference/README.md,
//! "Verification posture") and leaves a golden transcript; `MATRIX_GALLERY=1` also writes its recording and a
//! `gallery.html` that plays them back.
//!
//! Scenarios are data: the dimension tables in `dimensions.rs`, expanded to all pairs, plus the critical paths in full. Adding a
//! dimension value or a critical path is one line. `UPDATE_GOLDEN=1 cargo test --test matrix` rewrites the
//! transcripts; see tests/matrix/README.md.

#[path = "../support/mod.rs"]
mod support;
#[path = "../../src/testcat.rs"]
mod testcat;

mod checks;
mod dimensions;
mod model;
mod output;
mod session;
mod world;

use checks::*;
use dimensions::*;
use output::*;
use session::*;
use world::*;

use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use support::{Mock, Request, Response, Sentinel};

// ---------------------------------------------------------------------------------------------------------- tests

/// A scenario's session and what it broke.
type Outcome = (Session, Vec<String>);

/// Runs `list` on a few threads, keeping the order.
fn run_all(list: &[Scenario]) -> Vec<Outcome> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results: std::sync::Mutex<Vec<Option<Outcome>>> =
        std::sync::Mutex::new((0..list.len()).map(|_| None).collect());
    let width = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    // The longest first (the registry slice waits on refused lookups), so they overlap with the rest.
    let mut order: Vec<usize> = (0..list.len()).collect();
    order.sort_by_key(|&i| !list[i].registry);
    std::thread::scope(|sc| {
        for _ in 0..width {
            sc.spawn(|| {
                loop {
                    let n = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let Some(&i) = order.get(n) else { break };
                    let s = &list[i];
                    let se = run_session(s);
                    let v = check(s, &se);
                    results.lock().unwrap()[i] = Some((se, v));
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap()
        .into_iter()
        .map(Option::unwrap)
        .collect()
}

#[test]
fn every_scenario_holds_the_line_and_matches_its_golden_transcript() {
    // `MATRIX_ONLY=<part of a slug>` runs only the scenarios whose slug contains it (no gallery, no orphan check).
    let only = std::env::var("MATRIX_ONLY").ok();
    // `MATRIX_GALLERY=1` writes the recordings and the gallery (not committed, never compared).
    let playback = std::env::var_os("MATRIX_GALLERY").is_some();
    if playback {
        let _ = std::fs::remove_dir_all(golden_dir().join("recordings"));
    }
    let list: Vec<Scenario> = scenarios()
        .into_iter()
        .filter(|s| only.as_ref().is_none_or(|o| s.slug.contains(o.as_str())))
        .collect();
    let results = run_all(&list);
    let mut failures = vec![];
    let mut entries = vec![];
    let mut bugs_seen = BTreeSet::new();
    let mut failing: BTreeSet<String> = BTreeSet::new();
    for (s, (se, v)) in list.iter().zip(&results) {
        let (known, broken): (Vec<String>, Vec<String>) =
            v.iter().cloned().partition(|l| known_bug(s, l).is_some());
        bugs_seen.extend(known.iter().filter_map(|l| known_bug(s, l)));
        if !broken.is_empty() {
            failing.insert(s.slug.clone());
            failures.push(format!(
                "{} ({}):\n  {}",
                s.title,
                s.slug,
                broken.join("\n  ")
            ));
        }
        let text = transcript(s, se, &broken, &known);
        let cast = recording(s, se);
        if let Some(f) = golden(&format!("golden/{}.txt", s.slug), &text) {
            failing.insert(s.slug.clone());
            failures.push(f);
        }
        if playback {
            world::write(
                &golden_dir().join(format!("recordings/{}.cast", s.slug)),
                &cast,
            );
        }
        entries.push((s, text, cast));
    }
    for b in KNOWN_BUGS {
        if only.is_none() && !bugs_seen.contains(b.why) {
            failures.push(format!(
                "the known product bug ({}) no longer shows in any scenario: remove it from KNOWN_BUGS",
                b.why
            ));
        }
    }
    if only.is_some() {
        for (s, (se, _)) in list.iter().zip(&results) {
            for r in &se.ran {
                eprintln!("{}: {} took {:?}", s.slug, r.shown, r.took);
            }
            for r in se.world.trap.requests() {
                eprintln!("{}: through the proxy: {} {}", s.slug, r.method, r.path);
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n\n"));
        return;
    }
    if playback {
        world::write(&golden_dir().join("gallery.html"), &gallery(&entries));
    }
    // A transcript left behind by a scenario that no longer exists: deleted on update, a failure otherwise.
    let slugs: BTreeSet<String> = list.iter().map(|s| s.slug.clone()).collect();
    for e in std::fs::read_dir(golden_dir().join("golden"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let stem = e.path().file_stem().unwrap().to_string_lossy().to_string();
        if slugs.contains(&stem) {
            continue;
        }
        if std::env::var_os("UPDATE_GOLDEN").is_some() {
            std::fs::remove_file(e.path()).unwrap();
        } else {
            failures.push(format!(
                "golden/{} belongs to no scenario; `UPDATE_GOLDEN=1 cargo test --test matrix` deletes it",
                e.file_name().to_string_lossy()
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} scenarios fail, {} problems in all:\n\n{}",
        failing.len(),
        list.len(),
        failures.len(),
        failures.join("\n\n")
    );
}
