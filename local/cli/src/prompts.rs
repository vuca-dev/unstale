//! Every model-facing text of the pipeline steps (prompts, the structured-output schema, label questions, rubrics,
//! definitions, judge rules) and the classifier thresholds: the data files in `schema/prompts/`, compiled into the
//! binary. Central reads the same files (`central/src/pipeline/prompts.ts`), so both sides build the same requests;
//! the extraction and Jev caches hash these bytes.
//!
//! Format: JSON; each file has an integer `version`, raised whenever its text changes. A text is a string or an array
//! of lines joined with `\n`. `%NAME%` marks a value filled at the call site ([`fill`]). A variant is a list of edits
//! applied in order to a base template ([`apply_edits`]).
//!
//! Nothing in the client calls this yet; the pipeline steps that will are built on it and on [`crate::inference`].
#![allow(dead_code)]

use crate::inference::ChoiceQuestion;
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::sync::OnceLock;

/// The embedded files, by name, as `schema/prompts/` holds them.
pub const FILES: [(&str, &str); 6] = [
    (
        "extract.json",
        include_str!("../../../schema/prompts/extract.json"),
    ),
    (
        "labels.json",
        include_str!("../../../schema/prompts/labels.json"),
    ),
    (
        "judge.json",
        include_str!("../../../schema/prompts/judge.json"),
    ),
    (
        "choice.json",
        include_str!("../../../schema/prompts/choice.json"),
    ),
    (
        "advisory-apis.json",
        include_str!("../../../schema/prompts/advisory-apis.json"),
    ),
    (
        "thresholds.json",
        include_str!("../../../schema/prompts/thresholds.json"),
    ),
];

fn text<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum T {
        One(String),
        Lines(Vec<String>),
    }
    Ok(match T::deserialize(d)? {
        T::One(s) => s,
        T::Lines(l) => l.join("\n"),
    })
}

/// One closed-set member, in the file's order.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Opt {
    pub id: String,
    pub text: String,
}

/// Replace the first occurrence of `find` with `replace`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    #[serde(deserialize_with = "text")]
    pub find: String,
    #[serde(deserialize_with = "text")]
    pub replace: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variants {
    /// One call per chunk: the label fields and rules folded into each record.
    pub one_call: Vec<Edit>,
    /// One call, records then labels, under [`Extract::one_call_schema_response_format`].
    pub one_call_schema: Vec<Edit>,
    /// Evidence named by numbered line instead of quoted.
    pub evidence_ids: Vec<Edit>,
    /// No change_type or surface hints, compact JSON.
    pub diet_full: Vec<Edit>,
    /// Compact JSON only.
    pub diet_compact: Vec<Edit>,
    /// Several chunks in one call (a Codex batch), answered by chunk id: `%CHUNKS%` holds [`Extract::batch_chunk`]s.
    pub batch: Vec<Edit>,
}

/// `extract.json`: the two extraction calls.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Extract {
    pub version: u32,
    /// The extract call: `%TECH%`, `%VERSION%`, `%DATE%`, `%PART%`, `%NOTES%`.
    #[serde(deserialize_with = "text")]
    pub extract: String,
    /// The label call: `%TECH%`, `%VERSION%`, `%RECORDS%`, `%NOTES%`.
    #[serde(deserialize_with = "text")]
    pub label: String,
    /// The `%PART%` value of a note extracted in parts: `%N%` of `%OF%`.
    #[serde(deserialize_with = "text")]
    pub part_line: String,
    /// Appended to `%PART%` for a piece of a chunk whose answer was truncated: `%N%` of `%OF%`.
    #[serde(deserialize_with = "text")]
    pub piece_line: String,
    /// The first line of a rendered documentation change.
    #[serde(deserialize_with = "text")]
    pub docs_preamble: String,
    /// The same, for a change with edited words marked inline.
    #[serde(deserialize_with = "text")]
    pub docs_preamble_marked: String,
    pub variants: Variants,
    /// One chunk of a batch: `%ID%`, `%TECH%`, `%VERSION%`, `%DATE%`, `%NOTES%`.
    #[serde(deserialize_with = "text")]
    pub batch_chunk: String,
    /// A chat-completions `response_format`; its `json_schema.schema` is the schema a [`crate::inference::Prompt`] takes.
    pub one_call_schema_response_format: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sources {
    pub release_notes: String,
    pub upgrade_guide: String,
    pub docs: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LabelQuestionText {
    #[serde(deserialize_with = "text")]
    pub change_type: String,
    #[serde(deserialize_with = "text")]
    pub surface: String,
    /// `%RUBRIC%`.
    #[serde(deserialize_with = "text")]
    pub breaking: String,
    pub breaking_options: Vec<Opt>,
    /// `%BENEFIT%`, `%DEFINITION%`, `%RULE%`.
    #[serde(deserialize_with = "text")]
    pub benefit: String,
    pub benefit_options: Vec<Opt>,
}

/// `labels.json`: the closed sets, their definitions and the label questions.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Labels {
    pub version: u32,
    pub change_types: Vec<Opt>,
    pub surfaces: Vec<Opt>,
    /// Benefit → definition.
    pub benefits: Vec<Opt>,
    #[serde(deserialize_with = "text")]
    pub benefit_rule: String,
    #[serde(deserialize_with = "text")]
    pub breaking_rubric: String,
    /// The record state's `source` value per evidence kind.
    pub sources: Sources,
    pub questions: LabelQuestionText,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JudgeSources {
    pub release_notes: String,
    pub upgrade_guide: String,
    pub docs: String,
    pub changelog: String,
    pub advisory: String,
    pub other: String,
}

/// `judge.json`: same-or-new questions at ingest.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Judge {
    pub version: u32,
    /// The identity rules of the long question.
    #[serde(deserialize_with = "text")]
    pub rules: String,
    /// Appended to `rules` when a source other than release notes takes part.
    #[serde(deserialize_with = "text")]
    pub cross_source_rule: String,
    /// Appended to `rules` when the incoming record is a security advisory.
    #[serde(deserialize_with = "text")]
    pub advisory_rule: String,
    /// `%CANDIDATE%`, `%RULES%`.
    #[serde(deserialize_with = "text")]
    pub question: String,
    /// The shorter rule text, for release notes and upgrade guides: `%CANDIDATE%`.
    #[serde(deserialize_with = "text")]
    pub short_question: String,
    /// Appended to the short question when a source other than release notes takes part.
    #[serde(deserialize_with = "text")]
    pub short_cross_rule: String,
    /// `%CANDIDATE%`.
    pub options: Vec<Opt>,
    /// The state's `source` names per evidence kind.
    pub sources: JudgeSources,
}

/// `choice.json` and `advisory-apis.json`: one prompt each.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptFile {
    pub version: u32,
    #[serde(deserialize_with = "text")]
    pub prompt: String,
}

/// `thresholds.json`: the bars labels and merges are decided at.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Thresholds {
    pub version: u32,
    pub breaking_p: f64,
    pub benefit_p: f64,
    /// A probability in `[low, high)` is borderline: flagged, never dropped.
    pub borderline: [f64; 2],
    pub choice_confidence: f64,
    pub same_p: f64,
    pub cross_same_p: f64,
    pub same_p_short: f64,
    pub cross_same_p_short: f64,
    pub quote_guard_below: f64,
    pub quote_guard_below_short: f64,
    pub quote_similarity: f64,
    pub question_floor: f64,
    pub lineage_same_p: f64,
}

#[derive(Debug, Clone)]
pub struct Prompts {
    pub extract: Extract,
    pub labels: Labels,
    pub judge: Judge,
    /// The choice fallback: `%STATE%`, `%QUESTIONS%`.
    pub choice: PromptFile,
    /// An advisory's affected APIs: `%PACKAGE%`, `%TEXT%`.
    pub advisory_apis: PromptFile,
    pub thresholds: Thresholds,
}

fn parse<T: for<'de> Deserialize<'de>>(name: &str) -> Result<T, String> {
    let (_, raw) = FILES
        .iter()
        .find(|(n, _)| *n == name)
        .ok_or_else(|| format!("schema/prompts/{name}: not embedded"))?;
    serde_json::from_str(raw).map_err(|e| format!("schema/prompts/{name}: {e}"))
}

/// Parses every embedded file.
pub fn load() -> Result<Prompts, String> {
    Ok(Prompts {
        extract: parse("extract.json")?,
        labels: parse("labels.json")?,
        judge: parse("judge.json")?,
        choice: parse("choice.json")?,
        advisory_apis: parse("advisory-apis.json")?,
        thresholds: parse("thresholds.json")?,
    })
}

/// The embedded prompts, parsed once. The files are checked in and a test parses each, so a failure is a build defect.
pub fn prompts() -> &'static Prompts {
    static P: OnceLock<Prompts> = OnceLock::new();
    P.get_or_init(|| load().expect("checked-in schema/prompts files parse"))
}

/// `%NAME%` placeholders (upper-case ASCII letters) filled from `vars`; a name absent from `vars` becomes "". Inserted
/// values are not scanned again. The same rule as central's `fill`.
pub fn fill(tpl: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let name_len = after.bytes().take_while(|b| b.is_ascii_uppercase()).count();
        if name_len > 0 && after.as_bytes().get(name_len) == Some(&b'%') {
            let name = &after[..name_len];
            out.push_str(
                vars.iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| *v)
                    .unwrap_or(""),
            );
            rest = &after[name_len + 1..];
        } else {
            out.push('%');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// A variant of a template: each edit replaces the first occurrence of its `find`, in order; a missing target is an
/// error (the base text changed under the variant).
pub fn apply_edits(template: &str, edits: &[Edit]) -> Result<String, String> {
    let mut out = template.to_string();
    for e in edits {
        let at = out.find(&e.find).ok_or_else(|| {
            format!(
                "edit target not found: {:?}",
                e.find.chars().take(60).collect::<String>()
            )
        })?;
        out.replace_range(at..at + e.find.len(), &e.replace);
    }
    Ok(out)
}

fn options(opts: &[Opt]) -> Vec<(String, String)> {
    opts.iter()
        .map(|o| (o.id.clone(), o.text.clone()))
        .collect()
}

impl Labels {
    /// The eight label questions asked of the classifier for one record, in central's order.
    pub fn questions(&self) -> Vec<(String, ChoiceQuestion)> {
        let q = &self.questions;
        let ask = |id: String, instructions: String, opts: &[Opt]| {
            (
                id,
                ChoiceQuestion {
                    instructions,
                    options: options(opts),
                },
            )
        };
        let mut out = vec![
            ask(
                "change_type".into(),
                q.change_type.clone(),
                &self.change_types,
            ),
            ask("surface".into(), q.surface.clone(), &self.surfaces),
            ask(
                "breaking".into(),
                fill(&q.breaking, &[("RUBRIC", &self.breaking_rubric)]),
                &q.breaking_options,
            ),
        ];
        for b in &self.benefits {
            let vars = [
                ("BENEFIT", b.id.as_str()),
                ("DEFINITION", &b.text),
                ("RULE", &self.benefit_rule),
            ];
            out.push(ask(
                format!("benefit_{}", b.id),
                fill(&q.benefit, &vars),
                &q.benefit_options,
            ));
        }
        out
    }
}

/// Which rule text a same-or-new request uses (central's `matchRequest`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JudgeRules {
    /// Release notes and upgrade guides; `mixed` when a source other than release notes takes part.
    Short { mixed: bool },
    /// Every other request.
    Long { advisory: bool, mixed: bool },
}

impl Judge {
    /// The same-or-new question about candidate `candidate` (`c1`, `c2`, …).
    pub fn question(&self, candidate: &str, rules: JudgeRules) -> ChoiceQuestion {
        let instructions = match rules {
            JudgeRules::Short { mixed } => {
                let q = fill(&self.short_question, &[("CANDIDATE", candidate)]);
                if mixed {
                    format!("{q}\n{}", self.short_cross_rule)
                } else {
                    q
                }
            }
            JudgeRules::Long { advisory, mixed } => {
                let rules = if advisory {
                    format!("{}\n{}", self.rules, self.advisory_rule)
                } else if mixed {
                    format!("{}\n{}", self.rules, self.cross_source_rule)
                } else {
                    self.rules.clone()
                };
                fill(
                    &self.question,
                    &[("CANDIDATE", candidate), ("RULES", &rules)],
                )
            }
        };
        let options = self
            .options
            .iter()
            .map(|o| (o.id.clone(), fill(&o.text, &[("CANDIDATE", candidate)])))
            .collect();
        ChoiceQuestion {
            instructions,
            options,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::jev_request_body;
    use serde_json::Value;
    use serde_json::value::RawValue;
    use std::collections::BTreeMap;

    #[test]
    fn every_file_parses_and_has_a_version() {
        let p = load().expect("parses");
        for (name, raw) in FILES {
            let v: Value = serde_json::from_str(raw).unwrap();
            let version = v.get("version").and_then(Value::as_u64).unwrap_or(0);
            assert!(version >= 1, "{name}: no version");
        }
        assert!(p.extract.version >= 1 && p.labels.version >= 1 && p.judge.version >= 1);
        assert!(p.choice.version >= 1 && p.advisory_apis.version >= 1 && p.thresholds.version >= 1);
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../schema/prompts");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".json"))
            .collect();
        on_disk.sort();
        let mut embedded: Vec<String> = FILES.iter().map(|(n, _)| n.to_string()).collect();
        embedded.sort();
        assert_eq!(
            on_disk, embedded,
            "every file in schema/prompts is embedded"
        );
    }

    /// `schema/prompts-lock.json`: the embedded bytes of each file are its latest locked version, and versions only rise,
    /// so a changed prompt, question or threshold always comes with a raised version (central checks the same lock).
    #[test]
    fn every_file_is_its_latest_locked_version() {
        let lock: Value =
            serde_json::from_str(include_str!("../../../schema/prompts-lock.json")).unwrap();
        let files = lock["files"].as_object().unwrap();
        let mut names: Vec<&str> = files.keys().map(String::as_str).collect();
        names.sort();
        let mut embedded: Vec<&str> = FILES.iter().map(|(n, _)| *n).collect();
        embedded.sort();
        assert_eq!(names, embedded);
        for (name, raw) in FILES {
            let entries = files[name].as_array().unwrap();
            let v = |e: &Value| e["version"].as_u64().unwrap();
            assert!(
                entries.windows(2).all(|w| v(&w[1]) > v(&w[0])),
                "{name}: versions rise"
            );
            let last = entries.last().unwrap();
            assert_eq!(
                crate::util::sha256_hex(raw.as_bytes()),
                last["sha256"].as_str().unwrap(),
                "{name}: content changed without a new version in schema/prompts-lock.json"
            );
            let file: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(
                file["version"].as_u64().unwrap(),
                v(last),
                "{name}: version"
            );
        }
    }

    #[test]
    fn every_variant_applies() {
        let e = &prompts().extract;
        let v = &e.variants;
        for edits in [
            &v.one_call,
            &v.one_call_schema,
            &v.evidence_ids,
            &v.diet_full,
            &v.diet_compact,
            &v.batch,
        ] {
            apply_edits(&e.extract, edits).expect("applies");
        }
        let ids = apply_edits(&e.extract, &v.evidence_ids).unwrap();
        apply_edits(&ids, &v.diet_full).expect("the diet applies to the ids form too");
        assert!(
            apply_edits(
                "abc",
                &[Edit {
                    find: "x".into(),
                    replace: "y".into()
                }]
            )
            .is_err()
        );
        let schema = &e.one_call_schema_response_format["json_schema"]["schema"];
        assert_eq!(schema["additionalProperties"], Value::Bool(false));
    }

    #[test]
    fn fill_matches_central() {
        assert_eq!(
            fill("%A% %B% %c% 100% %%", &[("A", "%B%"), ("B", "x")]),
            "%B% x %c% 100% %%"
        );
        assert_eq!(fill("%MISSING%!", &[]), "!");
    }

    /// Central's request snapshot (`central/test/fixtures/prompt-requests.json`, taken at the HTTP boundary): the
    /// texts built here are the ones central sends.
    fn snapshot() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../central/test/fixtures/prompt-requests.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The bytes central sent for a case's first request: the fixture keeps each body as `JSON.stringify(body, null,
    /// 1)` did, so dropping the whitespace outside strings gives the compact bytes on the wire.
    fn compact(pretty: &str) -> String {
        let (mut out, mut in_str, mut esc) = (String::with_capacity(pretty.len()), false, false);
        for ch in pretty.chars() {
            if in_str {
                out.push(ch);
                match (esc, ch) {
                    (true, _) => esc = false,
                    (false, '\\') => esc = true,
                    (false, '"') => in_str = false,
                    _ => {}
                }
            } else if ch == '"' {
                in_str = true;
                out.push(ch);
            } else if !ch.is_whitespace() {
                out.push(ch);
            }
        }
        out
    }

    /// A case's first Jev request as central sent it, and its state as central wrote it.
    fn sent(case: &str) -> (String, Box<RawValue>) {
        #[derive(Deserialize)]
        struct Captured<'a> {
            #[serde(borrow)]
            body: &'a RawValue,
        }
        #[derive(Deserialize)]
        struct Body<'a> {
            #[serde(borrow)]
            state: &'a RawValue,
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../central/test/fixtures/prompt-requests.json");
        let text = std::fs::read_to_string(path).unwrap();
        let all: BTreeMap<String, Vec<Captured>> = serde_json::from_str(&text).unwrap();
        let body = compact(all[case][0].body.get());
        let state: Body = serde_json::from_str(&body).unwrap();
        let state = RawValue::from_string(state.state.get().to_string()).unwrap();
        (body, state)
    }

    /// The client's Jev request for `questions` about central's state, byte for byte against central's.
    fn same_bytes(case: &str, questions: &[(String, ChoiceQuestion)]) {
        let (want, state) = sent(case);
        let got = jev_request_body("jev-latest", &state, questions);
        assert_eq!(String::from_utf8(got).unwrap(), want, "{case}");
    }

    #[test]
    fn label_requests_match_centrals_bytes() {
        same_bytes("labels.release-notes", &prompts().labels.questions());
    }

    #[test]
    fn judge_requests_match_centrals_bytes() {
        let j = &prompts().judge;
        let one = |rules| vec![("same_c1".to_string(), j.question("c1", rules))];
        same_bytes(
            "judge.release-notes.short-rules-all",
            &one(JudgeRules::Short { mixed: false }),
        );
        same_bytes(
            "judge.guide-vs-release-notes",
            &one(JudgeRules::Short { mixed: true }),
        );
        same_bytes(
            "judge.docs",
            &one(JudgeRules::Long {
                advisory: false,
                mixed: true,
            }),
        );
        same_bytes(
            "judge.advisory",
            &one(JudgeRules::Long {
                advisory: true,
                mixed: false,
            }),
        );
    }

    #[test]
    fn option_order_is_kept() {
        let qs = prompts().labels.questions();
        let ids: Vec<&str> = qs.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids[..3], ["change_type", "surface", "breaking"]);
        let benefit = &qs[3].1.options;
        assert_eq!(
            (benefit[0].0.as_str(), benefit[1].0.as_str()),
            ("yes", "no")
        );
    }

    #[test]
    fn extraction_prompts_match_centrals_requests() {
        let snap = snapshot();
        let e = &prompts().extract;
        let content = |case: &str| -> Vec<String> {
            snap[case]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    c["body"]["messages"][0]["content"]
                        .as_str()
                        .unwrap()
                        .to_string()
                })
                .collect()
        };
        let notes = "## Features\n\n- Adds `after` to run work once a response finishes.\n- `images.minimumCacheTTL` default is now 4 hours.\n\n## Breaking\n\n- Node.js 18 is no longer supported; Node.js 20.9 is required.";
        let vars = [
            ("TECH", "Next.js"),
            ("VERSION", "16.3.2"),
            ("DATE", "2026-08-21"),
            ("PART", ""),
            ("NOTES", notes),
        ];
        assert!(content("extract.two-call.release-notes").contains(&fill(&e.extract, &vars)));
        for (case, edits) in [
            ("extract.one-call", &e.variants.one_call),
            ("extract.one-call-schema", &e.variants.one_call_schema),
            ("extract.diet-full", &e.variants.diet_full),
            ("extract.diet-compact", &e.variants.diet_compact),
        ] {
            assert!(
                content(case).contains(&fill(&apply_edits(&e.extract, edits).unwrap(), &vars)),
                "{case}"
            );
        }
        let schema_case = &snap["extract.one-call-schema"][0]["body"]["response_format"];
        assert_eq!(schema_case, &e.one_call_schema_response_format);
        let part = fill(&e.part_line, &[("N", "1"), ("OF", "2")]);
        assert!(
            content("extract.two-call.multi-part")
                .iter()
                .any(|c| c.contains(&format!("Release: 16.4.0 (2026-08-21){part}\n")))
        );
    }

    #[test]
    fn advisory_prompt_matches_centrals_request() {
        let snap = snapshot();
        let text = "Authorization bypass in Next.js middleware\n\nA request header `x-middleware-subrequest` lets a request skip `middleware`.";
        let want = fill(
            &prompts().advisory_apis.prompt,
            &[("PACKAGE", "next"), ("TEXT", text)],
        );
        assert_eq!(
            snap["advisory-apis"][0]["body"]["messages"][0]["content"]
                .as_str()
                .unwrap(),
            want
        );
    }

    #[test]
    fn thresholds_are_probabilities() {
        let t = prompts().thresholds;
        for p in [
            t.breaking_p,
            t.benefit_p,
            t.choice_confidence,
            t.same_p,
            t.cross_same_p,
            t.same_p_short,
            t.cross_same_p_short,
            t.quote_guard_below,
            t.quote_guard_below_short,
            t.quote_similarity,
            t.lineage_same_p,
        ] {
            assert!((0.0..=1.0).contains(&p));
        }
        assert!(t.borderline[0] < t.borderline[1]);
    }
}
