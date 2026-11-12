//! Labels, matching and the local store: request bytes against central's snapshot with every state built here from a
//! record, the guards and the combine rule, and whole passes against a mock labelling service.

use super::Routes;
use super::extract::Incoming;
use super::labels::{chat_prompt, record_state};
use super::matching;
use super::run::run;
use super::store::{LocalStore, overlay};
use super::tests::{Router, inference, snapshot};
use crate::inference::{Ledger, Limits, ProviderConfig};
use crate::util::sha256_hex;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use unstale_schema::catalog::{
    Benefit, CapabilityRecord, ChangeType, Classification, Classifier, EvidenceKind, Surface,
};

/// Central's test record (`prompt-snapshot.test.ts` `incoming`), with overrides.
fn incoming(over: Value) -> Incoming {
    let mut v = json!({
        "key": "next@16.3.2#0.0", "technology": "next", "version": "16.3.2", "date": "2026-08-21", "line": "16",
        "url": "https://github.com/vercel/next.js/releases/tag/v16.3.2", "snapshot": "sha256:aaa",
        "subject": "images.minimumCacheTTL", "subject_kind": "literal",
        "summary": "The default minimum cache TTL for optimized images is now four hours.", "introduces": [],
        "quote": "minimumCacheTTL default is now 4 hours", "grounded": true, "terms": ["images", "minimumCacheTTL"],
        "replaces": [], "requires": [], "prerequisites": [], "conditions": []
    });
    for (k, x) in over.as_object().unwrap() {
        v[k] = x.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn labels_of() -> super::labels::Labels {
    super::labels::Labels {
        change_type: ChangeType::DefaultChange,
        surface: Surface::Configuration,
        breaking: false,
        benefit: vec![Benefit::None],
        classifier: Classification {
            classifier: Classifier::Jev,
            model: "jev-test".into(),
            change_type: 0.9,
            surface: 0.9,
            breaking: 0.1,
            benefit: vec![],
            borderline: vec![],
        },
    }
}

/// Central's `stored`: a record created from an incoming one (evidence of `kind` when given).
fn stored(over: Value, kind: Option<EvidenceKind>) -> CapabilityRecord {
    let mut r = matching::create(
        &incoming(over),
        &labels_of(),
        &["pkg:npm/next".to_string()],
        &|v| super::js::release_line(v),
        &|_| false,
    );
    if let Some(k) = kind {
        for e in &mut r.evidence {
            e.kind = k;
        }
    }
    r
}

fn jev_bytes(
    state: &serde_json::value::RawValue,
    qs: &[(String, crate::inference::ChoiceQuestion)],
) -> String {
    String::from_utf8(crate::inference::jev_request_body("jev-latest", state, qs)).unwrap()
}

/// The label state, built here from the record, gives central's request bytes.
#[test]
fn label_requests_built_from_a_record_equal_centrals_bytes() {
    let snap = snapshot();
    let p = crate::prompts::prompts();
    let qs = p.labels.questions();
    for (case, inc) in [
        ("labels.release-notes", incoming(json!({}))),
        (
            "labels.facet-section",
            incoming(
                json!({"key": "next@16.3.2#0.1", "subject": "next build", "facet": "--turbopack", "section": "CLI", "introduces": ["--turbopack"], "replaces": ["--turbo"]}),
            ),
        ),
        (
            "labels.upgrade-guide",
            incoming(
                json!({"key": "next@16.0.0+guide.0123abcd#0.0", "kind": "upgrade_guide", "version": "16.0.0", "subject": "middleware.ts", "replaces": ["middleware.ts"], "introduces": ["proxy.ts"], "quote": "Rename middleware.ts to proxy.ts"}),
            ),
        ),
        (
            "labels.docs",
            incoming(json!({"key": "next@16.3.2+docs.0123abcd#0.0", "kind": "docs"})),
        ),
    ] {
        let state = record_state(p, "Next.js", &inc);
        assert_eq!(jev_bytes(&state, &qs), snap[case][0], "{case}");
    }
}

/// The judge's state and questions, built here from records, give central's bytes: one candidate and several, the
/// question floor, cross-source, lineage, docs and advisory forms.
/// A judge case: name, incoming, candidates, retrieval scores, breaking.
type JudgeCase = (
    &'static str,
    Incoming,
    Vec<CapabilityRecord>,
    Option<Vec<f64>>,
    bool,
);

#[test]
fn judge_requests_built_from_records_equal_centrals_bytes() {
    let snap = snapshot();
    let p = crate::prompts::prompts();
    let cases: Vec<JudgeCase> = vec![
        (
            "judge.release-notes.short-rules-floor",
            incoming(json!({})),
            vec![
                stored(
                    json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1"}),
                    None,
                ),
                stored(
                    json!({"key": "next@16.3.1#0.1", "version": "16.3.1", "snapshot": "sha256:b1", "subject": "images.qualities"}),
                    None,
                ),
            ],
            Some(vec![1.9, 0.2]),
            false,
        ),
        (
            "judge.release-notes.short-rules-all",
            incoming(json!({"facet": "minimumCacheTTL", "subject": "images"})),
            vec![stored(
                json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1"}),
                None,
            )],
            None,
            true,
        ),
        (
            "judge.guide-vs-release-notes",
            incoming(
                json!({"key": "next@16.0.0+guide.0123abcd#0.0", "version": "16.0.0", "kind": "upgrade_guide"}),
            ),
            vec![stored(
                json!({"key": "next@16.0.0#0.0", "version": "16.0.0", "snapshot": "sha256:c1"}),
                None,
            )],
            Some(vec![1.5]),
            false,
        ),
        (
            "judge.guide-lineage",
            incoming(
                json!({"key": "next@16.0.0+guide.bbbbbbbb#0.0", "version": "16.0.0", "kind": "upgrade_guide", "snapshot": "sha256:d2"}),
            ),
            vec![stored(
                json!({"key": "next@16.0.0+guide.aaaaaaaa#0.0", "version": "16.0.0", "snapshot": "sha256:d1", "kind": "upgrade_guide"}),
                Some(EvidenceKind::UpgradeGuide),
            )],
            None,
            false,
        ),
        (
            "judge.docs",
            incoming(json!({"key": "next@16.3.2+docs.0123abcd#0.0", "kind": "docs"})),
            vec![stored(
                json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:e1"}),
                None,
            )],
            None,
            false,
        ),
        (
            "judge.advisory",
            incoming(
                json!({"key": "next@16.3.1+advisory.GHSA-f82v-jwr5-mffw#0.0", "subject": "middleware", "quote": "Authorization bypass in Next.js middleware", "kind": "advisory"}),
            ),
            vec![stored(
                json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:f1", "subject": "middleware", "quote": "Fix authorization bypass in middleware (GHSA-f82v-jwr5-mffw)"}),
                None,
            )],
            None,
            false,
        ),
    ];
    for (case, inc, cands, scores, breaking) in cases {
        let refs: Vec<&CapabilityRecord> = cands.iter().collect();
        let (state, qs) =
            matching::match_request(p, "Next.js", &inc, breaking, &refs, scores.as_deref());
        assert!(!qs.is_empty());
        assert_eq!(jev_bytes(&state, &qs), snap[case][0], "{case}");
    }
}

/// Without the labelling service, the chat route's label and judge requests are central's chat-fallback bytes.
#[test]
fn chat_label_and_judge_requests_equal_centrals_bytes() {
    let snap = snapshot();
    let p = crate::prompts::prompts();
    let state = record_state(p, "Next.js", &incoming(json!({})));
    let cand = stored(
        json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1"}),
        None,
    );
    let (jstate, jqs) = matching::match_request(
        p,
        "Next.js",
        &incoming(json!({})),
        false,
        &[&cand],
        Some(&[1.9]),
    );
    let mut cfg = ProviderConfig::vercel();
    cfg.base_url = "http://127.0.0.1:1".into();
    for (case, text) in [
        (
            "choice-fallback.labels",
            chat_prompt(p, &state, &p.labels.questions()),
        ),
        ("choice-fallback.judge", chat_prompt(p, &jstate, &jqs)),
    ] {
        let body = crate::inference::openai_request_body(
            &cfg,
            &crate::inference::Prompt {
                text,
                schema: None,
                max_tokens: 16_000,
                raw: true,
            },
        );
        assert_eq!(body.get(), snap[case][0], "{case}");
    }
}

#[test]
fn guards_block_what_central_blocks_and_the_best_same_wins() {
    let p = crate::prompts::prompts();
    let ans = |ps: &[f64], calibrated: bool| super::labels::Answers {
        classifier: if calibrated {
            "jev".into()
        } else {
            "chat".into()
        },
        model: "m".into(),
        answers: ps
            .iter()
            .enumerate()
            .map(|(i, x)| {
                (
                    format!("same_c{}", i + 1),
                    super::labels::Choice {
                        choice: if *x >= 0.5 { "yes".into() } else { "no".into() },
                        confidence: 1.0,
                        probabilities: [("yes".to_string(), *x), ("no".to_string(), 1.0 - x)]
                            .into(),
                    },
                )
            })
            .collect(),
        calibrated,
    };
    let inc = incoming(json!({}));
    let a = stored(
        json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1"}),
        None,
    );
    let mut b = stored(
        json!({"key": "next@16.3.1#0.1", "version": "16.3.1", "snapshot": "sha256:b2", "quote": "something else entirely"}),
        None,
    );
    b.id = "next:other".into();
    // Short rules: same at 0.82; below the 0.99 quote bar a quote must be near-identical.
    let (m, j) = matching::pick(p, &inc, false, &[&a, &b], &ans(&[0.9, 0.95], true));
    assert_eq!(m.map(|x| x.0).as_deref(), Some(a.id.as_str()));
    assert_eq!(
        (j[0].outcome.as_str(), j[1].outcome.as_str()),
        ("same", "guard:quote")
    );
    // A breaking change never merges into a non-breaking record.
    let (m, j) = matching::pick(p, &inc, true, &[&a], &ans(&[0.99], true));
    assert!(m.is_none() && j[0].outcome == "guard:breaking");
    // Below the bar.
    assert_eq!(
        matching::pick(p, &inc, false, &[&a], &ans(&[0.5], true)).1[0].outcome,
        "below"
    );
    // A text model on its choices: the chat bars (0.82 / 0.97 / 1.01): the quote guard always applies.
    assert_eq!(
        matching::pick(p, &inc, false, &[&b], &ans(&[1.0], false)).1[0].outcome,
        "guard:quote"
    );
    assert_eq!(
        matching::pick(p, &inc, false, &[&a], &ans(&[1.0], false)).1[0].outcome,
        "same"
    );
    assert!(matching::near_identical_quote(p, "Fix `x` (#12)", "fix x"));
    assert!((matching::similarity("abcd", "abce") - 0.75).abs() < 1e-9);
    assert_eq!(
        matching::document_key(
            "https://github.com/o/r/blob/abc/docs/01-app/02-guides/upgrading/version-16.mdx"
        ),
        "upgrading/version-16"
    );
    assert_eq!(
        matching::document_key("https://nextjs.org/docs/app/guides/upgrading/version-16"),
        "upgrading/version-16"
    );
}

#[test]
fn combine_adds_the_release_and_evidence_and_bumps_the_revision_once() {
    let mut r = stored(
        json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1", "line": "16"}),
        None,
    );
    let inc = incoming(
        json!({"key": "next@17.0.0#0.0", "version": "17.0.0", "line": "17", "url": "https://x/17", "quote": "q17", "terms": ["extra"]}),
    );
    matching::combine(
        &mut r,
        &inc,
        &labels_of(),
        &["pkg:npm/next".to_string()],
        &|v| super::js::release_line(v),
    );
    assert_eq!(
        r.releases
            .iter()
            .map(|x| x.version.as_str())
            .collect::<Vec<_>>(),
        ["16.3.1", "17.0.0"]
    );
    assert_eq!(r.evidence.len(), 2);
    assert_eq!((r.revision, r.label_version), (2, 2));
    assert!(r.terms.iter().any(|t| t.0 == "extra"));
}

// ---- Whole passes

/// A labelling-service mock: every choice question answered, `no` where it is an option except a same-or-new question
/// when `same` is set; counts requests.
fn jev_mock(same: f64) -> (String, Arc<Mutex<usize>>) {
    let (url, n, _) = jev_mock_judging(same);
    (url, n)
}

/// [`jev_mock`], also counting the requests that carried a same-or-new question.
fn jev_mock_judging(same: f64) -> (String, Arc<Mutex<usize>>, Arc<Mutex<usize>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let n = Arc::new(Mutex::new(0usize));
    let count = n.clone();
    let judged = Arc::new(Mutex::new(0usize));
    let judge_count = judged.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
            let body = loop {
                let k = s.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..k]);
                let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if k == 0 {
                        break String::new();
                    }
                    continue;
                };
                let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if k == 0 || got.len() >= end + 4 + len {
                    break String::from_utf8_lossy(&got[end + 4..]).to_string();
                }
            };
            *count.lock().unwrap() += 1;
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if body.contains("\"same_c") {
                *judge_count.lock().unwrap() += 1;
            }
            let mut answers = serde_json::Map::new();
            for (id, q) in v["questions"].as_object().into_iter().flatten() {
                let opts: Vec<String> =
                    q["criteria"].as_object().unwrap().keys().cloned().collect();
                let (choice, probs) = if id.starts_with("same_") {
                    (
                        if same >= 0.5 { "yes" } else { "no" }.to_string(),
                        json!({"yes": same, "no": 1.0 - same}),
                    )
                } else if opts.contains(&"no".to_string()) {
                    ("no".into(), json!({"yes": 0.05, "no": 0.95}))
                } else {
                    let p: serde_json::Map<String, Value> = opts
                        .iter()
                        .enumerate()
                        .map(|(i, o)| {
                            (
                                o.clone(),
                                json!(if i == 0 {
                                    0.9
                                } else {
                                    0.1 / (opts.len() - 1) as f64
                                }),
                            )
                        })
                        .collect();
                    (opts[0].clone(), Value::Object(p))
                };
                answers.insert(
                    id.clone(),
                    json!({"choice": choice, "confidence": 0.9, "probabilities": probs}),
                );
            }
            let reply = json!({"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 1}}).to_string();
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (url, n, judged)
}

/// What 2.1.0's notes say of `server.port` in [`fixture`].
const SAME_QUOTE: &str = "server.port default is now 4000";

struct Fixture {
    _cat: crate::testcat::FixtureCatalog,
    cache: tempfile::TempDir,
    answers: super::tests::Answers,
}

/// A synced cache for `example`: a catalog record at 2.0.0 (`example:server.port`), and change events for 2.0.0 (the
/// catalog covers it) and 2.1.0 (it does not); extraction answers for 2.1.0 replayed from central's fixture. The
/// catalog record's quote is worded unlike any of 2.1.0's, so whether a 2.1.0 change is the same is the judge's call.
fn fixture() -> Fixture {
    fixture_quoting("The server now listens on 4000 unless a port is configured")
}

/// [`fixture`], with the catalog record quoting the notes in these words. 2.1.0's notes say
/// [`SAME_QUOTE`] of the same subject.
fn fixture_quoting(old_quote: &str) -> Fixture {
    use crate::testcat::{FixtureCatalog, rec, with};
    let fx: Value = serde_json::from_str(
        &std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/js-port/fixtures.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let case = fx["extractions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "release-notes")
        .unwrap();
    let mut ev = case["event"].clone();
    ev["date"] = json!("2026-10-01");
    let mut covered = ev.clone();
    covered["id"] = json!("example@2.0.0");
    covered["version"] = json!("2.0.0");
    let old = with(
        rec("example:server.port", "pkg:npm/example", "2.0.0"),
        json!({"subject": "server.port", "summary": "The default port is now 4000.", "change_type": "default_change", "breaking": false, "evidence": [{"kind": "release_notes", "url": "https://example.org/2.0.0", "quote": old_quote, "snapshot": "sha256:old"}]}),
    );
    let cat = FixtureCatalog::new();
    cat.tech_events(
        "example",
        0,
        &[("2", vec![old])],
        &[("2", vec![covered, ev])],
    );
    let cache = tempfile::tempdir().unwrap();
    for f in super::tests::walk(cat.dir.path()) {
        let rel = f
            .strip_prefix(cat.dir.path())
            .unwrap()
            .to_string_lossy()
            .to_string();
        let to = cache.path().join(if rel.contains(".events.") {
            rel.replace("v1/shards/", "v1/events/")
        } else {
            rel
        });
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::copy(&f, &to).unwrap();
    }
    let answers = case["exchanges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["prompt_sha256"].as_str().unwrap().to_string(),
                (
                    e["content"].as_str().unwrap().to_string(),
                    e["finish"].as_str().unwrap().to_string(),
                ),
            )
        })
        .collect();
    Fixture {
        _cat: cat,
        cache,
        answers,
    }
}

fn routes(f: &Fixture, main_url: &str, jev_url: Option<&str>) -> Routes {
    let mut main = inference(ProviderConfig::vercel(), main_url, f.cache.path());
    main.ledger = Ledger::new(f.cache.path().join("inference"));
    let labels = jev_url.map(|u| {
        let mut j = inference(ProviderConfig::jev(), u, f.cache.path());
        j.limits = Limits {
            timeout: Duration::from_secs(5),
            retries: 0,
            backoff: Duration::ZERO,
        };
        j
    });
    Routes {
        main,
        labels,
        matching: None,
    }
}

fn set(items: &[&str]) -> std::collections::BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_pass_writes_records_the_report_reads_and_a_second_repo_makes_no_call() {
    let f = fixture();
    let m = Router::new(f.answers.clone(), vec![]);
    let (jev, jn) = jev_mock(0.1);
    let s = run(
        f.cache.path(),
        &routes(&f, &m.url, Some(&jev)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!(s.deferred, None);
    // Only 2.1.0 is extracted: the catalog covers 2.0.0.
    assert_eq!(
        m.count(),
        2,
        "two extraction calls for the one uncovered release"
    );
    assert_eq!((s.created, s.matched), (4, 0));
    assert!(*jn.lock().unwrap() > 0);
    // The report's reader: the catalog's record and the client's, in the same schema, the client's with provenance.
    let mut td = crate::cache::load_catalog_tech(f.cache.path(), "example")
        .unwrap()
        .unwrap();
    let c = super::store::Cover::new(&td, Default::default());
    overlay(&mut td, &LocalStore::load(f.cache.path(), "example"), &c);
    assert_eq!(td.records.len(), 5);
    let made: Vec<&str> = td
        .records
        .iter()
        .filter(|r| td.provenance.contains_key(&r.r.id))
        .map(|r| r.r.id.as_str())
        .collect();
    assert_eq!(made.len(), 4);
    assert!(made.contains(&"example:defineconfig"), "{made:?}");
    let prov = &td.provenance["example:defineconfig"];
    assert_eq!(
        (
            prov.extraction.provider.as_str(),
            prov.labels.provider.as_str(),
            prov.labels.model_version.as_deref()
        ),
        ("vercel", "jev", Some("jev-1.14.0"))
    );
    let r = &td
        .records
        .iter()
        .find(|r| r.r.id == "example:defineconfig")
        .unwrap()
        .r;
    assert_eq!(
        (
            r.releases[0].version.as_str(),
            r.releases[0].component.as_str()
        ),
        ("2.1.0", "pkg:npm/example")
    );
    assert_eq!(r.classifier.as_ref().unwrap().classifier, Classifier::Jev);
    // Another repository with the same technology: nothing new to ask.
    let m2 = Router::new(f.answers.clone(), vec![]);
    let (jev2, jn2) = jev_mock(0.1);
    let s2 = run(
        f.cache.path(),
        &routes(&f, &m2.url, Some(&jev2)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!(
        (m2.count(), *jn2.lock().unwrap(), s2.calls, s2.created),
        (0, 0, 0, 0)
    );
    // Even with the local store gone, the result cache answers every call.
    std::fs::remove_file(super::store::path(f.cache.path(), "example")).unwrap();
    let s3 = run(
        f.cache.path(),
        &routes(&f, &m2.url, Some(&jev2)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!((m2.count(), *jn2.lock().unwrap(), s3.created), (0, 0, 4));
}

#[test]
fn a_change_judged_the_same_extends_the_catalog_record_and_catalog_records_win_later() {
    let f = fixture();
    let m = Router::new(f.answers.clone(), vec![]);
    let (jev, _) = jev_mock(0.99);
    let s = run(
        f.cache.path(),
        &routes(&f, &m.url, Some(&jev)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert!(s.matched >= 1, "{s:?}");
    let mut td = crate::cache::load_catalog_tech(f.cache.path(), "example")
        .unwrap()
        .unwrap();
    let store = LocalStore::load(f.cache.path(), "example");
    assert!(
        store
            .amendments
            .iter()
            .any(|a| a.into == "example:server.port")
    );
    let c = super::store::Cover::new(&td, Default::default());
    overlay(&mut td, &store, &c);
    let port = &td
        .records
        .iter()
        .find(|r| r.r.id == "example:server.port")
        .unwrap()
        .r;
    assert_eq!(
        port.releases
            .iter()
            .map(|x| x.version.as_str())
            .collect::<Vec<_>>(),
        ["2.0.0"],
        "one release per line: the earliest"
    );
    assert_eq!(
        port.evidence.len(),
        2,
        "the new release's evidence joins the record"
    );
    assert!(
        td.provenance.contains_key("example:server.port"),
        "the report can say the client extended it"
    );
    // When the catalog later has records for 2.1.0, the client's contributions for it are left out.
    let mut td = crate::cache::load_catalog_tech(f.cache.path(), "example")
        .unwrap()
        .unwrap();
    td.records[0]
        .r
        .releases
        .push(unstale_schema::catalog::Release {
            component: "pkg:npm/example".into(),
            version: "2.1.0".into(),
            date: "2026-10-01".into(),
            line: "2".into(),
            no_later_than: None,
        });
    let c = super::store::Cover::new(&td, Default::default());
    overlay(&mut td, &store, &c);
    assert_eq!(td.records.len(), 1);
    assert!(td.provenance.is_empty());
}

/// A route read on its choices (here an Anthropic key alone) is never asked same-or-new: a change the catalog's
/// record quotes in the same words is the same by rule, and every other record is new.
#[test]
fn a_route_read_on_its_choices_is_never_asked_same_or_new_and_merges_by_rule() {
    let f = fixture_quoting(SAME_QUOTE);
    // Labels on the same chat route: answered with the first option of every question, read on its choices.
    let qs = crate::prompts::prompts().labels.questions();
    let pick: serde_json::Map<String, Value> = qs
        .iter()
        .map(|(id, q)| (id.clone(), json!(q.options.last().unwrap().0)))
        .collect();
    let reply = serde_json::to_string(&Value::Object(pick)).unwrap();
    // The Anthropic route needs its own mock; a Messages answer per request, recording each prompt.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let prompts = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = prompts.clone();
    let answers = f.answers.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
            let body = loop {
                let k = s.read(&mut buf).unwrap_or(0);
                got.extend_from_slice(&buf[..k]);
                let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if k == 0 {
                        break String::new();
                    }
                    continue;
                };
                let head = String::from_utf8_lossy(&got[..end]).to_ascii_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if k == 0 || got.len() >= end + 4 + len {
                    break String::from_utf8_lossy(&got[end + 4..]).to_string();
                }
            };
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let prompt = v["messages"][0]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            seen.lock().unwrap().push(prompt.clone());
            let text = answers
                .get(&sha256_hex(prompt.as_bytes()))
                .map(|a| a.0.clone())
                .unwrap_or_else(|| reply.clone());
            let out = json!({"model": "claude-haiku-5-5", "stop_reason": "end_turn", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 10, "output_tokens": 2}}).to_string();
            let _ = write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                out.len()
            );
        }
    });
    let main = inference(ProviderConfig::anthropic(), &url, f.cache.path());
    let s = run(
        f.cache.path(),
        &Routes {
            main,
            labels: None,
            matching: None,
        },
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!(
        (s.created, s.matched, s.deferred.clone()),
        (3, 1, None),
        "{s:?}"
    );
    let sent = prompts.lock().unwrap();
    assert!(
        !sent.iter().any(|p| p.contains("same_c1")),
        "no same-or-new question is asked"
    );
    let store = LocalStore::load(f.cache.path(), "example");
    let r = store.records.values().next().unwrap();
    assert_eq!(
        (
            r.provenance.extraction.provider.as_str(),
            r.provenance.judge.is_none()
        ),
        ("anthropic", true)
    );
    let a = &store.amendments[0];
    assert_eq!(
        (
            a.into.as_str(),
            a.p,
            a.provenance.judge.as_ref().map(|j| j.provider.as_str())
        ),
        ("example:server.port", 1.0, Some(matching::RULE_PROVIDER))
    );
    assert_eq!(
        r.record.classifier.as_ref().unwrap().classifier,
        Classifier::Chat
    );
}

#[test]
fn a_provider_problem_defers_with_one_line_and_keeps_completed_work() {
    let f = fixture();
    let m = Router::new(f.answers.clone(), vec![]);
    // The labelling service refuses the key: the extraction answers stay cached, no record is written.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let jev = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut buf = [0u8; 65536];
            let _ = s.read(&mut buf);
            let _ = write!(
                s,
                "HTTP/1.1 401 X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
        }
    });
    let s = run(
        f.cache.path(),
        &routes(&f, &m.url, Some(&jev)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!(s.deferred, Some(crate::inference::Deferred::Auth));
    assert_eq!(
        s.line().unwrap(),
        "warning: the provider rejected the key, so new release notes are not read. Check the key."
    );
    assert_eq!(s.created, 0);
    // The next pass with the service back pays only for labels.
    let (ok, _) = jev_mock(0.1);
    let before = m.count();
    let s = run(
        f.cache.path(),
        &routes(&f, &m.url, Some(&ok)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    assert_eq!((s.created, m.count()), (4, before));
}

/// A text model's "yes" counts as 0 in every probability-gated guard (central's rule): it merges only on a
/// near-identical quote of the same kind, never across kinds or by lineage.
#[test]
fn an_uncalibrated_yes_never_merges_across_kinds_or_by_lineage() {
    let p = crate::prompts::prompts();
    let yes = |calibrated: bool| super::labels::Answers {
        classifier: "chat".into(),
        model: "m".into(),
        answers: [(
            "same_c1".to_string(),
            super::labels::Choice {
                choice: "yes".into(),
                confidence: 1.0,
                probabilities: [("yes".to_string(), 1.0), ("no".to_string(), 0.0)].into(),
            },
        )]
        .into(),
        calibrated,
    };
    // An upgrade-guide item against a release-notes record: a cross-kind pair.
    let inc = incoming(
        json!({"key": "next@16.0.0+guide.0123abcd#0.0", "version": "16.0.0", "kind": "upgrade_guide", "quote": "worded differently in the guide"}),
    );
    let c = stored(
        json!({"key": "next@16.0.0#0.0", "version": "16.0.0", "snapshot": "sha256:c1"}),
        None,
    );
    assert_eq!(
        matching::pick(p, &inc, false, &[&c], &yes(false)).1[0].outcome,
        "guard:cross"
    );
    assert_eq!(
        matching::pick(p, &inc, false, &[&c], &yes(true)).1[0].outcome,
        "same",
        "the labelling service's 1.0 clears the bar"
    );
    // A later version of the same guide: lineage.
    let inc = incoming(
        json!({"key": "next@16.0.0+guide.bbbbbbbb#0.0", "version": "16.0.0", "kind": "upgrade_guide", "snapshot": "sha256:d2", "quote": "another wording"}),
    );
    let c = stored(
        json!({"key": "next@16.0.0+guide.aaaaaaaa#0.0", "version": "16.0.0", "snapshot": "sha256:d1", "kind": "upgrade_guide"}),
        Some(EvidenceKind::UpgradeGuide),
    );
    assert_eq!(
        matching::pick(p, &inc, false, &[&c], &yes(false)).1[0].outcome,
        "guard:lineage"
    );
}

#[test]
fn a_route_can_be_moved_only_to_this_machine() {
    let choice = crate::setup::Choice {
        provider: "openai".into(),
        key_env: Some("OPENAI_API_KEY".into()),
        labels: None,
        matching: None,
    };
    let codex = crate::setup::Choice {
        provider: "codex".into(),
        key_env: None,
        labels: None,
        matching: None,
    };
    let route = |choice: &crate::setup::Choice, url: &str| {
        // SAFETY of the test: the variable is this test's own and read by `routes` in this thread only.
        unsafe { std::env::set_var("UNSTALE_INFERENCE_BASE_URL", url) };
        let r = super::routes_with(choice, None, |_| None)
            .unwrap()
            .main
            .provider
            .base_url;
        unsafe { std::env::remove_var("UNSTALE_INFERENCE_BASE_URL") };
        r
    };
    let base = |url: &str| route(&choice, url);
    assert_eq!(base("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1");
    assert_eq!(base("http://localhost:9"), "http://localhost:9");
    assert_eq!(base("https://evil.example/v1"), "https://api.openai.com/v1");
    assert_eq!(
        base("http://127.0.0.1@evil.example/"),
        "https://api.openai.com/v1"
    );
    // Codex's route has no address: the variable, set for an HTTP route or a local proxy, leaves it running `codex`.
    assert_eq!(route(&codex, "http://127.0.0.1:9/v1"), "codex");
}

/// Labels the service refuses (a 400) fail those records for this pass only: nothing marks them done, and the next pass
/// after the retry date asks again. A route that refuses every request stops the pass after a few in a row, with one
/// line, instead of failing each item alone and silently.
#[test]
fn records_whose_labels_fail_are_not_marked_done_and_a_route_refusing_all_stops_the_pass() {
    let f = fixture();
    let m = Router::new(f.answers.clone(), vec![]);
    // The labelling service answers 400 to every request; the fixture has four records to label.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let jev = format!("http://{}", listener.local_addr().unwrap());
    let asked = Arc::new(Mutex::new(0usize));
    let n = asked.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut buf = [0u8; 65536];
            let _ = s.read(&mut buf);
            *n.lock().unwrap() += 1;
            let _ = write!(
                s,
                "HTTP/1.1 400 X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            );
        }
    });
    let s = run(
        f.cache.path(),
        &routes(&f, &m.url, Some(&jev)),
        &set(&["example"]),
        &set(&["pkg:npm/example"]),
        "2026-11-10",
    );
    let stop = super::REJECTED_IN_A_ROW;
    assert_eq!(
        (s.created, s.unlabelled, s.deferred.clone()),
        (0, stop - 1, Some(crate::inference::Deferred::Rejected)),
        "{s:?}"
    );
    assert_eq!(
        *asked.lock().unwrap(),
        stop,
        "one request per record until the pass stops"
    );
    assert!(s.line().is_some_and(|l| !l.contains('\n')));
    assert!(
        LocalStore::load(f.cache.path(), "example")
            .ingested
            .is_empty()
    );
}

#[test]
fn no_paid_change_leaves_the_report_without_cause() {
    use super::extract::Provenance;
    use super::store::{Amendment, Cover, Folded, Local, RecordProvenance};
    let f = fixture();
    let catalog = || {
        crate::cache::load_catalog_tech(f.cache.path(), "example")
            .unwrap()
            .unwrap()
    };
    let p = Provenance {
        provider: "openai".into(),
        model: "gpt-6-luna".into(),
        model_version: None,
        prompt_version: 1,
    };
    let prov = RecordProvenance {
        extraction: p.clone(),
        labels: p,
        judge: None,
    };
    let comps = ["pkg:npm/example".to_string()];
    let inc = |version: &str, subject: &str| {
        incoming(json!({
            "key": format!("example@{version}#0.0"), "technology": "example", "version": version, "line": "2",
            "url": format!("https://example.org/{version}"), "subject": subject,
            "quote": format!("{subject} in {version}")
        }))
    };
    let mut first = matching::create(
        &inc("2.1.0", "cache.mode"),
        &labels_of(),
        &comps,
        &|v: &str| js_line(v),
        &|_| false,
    );
    let later = inc("2.2.0", "cache.mode");
    matching::combine(&mut first, &later, &labels_of(), &comps, &|v: &str| {
        js_line(v)
    });
    let mut store = LocalStore {
        technology: "example".into(),
        ..Default::default()
    };
    let first_id = first.id.clone();
    store.records.insert(
        first.id.clone(),
        Local {
            record: first.clone(),
            sources: vec!["example@2.1.0#0.0".into(), "example@2.2.0#0.0".into()],
            version: "2.1.0".into(),
            provenance: prov.clone(),
            folded: vec![Folded {
                incoming: later.clone(),
                labels: labels_of(),
                provenance: prov.clone(),
            }],
        },
    );
    // Matched into a catalog record that central has since retracted.
    store.amendments.push(Amendment {
        into: "example:gone".into(),
        incoming: inc("2.2.0", "server.host"),
        labels: labels_of(),
        p: 0.99,
        provenance: prov.clone(),
    });
    let subjects = |td: &crate::cache::TechData| {
        let mut v: Vec<(String, Vec<String>)> = td
            .records
            .iter()
            .map(|r| {
                (
                    r.r.subject.clone(),
                    r.r.releases.iter().map(|x| x.version.clone()).collect(),
                )
            })
            .collect();
        v.sort();
        v
    };
    // Nothing covered: the client's record whole, and the retracted target's change as a record of its own.
    let mut td = catalog();
    td.retracted.push("example:gone".into());
    let c = Cover::new(&td, Default::default());
    overlay(&mut td, &store, &c);
    assert_eq!(
        subjects(&td),
        [
            ("cache.mode".to_string(), vec!["2.1.0".to_string()]),
            ("server.host".into(), vec!["2.2.0".into()]),
            ("server.port".into(), vec!["2.0.0".into()]),
        ]
    );
    assert!(
        td.provenance
            .values()
            .all(|p| p.extraction.provider == "openai")
    );
    // Central processed 2.1.0: the client's record is hidden, and its 2.2.0 change stays as a record of its own.
    let mut td = catalog();
    td.retracted.push("example:gone".into());
    let c = Cover::new(&td, ["example@2.1.0".to_string()].into());
    overlay(&mut td, &store, &c);
    assert_eq!(
        subjects(&td),
        [
            ("cache.mode".to_string(), vec!["2.2.0".to_string()]),
            ("server.host".into(), vec!["2.2.0".into()]),
            ("server.port".into(), vec!["2.0.0".into()]),
        ]
    );
    // The records made on load have the same ids on every load, whatever else the catalog holds.
    let ids = |td: &crate::cache::TechData| -> Vec<String> {
        td.records
            .iter()
            .filter(|r| r.r.id.contains('~'))
            .map(|r| r.r.id.clone())
            .collect()
    };
    let first = ids(&td);
    assert_eq!(first.len(), 2, "{first:?}");
    let mut again = catalog();
    again.retracted.push("example:gone".into());
    again.retracted.push("example:server.host".into());
    again
        .merged
        .insert("example:cache.mode".into(), "example:server.port".into());
    let c2 = Cover::new(&again, ["example@2.1.0".to_string()].into());
    overlay(&mut again, &store, &c2);
    assert_eq!(ids(&again), first);
    // A client record whose id the catalog has since given to another change, its own change not covered: kept.
    let mut td = catalog();
    td.retracted.push("example:gone".into());
    td.retracted.push(first_id.clone());
    let c = Cover::new(&td, Default::default());
    overlay(&mut td, &store, &c);
    assert!(
        td.records
            .iter()
            .any(|r| r.r.subject == "cache.mode"
                && r.r.releases.iter().any(|x| x.version == "2.1.0")),
        "{:?}",
        subjects(&td)
    );
    // And once it processed 2.2.0 as well, the catalog has it all: nothing of the client's is shown.
    let mut td = catalog();
    td.retracted.push("example:gone".into());
    let c = Cover::new(
        &td,
        ["example@2.1.0".to_string(), "example@2.2.0".to_string()].into(),
    );
    overlay(&mut td, &store, &c);
    assert_eq!(
        subjects(&td),
        [("server.port".to_string(), vec!["2.0.0".to_string()])]
    );
    assert!(td.provenance.is_empty());
}

fn js_line(v: &str) -> String {
    super::js::release_line(v)
}

/// `run-step --step match` with no candidate at the question floor prints each candidate as unasked, as central's
/// `pick` does on no answers; an input line that does not parse is skipped, and the rest still run.
#[test]
fn run_step_match_lists_unasked_candidates_and_skips_a_line_that_does_not_parse() {
    let dir = tempfile::tempdir().unwrap();
    let p = crate::prompts::prompts();
    let inc = incoming(json!({}));
    let cand = stored(
        json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1",
               "subject": "router.prefetch", "summary": "Prefetching now waits for the viewport.",
               "terms": ["router", "images"],
               "url": "https://github.com/vercel/next.js/releases/tag/v16.3.1"}),
        None,
    );
    // Retrieved, but below the floor: nothing is asked.
    let found = matching::retrieve(
        &inc,
        &[matching::Cand {
            rec: &cand,
            sources: None,
        }],
    );
    assert_eq!(found.len(), 1);
    assert!(found[0].1 < p.thresholds.question_floor, "{}", found[0].1);
    let item = json!({"name": "Next.js", "incoming": inc, "candidates": [cand]});
    let input = dir.path().join("in.jsonl");
    std::fs::write(&input, format!("not json\n{item}\n")).unwrap();
    // No call can be made: the route points nowhere.
    let inf = super::tests::inference(ProviderConfig::openai(), "http://127.0.0.1:9", dir.path());
    let mut out = vec![];
    super::run_step("match", &input, inf, &mut out).unwrap();
    let lines: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        lines,
        [json!({"key": "next@16.3.2#0.0", "match": null,
                "judged": [{"id": cand.id, "p": 0.0, "outcome": "unasked"}]})]
    );
}

/// SubQ Snap judges in the one form it passed in: the longer rules for every request, the first four candidates, no
/// question floor; and its answers are read at its own bars (`eval/select/slice19/RESULTS.md`).
#[test]
fn snap_asks_four_candidates_with_the_longer_rules_and_reads_its_own_bars() {
    let p = crate::prompts::prompts();
    let inc = incoming(json!({}));
    let cands: Vec<CapabilityRecord> = (0..6)
        .map(|i| {
            let mut c = stored(
                json!({"key": format!("next@16.3.1#0.{i}"), "version": "16.3.1", "snapshot": format!("sha256:s{i}")}),
                None,
            );
            c.id = format!("next:c{i}");
            c
        })
        .collect();
    let refs: Vec<&CapabilityRecord> = cands.iter().collect();
    // Central's form for these: the shorter rules.
    let (_, short) = matching::match_request(p, "Next.js", &inc, false, &refs, None);
    assert_eq!(short.len(), 6);
    assert!(!short[0].1.instructions.contains(&p.judge.rules));
    let (state, qs) = matching::match_request_snap(p, "Next.js", &inc, false, &refs);
    assert_eq!(
        qs.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
        ["same_c1", "same_c2", "same_c3", "same_c4"]
    );
    assert!(
        qs.iter()
            .all(|(_, q)| q.instructions.contains(&p.judge.rules))
    );
    let st: Value = serde_json::from_str(state.get()).unwrap();
    assert_eq!(st["candidates"].as_object().unwrap().len(), 4);

    let ans = |ps: &[f64]| super::labels::Answers {
        classifier: "jev".into(),
        model: "subq-snap-1.2".into(),
        answers: ps
            .iter()
            .enumerate()
            .map(|(i, x)| {
                (
                    format!("same_c{}", i + 1),
                    super::labels::Choice {
                        choice: if *x >= 0.5 { "yes".into() } else { "no".into() },
                        confidence: 1.0,
                        probabilities: [("yes".to_string(), *x), ("no".to_string(), 1.0 - x)]
                            .into(),
                    },
                )
            })
            .collect(),
        calibrated: true,
    };
    let snap = matching::snap_bars(p);
    // 0.65 is a merge at Snap's 0.61 and below central's longer-rules 0.70.
    let (m, _) = matching::pick_at(p, &inc, false, &refs, &ans(&[0.65]), snap);
    assert_eq!(m.map(|x| x.0).as_deref(), Some("next:c0"));
    let lr = matching::bars(p, false);
    assert!(
        matching::pick_at(p, &inc, false, &refs, &ans(&[0.65]), lr)
            .0
            .is_none()
    );
    // A fifth candidate is never asked, so never merged.
    let (m, j) = matching::pick_at(p, &inc, false, &refs, &ans(&[0.1, 0.1, 0.1, 0.1]), snap);
    assert!(m.is_none() && j[4].outcome == "unasked");
}

/// With a calibrated judge, a change the rule decides is not sent to it: the pass with the catalog record quoting the
/// notes in 2.1.0's words makes one same-or-new request fewer than the pass where the judge must be asked, and merges
/// although the judge would have said no.
#[test]
fn the_rule_merges_without_asking_the_judge_and_the_judge_is_asked_only_for_the_rest() {
    let judged = |f: &Fixture| {
        let m = Router::new(f.answers.clone(), vec![]);
        let (jev, _, jn) = jev_mock_judging(0.1);
        let s = run(
            f.cache.path(),
            &routes(f, &m.url, Some(&jev)),
            &set(&["example"]),
            &set(&["pkg:npm/example"]),
            "2026-11-10",
        );
        assert_eq!(s.deferred, None);
        (s.created, s.matched, *jn.lock().unwrap())
    };
    let (created, matched, asked) = judged(&fixture());
    assert_eq!((created, matched), (4, 0));
    assert!(asked >= 1, "the judge is asked about server.port");
    let f = fixture_quoting(SAME_QUOTE);
    assert_eq!(judged(&f), (3, 1, asked - 1));
    let store = LocalStore::load(f.cache.path(), "example");
    let a = &store.amendments[0];
    assert_eq!(a.into, "example:server.port");
    let j = a.provenance.judge.as_ref().unwrap();
    assert_eq!(
        (j.provider.as_str(), j.model.as_str()),
        (matching::RULE_PROVIDER, matching::RULE_MODEL)
    );
}

/// The rule's candidate: the shared quote, from the same kind of source, names both subjects, and no guard blocks.
#[test]
fn the_rule_takes_a_backport_and_nothing_a_guard_blocks() {
    let p = crate::prompts::prompts();
    let inc = incoming(json!({}));
    let same = stored(
        json!({"key": "next@15.5.9#0.0", "version": "15.5.9", "snapshot": "sha256:b1"}),
        None,
    );
    assert_eq!(matching::by_rule(p, &inc, false, &[&same], &[0]), [0]);
    // Markdown, a pull-request number and case do not make a quote another quote.
    let marked = incoming(json!({"quote": "`minimumCacheTTL` default is now 4 hours (#8123)"}));
    assert_eq!(matching::by_rule(p, &marked, false, &[&same], &[0]), [0]);
    // Not among the candidates asked about (below the question floor): not taken.
    assert!(matching::by_rule(p, &inc, false, &[&same], &[]).is_empty());
    // A breaking change never merges into a record that is not.
    assert!(matching::by_rule(p, &inc, true, &[&same], &[0]).is_empty());
    // The same words in another kind of source, or in the same snapshot: the judge's call, not the rule's.
    let guide = stored(
        json!({"key": "next@16.0.0+guide.0123abcd#0.0", "version": "16.0.0", "snapshot": "sha256:g1"}),
        Some(EvidenceKind::UpgradeGuide),
    );
    assert!(matching::by_rule(p, &inc, false, &[&guide], &[0]).is_empty());
    let beside = stored(json!({"key": "next@16.3.2#0.1"}), None);
    assert!(matching::by_rule(p, &inc, false, &[&beside], &[0]).is_empty());
    // Worded differently: not the rule's.
    let other = stored(
        json!({"key": "next@15.5.9#0.0", "version": "15.5.9", "snapshot": "sha256:b1",
               "quote": "Optimized images are now cached for at least four hours"}),
        None,
    );
    assert!(matching::by_rule(p, &inc, false, &[&other], &[0]).is_empty());
    // Several pass: the first in retrieval order is the match, the rest are "not-best", the others unasked.
    let (m, judged) = matching::pick_by_rule(&[&other, &same, &same], &[1, 2]);
    assert_eq!(m, Some((same.id.clone(), 1.0)));
    assert_eq!(
        judged
            .iter()
            .map(|j| j.outcome.as_str())
            .collect::<Vec<_>>(),
        ["unasked", "same", "not-best"]
    );
}

/// Two different changes that share a quote must stay two records. The shared text here is the kind release notes
/// repeat: a heading, a boilerplate line, a version bump, one deprecation sentence used for several APIs.
#[test]
fn the_rule_refuses_two_changes_that_share_a_boilerplate_quote() {
    let p = crate::prompts::prompts();
    let pair = |quote_a: &str,
                subject_a: &str,
                summary_a: &str,
                quote_b: &str,
                subject_b: &str,
                summary_b: &str| {
        let inc = incoming(
            json!({"quote": quote_a, "subject": subject_a, "summary": summary_a, "terms": [subject_a]}),
        );
        // The same changelog page in an earlier release, so retrieval always finds it.
        let c = stored(
            json!({"key": "next@16.3.1#0.0", "version": "16.3.1", "snapshot": "sha256:b1",
                   "quote": quote_b, "subject": subject_b, "summary": summary_b, "terms": [subject_b]}),
            None,
        );
        // Without the subject test the quotes alone would pass every guard: that is what the test adds.
        let quotes_alone =
            matching::guard(p, &inc, false, &c, 0.0, matching::bars(p, true)).is_none();
        (matching::by_rule(p, &inc, false, &[&c], &[0]), quotes_alone)
    };
    for (quote, a, sa, b, sb) in [
        (
            "Bug fixes",
            "useFetch",
            "Aborted requests no longer leave a pending state.",
            "useAsyncData",
            "Cleared data is no longer overwritten by an in-flight request.",
        ),
        (
            "Bug Fixes and improvements.",
            "router.push",
            "Navigation to the same route resolves.",
            "next/image",
            "Images with a zero width no longer throw.",
        ),
        (
            "Updated dependencies",
            "react",
            "React 19.2 is now required.",
            "typescript",
            "TypeScript 5.9 is now supported.",
        ),
        (
            "Updated dependencies [a1b2c3d]",
            "@example/core",
            "Picks up the core fix for config loading.",
            "@example/cli",
            "Picks up the new command.",
        ),
        (
            "Version Packages",
            "create-example",
            "The template uses the app directory.",
            "example.config.ts",
            "The config file may be TypeScript.",
        ),
        (
            "chore: release v4.2.1",
            "nitro",
            "Nitro is updated.",
            "vite",
            "Vite is updated.",
        ),
        (
            "is deprecated and will be removed in the next major version",
            "getServerData",
            "getServerData is deprecated and will be removed in the next major version.",
            "getStaticData",
            "getStaticData is deprecated and will be removed in the next major version.",
        ),
        (
            "This option is now enabled by default.",
            "experimental.typedRoutes",
            "Typed routes are on by default.",
            "experimental.viewTransition",
            "View transitions are on by default.",
        ),
        // The same API, two separate fixes, under a heading that names neither.
        (
            "Bug fixes",
            "useFetch",
            "Aborted requests no longer leave a pending state.",
            "useFetch",
            "Query parameters are encoded once.",
        ),
    ] {
        let (rule, quotes_alone) = pair(quote, a, sa, quote, b, sb);
        assert!(
            quotes_alone,
            "{quote:?}: the case is adversarial only if the quotes pass the guards"
        );
        assert!(rule.is_empty(), "{quote:?} merged {a} into {b}");
    }
    // The same sentence naming each API: the quotes differ by the name, which the quote guard already reads.
    let (rule, quotes_alone) = pair(
        "`getServerData` is deprecated and will be removed in the next major version",
        "getServerData",
        "getServerData is deprecated.",
        "`getStaticData` is deprecated and will be removed in the next major version",
        "getStaticData",
        "getStaticData is deprecated.",
    );
    assert!(!quotes_alone && rule.is_empty());
    // A quote that names only the incoming record's subject is not evidence for the other record's.
    let (rule, _) = pair(
        "Fix useFetch abort handling",
        "useFetch",
        "Aborted requests no longer leave a pending state.",
        "Fix useFetch abort handling",
        "payload extraction",
        "Payloads are extracted for prerendered routes.",
    );
    assert!(rule.is_empty());
    // What the subject test reads as a name.
    assert!(matching::names_subject(
        "as",
        None,
        "Reject top-level `as` prop for islands"
    ));
    assert!(matching::names_subject(
        "addVitePlugin",
        None,
        "async functions when adding build plugins"
    ));
    assert!(matching::names_subject(
        "prerendering",
        None,
        "deadlocks during prerender"
    ));
    assert!(matching::names_subject(
        "build",
        Some("--turbopack"),
        "`--turbopack` is now the default"
    ));
    assert!(!matching::names_subject("useFetch", None, "Bug fixes"));
    assert!(!matching::names_subject(
        "app",
        None,
        "applies to every route"
    ));
}

/// `run-step --step match` on a route read on its choices never calls: the rule's candidate is the match, and a
/// candidate the rule does not take is listed as unasked (the route here points nowhere, so a call would defer).
#[test]
fn run_step_match_decides_by_rule_and_asks_a_choice_route_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let inc = incoming(json!({}));
    let same = stored(
        json!({"key": "next@15.5.9#0.0", "version": "15.5.9", "snapshot": "sha256:b1",
               "url": "https://github.com/vercel/next.js/releases/tag/v15.5.9"}),
        None,
    );
    let reworded = stored(
        json!({"key": "next@15.5.8#0.0", "version": "15.5.8", "snapshot": "sha256:b0",
               "url": "https://github.com/vercel/next.js/releases/tag/v15.5.8",
               "quote": "Optimized images are now cached for at least four hours"}),
        None,
    );
    let input = dir.path().join("in.jsonl");
    std::fs::write(
        &input,
        format!(
            "{}\n{}\n",
            json!({"name": "Next.js", "incoming": inc, "candidates": [same]}),
            json!({"name": "Next.js", "incoming": inc, "candidates": [reworded]})
        ),
    )
    .unwrap();
    let inf = super::tests::inference(ProviderConfig::openai(), "http://127.0.0.1:9", dir.path());
    let mut out = vec![];
    super::run_step("match", &input, inf, &mut out).unwrap();
    let lines: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(
        lines,
        [
            json!({"key": "next@16.3.2#0.0", "match": same.id, "by": "rule",
                   "judged": [{"id": same.id, "p": 1.0, "outcome": "same"}]}),
            json!({"key": "next@16.3.2#0.0", "match": null,
                   "judged": [{"id": reworded.id, "p": 0.0, "outcome": "unasked"}]}),
        ]
    );
}
