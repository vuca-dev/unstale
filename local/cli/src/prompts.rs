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
use std::collections::BTreeMap;
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

fn options(opts: &[Opt]) -> BTreeMap<String, String> {
    opts.iter()
        .map(|o| (o.id.clone(), o.text.clone()))
        .collect()
}

impl Labels {
    /// The eight label questions asked of the classifier for one record, by question id.
    pub fn questions(&self) -> BTreeMap<String, ChoiceQuestion> {
        let q = &self.questions;
        let mut out = BTreeMap::new();
        out.insert(
            "change_type".to_string(),
            ChoiceQuestion {
                instructions: q.change_type.clone(),
                options: options(&self.change_types),
            },
        );
        out.insert(
            "surface".to_string(),
            ChoiceQuestion {
                instructions: q.surface.clone(),
                options: options(&self.surfaces),
            },
        );
        out.insert(
            "breaking".to_string(),
            ChoiceQuestion {
                instructions: fill(&q.breaking, &[("RUBRIC", &self.breaking_rubric)]),
                options: options(&q.breaking_options),
            },
        );
        for b in &self.benefits {
            out.insert(
                format!("benefit_{}", b.id),
                ChoiceQuestion {
                    instructions: fill(
                        &q.benefit,
                        &[
                            ("BENEFIT", &b.id),
                            ("DEFINITION", &b.text),
                            ("RULE", &self.benefit_rule),
                        ],
                    ),
                    options: options(&q.benefit_options),
                },
            );
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
    use serde_json::Value;

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

    fn jev_questions(snap: &Value, case: &str) -> BTreeMap<String, ChoiceQuestion> {
        let qs = snap[case][0]["body"]["questions"].as_object().unwrap();
        qs.iter()
            .map(|(id, q)| {
                let options = q["criteria"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                    .collect();
                (
                    id.clone(),
                    ChoiceQuestion {
                        instructions: q["instructions"].as_str().unwrap().into(),
                        options,
                    },
                )
            })
            .collect()
    }

    fn same(a: &BTreeMap<String, ChoiceQuestion>, b: &BTreeMap<String, ChoiceQuestion>) {
        assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
        for (id, q) in a {
            assert_eq!(q.instructions, b[id].instructions, "{id}");
            assert_eq!(q.options, b[id].options, "{id}");
        }
    }

    #[test]
    fn label_questions_match_centrals_requests() {
        same(
            &prompts().labels.questions(),
            &jev_questions(&snapshot(), "labels.release-notes"),
        );
    }

    #[test]
    fn judge_questions_match_centrals_requests() {
        let snap = snapshot();
        let j = &prompts().judge;
        let one = |rules| BTreeMap::from([("same_c1".to_string(), j.question("c1", rules))]);
        same(
            &one(JudgeRules::Short { mixed: false }),
            &jev_questions(&snap, "judge.release-notes.short-rules-all"),
        );
        same(
            &one(JudgeRules::Short { mixed: true }),
            &jev_questions(&snap, "judge.guide-vs-release-notes"),
        );
        same(
            &one(JudgeRules::Long {
                advisory: false,
                mixed: true,
            }),
            &jev_questions(&snap, "judge.docs"),
        );
        same(
            &one(JudgeRules::Long {
                advisory: true,
                mixed: false,
            }),
            &jev_questions(&snap, "judge.advisory"),
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
