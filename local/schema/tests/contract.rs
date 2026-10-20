//! The schema seam's contract, Rust side. The TypeScript side is `central/test/schema.test.ts`.
//!
//! - TypeScript → Rust: every line of the shard the TypeScript publisher wrote reads here.
//! - Rust → TypeScript: records serialised here are written to a fixture the Zod must accept.
//! - Forward compatibility: unknown catalog fields and values read; unknown ledger fields do not.
//! - Ledger: tagged statuses, union-merge precedence, write-and-read-back.

use std::{fs, path::PathBuf};

use proptest::prelude::*;
use unstale_schema::catalog::*;
use unstale_schema::ledger::*;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema/fixtures")
}

#[test]
fn reads_every_line_the_typescript_publisher_wrote() {
    let text = fs::read_to_string(fixtures().join("ts-shard.v1.jsonl")).expect("run central/scripts/make-fixtures.ts");
    let (mut active, mut stubs) = (0, 0);
    for (n, line) in text.lines().enumerate() {
        match serde_json::from_str::<ShardLine>(line).unwrap_or_else(|e| panic!("line {}: {e}", n + 1)) {
            ShardLine::Active(r) => {
                assert!(r.id.starts_with(&format!("{}:", r.technology)));
                let raw: serde_json::Value = serde_json::from_str(line).unwrap();
                if raw["change_type"] != "other" {
                    assert_ne!(r.change_type, ChangeType::Other, "a known change type read as Other: {}", r.id);
                }
                active += 1;
            }
            ShardLine::Merged { .. } | ShardLine::Retracted { .. } => stubs += 1,
            ShardLine::Unknown => panic!("line {}: known status read as unknown", n + 1),
        }
    }
    assert!(active >= 60 && stubs == 2, "active {active}, stubs {stubs}");
    let first = serde_json::from_str::<ShardLine>(text.lines().next().unwrap()).unwrap();
    let ShardLine::Active(r) = first else { panic!() };
    let k = r.classifier.expect("the publisher's classifier output reads");
    assert_eq!((k.classifier, k.benefit.len()), (Classifier::Jev, 5));
}

#[test]
fn reads_the_advisories_the_typescript_publisher_wrote() {
    let text = fs::read_to_string(fixtures().join("ts-shard.v1.jsonl")).unwrap();
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(text.lines().nth(1).unwrap()).unwrap() else { panic!() };
    let a = &r.advisories[0];
    assert_eq!((a.id.as_str(), a.aliases.len(), a.affected.len()), ("GHSA-9G9P-9GW9-JX7F", 1, 2));
    assert_eq!(a.affected[1].patched.as_deref(), Some("16.1.5"));
    // Resolved against the release index (15 October 2026): the edge compares version strings.
    assert_eq!(a.affected[1].versions.as_deref(), Some(&["16.1.4".to_string()][..]));
    assert_eq!(a.index.as_ref().map(Vec::len), Some(3));
    assert_eq!(r.evidence.last().unwrap().kind, EvidenceKind::Advisory);
}

#[test]
fn reads_what_the_typescript_publisher_wrote_back_identically() {
    // Rust must not lose anything: parse, serialise, parse again, and compare.
    let text = fs::read_to_string(fixtures().join("ts-shard.v1.jsonl")).unwrap();
    for line in text.lines() {
        let a: ShardLine = serde_json::from_str(line).unwrap();
        let b: ShardLine = serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
        assert_eq!(a, b);
        let (orig, again): (serde_json::Value, serde_json::Value) =
            (serde_json::from_str(line).unwrap(), serde_json::to_value(&a).unwrap());
        assert_eq!(orig, again, "field lost or changed in a Rust round trip");
    }
}

#[test]
fn writes_a_fixture_for_the_typescript_side() {
    let text = fs::read_to_string(fixtures().join("ts-shard.v1.jsonl")).unwrap();
    let mut out = String::new();
    for line in text.lines().take(10) {
        let l: ShardLine = serde_json::from_str(line).unwrap();
        out.push_str(&serde_json::to_string(&l).unwrap());
        out.push('\n');
    }
    // A record with every optional field set, so the Zod sees them all.
    let full = ShardLine::Active(CapabilityRecord {
        id: "node:util.diff".into(),
        technology: "node".into(),
        revision: 2,
        label_version: 5,
        change_type: ChangeType::NewApi,
        breaking: false,
        surface: Surface::RuntimeInternal,
        subject: "util.diff".into(),
        subject_kind: SubjectKind::Literal,
        facet: Some("options".into()),
        summary: "Adds util.diff.".into(),
        benefit: vec![Benefit::Correctness, Benefit::None],
        releases: vec![Release { component: "pkg:generic/node".into(), version: "24.11.0".into(), date: "2025-10-28".into(), no_later_than: None, line: "24".into() }],
        prerequisites: vec![Prerequisite { ecosystem: "npm".into(), name: "node".into(), min: Some("24.11".into()), max: Some("26".into()) }],
        conditions: vec!["PostgreSQL 14 or later".into()],
        requires: vec!["oracledb".into()],
        introduces: vec!["util.diff".into()],
        terms: vec![Term("node:util".into(), 4)],
        replaces: vec!["jsdiff".into()],
        evidence: vec![
            Evidence { kind: EvidenceKind::Docs, url: "https://nodejs.org/api/util.md".into(), section: Some("util.diff(actual, expected)".into()), quote: "Added in: v24.11.0".into(), snapshot: format!("sha256:{}", "cd".repeat(32)) },
            Evidence { kind: EvidenceKind::Advisory, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc".into(), section: None, quote: "GHSA-aaaa-bbbb-cccc (CVE-2026-0001): Denial of service in util.diff".into(), snapshot: format!("sha256:{}", "ef".repeat(32)) },
        ],
        related: vec!["node:util".into()],
        supersedes: Some("node:old-diff".into()),
        classifier: Some(Classification {
            classifier: Classifier::Jev,
            model: "jev-1.13.0".into(),
            change_type: 0.91,
            surface: 0.55,
            breaking: 0.12,
            benefit: vec![BenefitScore { benefit: Benefit::Correctness, p: 0.81 }, BenefitScore { benefit: Benefit::Security, p: 0.4 }],
            borderline: vec!["surface".into(), "benefit:security".into()],
        }),
        advisories: vec![Advisory {
            id: "GHSA-aaaa-bbbb-cccc".into(),
            aliases: vec!["CVE-2026-0001".into()],
            severity: Some("high".into()),
            summary: "Denial of service in util.diff".into(),
            url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc".into(),
            affected: vec![
                AffectedRange { component: "pkg:generic/node".into(), range: ">= 24.0.0, < 24.11.0".into(), patched: Some("24.11.0".into()), versions: Some(vec!["24.10.0".into()]) },
                AffectedRange { component: "pkg:generic/node".into(), range: "< 22.20.0".into(), patched: None, versions: None },
            ],
            index: Some(vec!["24.10.0".into(), "24.11.0".into()]),
        }],
    });
    out.push_str(&serde_json::to_string(&full).unwrap());
    out.push('\n');
    fs::write(fixtures().join("rust-shard.v1.jsonl"), out).unwrap();
}

#[test]
fn tolerates_unknown_catalog_fields_and_values() {
    let line = r#"{"status":"active","id":"next:x","technology":"next","revision":1,"label_version":1,
        "change_type":"quantum_change","breaking":false,"surface":"holographic","subject":"x","subject_kind":"literal",
        "summary":"s","benefit":["joy"],"releases":[],"evidence":[{"kind":"podcast","url":"u","quote":"q","snapshot":"h","new":1}],
        "a_field_from_the_future":{"nested":true}}"#;
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(line).unwrap() else { panic!() };
    assert_eq!(r.change_type, ChangeType::Other);
    assert_eq!(r.surface, Surface::Other);
    assert_eq!(r.benefit, vec![Benefit::Other]);
    assert_eq!(r.evidence[0].kind, EvidenceKind::Other);
    assert!(r.terms.is_empty() && r.requires.is_empty() && r.advisories.is_empty(), "defaulted arrays");
    assert_eq!(serde_json::from_str::<ShardLine>(r#"{"status":"embargoed","id":"x"}"#).unwrap(), ShardLine::Unknown);
}

#[test]
fn reads_the_classifier_field_and_tolerates_its_unknowns() {
    let base = r#""status":"active","id":"next:x","technology":"next","revision":1,"label_version":1,
        "change_type":"fix","breaking":false,"surface":"code_api","subject":"x","subject_kind":"literal",
        "summary":"s","benefit":["none"],"releases":[],"evidence":[]"#;
    // Absent: None, and not written back.
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(&format!("{{{base}}}")).unwrap() else { panic!() };
    assert_eq!(r.classifier, None);
    assert!(!serde_json::to_string(&r).unwrap().contains("classifier"));
    // Known values.
    let c = r#""classifier":{"classifier":"openai-decisions","model":"gpt-6-luna","change_type":0.7,"surface":0.9,
        "breaking":0.6,"benefit":[{"benefit":"performance","p":0.52}],"borderline":["breaking"]}"#;
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(&format!("{{{base},{c}}}")).unwrap() else { panic!() };
    let k = r.classifier.unwrap();
    assert_eq!(k.classifier, Classifier::OpenaiDecisions);
    assert_eq!(k.benefit, vec![BenefitScore { benefit: Benefit::Performance, p: 0.52 }]);
    assert_eq!(k.borderline, vec!["breaking".to_string()]);
    // The Codex fallback (15 October 2026) reads, and is written back as `codex`.
    let c = r#""classifier":{"classifier":"codex","model":"gpt-5.6-luna","change_type":0.7,"surface":0.9,"breaking":0.6,"benefit":[]}"#;
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(&format!("{{{base},{c}}}")).unwrap() else { panic!() };
    assert_eq!(r.classifier.as_ref().unwrap().classifier, Classifier::Codex);
    assert!(serde_json::to_string(&r).unwrap().contains(r#""classifier":"codex""#));
    // The chat fallback (16 October 2026) reads, and is written back as `chat`.
    let c = r#""classifier":{"classifier":"chat","model":"openai/gpt-6-luna","change_type":1,"surface":1,"breaking":0,"benefit":[]}"#;
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(&format!("{{{base},{c}}}")).unwrap() else { panic!() };
    assert_eq!(r.classifier.as_ref().unwrap().classifier, Classifier::Chat);
    assert!(serde_json::to_string(&r).unwrap().contains(r#""classifier":"chat""#));
    // A classifier from the future, an unknown benefit and an unknown field read; borderline defaults to empty.
    let c = r#""classifier":{"classifier":"clef","model":"m","change_type":1,"surface":1,"breaking":0,
        "benefit":[{"benefit":"joy","p":0.9}],"calibration":"v2"}"#;
    let ShardLine::Active(r) = serde_json::from_str::<ShardLine>(&format!("{{{base},{c}}}")).unwrap() else { panic!() };
    let k = r.classifier.unwrap();
    assert_eq!(k.classifier, Classifier::Other);
    assert_eq!(k.benefit[0].benefit, Benefit::Other);
    assert!(k.borderline.is_empty());
}

#[test]
fn reads_index_and_root_with_unknown_fields() {
    let idx = r#"{"schema":1,"technology":"next","sample_n":5,"checked":"2026-10-15T00:00:00Z","shards":[
        {"line":"16","path":"v1/shards/next/16.ab.jsonl.gz","sha256":"ab","bytes":20480,"records":148,"brotli":true}],"cdn":"x"}"#;
    let t: TechIndex = serde_json::from_str(idx).unwrap();
    assert_eq!(t.shards[0].records, 148);
    assert!(t.sample.is_empty(), "an index without a sample reads as an empty list");
    let with = r#"{"schema":1,"technology":"next","sample_n":1,"checked":"x","shards":[],
        "sample":[{"repo":"a/b","commit":"0123456789abcdef0123456789abcdef01234567","stars":3}]}"#;
    let t: TechIndex = serde_json::from_str(with).unwrap();
    assert_eq!(t.sample[0].repo, "a/b");
    assert!(!serde_json::to_string(&TechIndex { sample: vec![], ..t.clone() }).unwrap().contains("sample\""));
    // Rust → TypeScript: an index with a sample, for the Zod to accept.
    let out = TechIndex { sample: vec![SampleRepo { repo: "a/b".into(), commit: "0".repeat(40) }], ..t };
    fs::write(fixtures().join("rust-index.v1.json"), serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
    let root: Root = serde_json::from_str(r#"{"schema":1,"min_client":"0.1.0","notice":"hi"}"#).unwrap();
    assert_eq!(root.schema, 1);
}

// ---- ledger ----

fn parse(text: &str) -> (Ledger, Vec<Invalid>) {
    Ledger::parse(text).unwrap()
}

#[test]
fn ledger_rejects_unknown_fields_and_illegal_shapes() {
    let text = r#"{"schema":1}
{"id":"a","rev":1,"status":"declined","date":"2026-10-15","who":"me"}
{"id":"b","rev":1,"status":"deferred","date":"2026-10-15","n":1}
{"id":"c","rev":1,"status":"declined","date":"2026-10-15","until":"2026-11-15"}
{"id":"d","rev":1,"status":"accepted","date":"2026-10-15"}
not json
{"id":"e","rev":1,"status":"done","date":"2026-10-15"}
"#;
    let (l, bad) = parse(text);
    assert_eq!(bad.iter().map(|i| i.line).collect::<Vec<_>>(), vec![2, 3, 4, 5, 6], "{bad:?}");
    assert_eq!(l.entries.len(), 1);
    assert!(matches!(l.entries[0], Entry::Done { .. }));
}

#[test]
fn ledger_refuses_a_newer_schema() {
    assert!(Ledger::parse("{\"schema\":2}\n").is_err());
    assert!(Ledger::parse("{\"schema\":1,\"x\":1}\n").is_err());
}

#[test]
fn union_merge_resolves_by_precedence() {
    // Both branches' lines survive a merge=union; reading picks one per record.
    let text = r#"{"schema":1}
{"id":"a","rev":1,"status":"no_site","date":"2026-10-20","n":1}
{"id":"a","rev":1,"status":"deferred","date":"2026-10-15","until":"2026-11-15","n":1}
{"id":"b","rev":2,"status":"deferred","date":"2026-10-15","until":"2026-11-15","n":2}
{"id":"b","rev":2,"status":"done","date":"2026-10-10"}
{"id":"c","rev":1,"status":"declined","date":"2026-10-01"}
{"id":"c","rev":2,"status":"declined","date":"2026-10-12"}
"#;
    let (l, bad) = parse(text);
    assert!(bad.is_empty());
    let got: Vec<_> = l.entries.iter().map(|e| serde_json::to_value(e).unwrap()["status"].as_str().unwrap().to_string()).collect();
    assert_eq!(got, vec!["deferred", "done", "declined"]);
    assert!(matches!(&l.entries[2], Entry::Declined { rev: 2, .. }), "same precedence: later date wins");
    // The next write leaves one line per record.
    assert_eq!(l.write_checked().unwrap().lines().count(), 4);
}

fn entry() -> impl Strategy<Value = Entry> {
    let id = "[a-z]{1,8}:[a-z0-9.-]{1,12}";
    let date = "2026-1[0-2]-[0-2][1-9]";
    let note = proptest::option::of("[ -~]{0,20}");
    prop_oneof![
        (id, 0u32..9, date, note.clone()).prop_map(|(id, rev, date, note)| Entry::Declined { id, rev, date, note }),
        (id, 0u32..9, date, note.clone()).prop_map(|(id, rev, date, note)| Entry::Done { id, rev, date, note }),
        (id, 0u32..9, date, date, 1u8..4, note.clone())
            .prop_map(|(id, rev, date, until, n, note)| Entry::Deferred { id, rev, date, until, n, note }),
        (id, 0u32..9, date, 1u8..4, note).prop_map(|(id, rev, date, n, note)| Entry::NoSite { id, rev, date, n, note }),
    ]
}

proptest! {
    #[test]
    fn ledger_write_then_read_is_identity(entries in proptest::collection::vec(entry(), 0..30)) {
        // One entry per id, as the ledger holds after resolution.
        let mut seen = std::collections::BTreeSet::new();
        let entries: Vec<Entry> = entries.into_iter().filter(|e| seen.insert(e.id().to_string())).collect();
        let ledger = Ledger { entries };
        let text = ledger.write_checked().unwrap();
        let (back, bad) = Ledger::parse(&text).unwrap();
        prop_assert!(bad.is_empty());
        prop_assert_eq!(back.write(), text, "deterministic output");
    }
}

#[test]
fn committed_json_schema_is_current() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema");
    for (name, schema) in unstale_schema::schemas() {
        let want = serde_json::to_string_pretty(&schema).unwrap() + "\n";
        assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), want, "{name} drifted: cargo run --bin gen-schema");
    }
}
