//! Record labels (central's step D, `classify/labels.ts` and `classify/adapter.ts`) and the closed-choice calls the
//! judge shares with them. On the labelling service when its key is configured; otherwise on the route that writes the
//! records (`gpt-6-luna`, or Haiku with an Anthropic key only), asked for one option per question and read on its
//! choices: probability 1 for the option chosen, 0 for the rest, as central's chat fallback reads it.
//!
//! The state is JSON text in central's key order: the labelling service reads it as written, so a parsed value (which
//! would sort its keys) is never sent.

use super::extract::Incoming;
use super::results::{Entry, Outcome, Results, model_key};
use crate::inference::{ChoiceQuestion, Deferred, Inference, Kind, Prompt};
use crate::prompts::{Prompts, apply_edits, fill};
use crate::util::sha256_hex;
use serde::Serialize;
use serde_json::Value;
use serde_json::value::RawValue;
use std::collections::BTreeMap;
use unstale_schema::catalog::{
    Benefit, BenefitScore, ChangeType, Classification, Classifier, Surface,
};

pub const STEP_LABELS: &str = "labels";
pub const STEP_JUDGE: &str = "judge";
const ATTEMPTS: usize = 3;

/// One answer: the option chosen, its confidence and every option's probability.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Choice {
    pub choice: String,
    pub confidence: f64,
    pub probabilities: BTreeMap<String, f64>,
}

/// The answers to one request, and how far its probabilities can be trusted.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Answers {
    pub classifier: String,
    pub model: String,
    pub answers: BTreeMap<String, Choice>,
    /// False for a text generator read on its choices.
    pub calibrated: bool,
}

/// `recordState`: what the label questions are asked about, in central's key order.
#[derive(Serialize)]
struct RecordState<'a> {
    technology: &'a str,
    source: &'a str,
    release: &'a str,
    subject: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    facet: Option<&'a str>,
    summary: &'a str,
    evidence: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    section: Option<&'a str>,
    introduces: &'a [String],
    replaces: &'a [String],
}

pub fn record_state(p: &Prompts, name: &str, r: &Incoming) -> Box<RawValue> {
    let s = &p.labels.sources;
    let source = match r.kind.as_deref() {
        Some("upgrade_guide") => &s.upgrade_guide,
        Some("docs") => &s.docs,
        _ => &s.release_notes,
    };
    let st = RecordState {
        technology: name,
        source,
        release: &r.version,
        subject: &r.subject,
        facet: r.facet.as_deref(),
        summary: &r.summary,
        evidence: &r.quote,
        section: r.section.as_deref(),
        introduces: &r.introduces,
        replaces: &r.replaces,
    };
    serde_json::value::to_raw_value(&st).expect("a state serializes")
}

/// `canonical`: JSON with every object's keys sorted, as central's chat prompt states the state.
fn canonical(state: &RawValue) -> String {
    // serde_json's map is ordered by key, so a parse and a write sorts every level.
    serde_json::from_str::<Value>(state.get())
        .map(|v| v.to_string())
        .unwrap_or_default()
}

/// `JSON.stringify(v, null, 1)` of the questions as the chat prompt lists them: `{id: {instructions, options}}`, options
/// in their order.
fn questions_text(qs: &[(String, ChoiceQuestion)]) -> String {
    struct Opts<'a>(&'a [(String, String)]);
    impl Serialize for Opts<'_> {
        fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut m = s.serialize_map(Some(self.0.len()))?;
            for (k, v) in self.0 {
                m.serialize_entry(k, v)?;
            }
            m.end()
        }
    }
    #[derive(Serialize)]
    struct Q<'a> {
        instructions: &'a str,
        options: Opts<'a>,
    }
    struct All<'a>(&'a [(String, ChoiceQuestion)]);
    impl Serialize for All<'_> {
        fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
            use serde::ser::SerializeMap;
            let mut m = s.serialize_map(Some(self.0.len()))?;
            for (id, q) in self.0 {
                m.serialize_entry(
                    id,
                    &Q {
                        instructions: &q.instructions,
                        options: Opts(&q.options),
                    },
                )?;
            }
            m.end()
        }
    }
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    let _ = All(qs).serialize(&mut ser);
    String::from_utf8(out).unwrap_or_default()
}

/// The chat classifier's prompt (`ChatClassifier.prompt`).
pub fn chat_prompt(p: &Prompts, state: &RawValue, qs: &[(String, ChoiceQuestion)]) -> String {
    // Central's `String.replace` with a string: the first occurrence, the canonical state first.
    p.choice
        .prompt
        .replacen("%STATE%", &canonical(state), 1)
        .replacen("%QUESTIONS%", &questions_text(qs), 1)
}

/// The batched form for Codex: several records' states, the questions once, answered by record id.
pub fn chat_batch_prompt(
    p: &Prompts,
    states: &[(String, &RawValue)],
    qs: &[(String, ChoiceQuestion)],
) -> Result<String, Deferred> {
    let template =
        apply_edits(&p.choice.prompt, &p.choice.batch).map_err(|_| Deferred::Rejected)?;
    let records: Vec<String> = states
        .iter()
        .map(|(id, s)| format!("{id}: {}", s.get()))
        .collect();
    Ok(fill(
        &template,
        &[
            ("RECORDS", &records.join("\n")),
            ("QUESTIONS", &questions_text(qs)),
        ],
    ))
}

/// The option an answer names: its key, or else the one option whose text it repeats (compared without surrounding
/// whitespace, a trailing full stop or case). Central's `optionKey` reads answers the same way. `None` when the answer
/// names no option, or repeats the text of more than one.
fn option_key(q: &ChoiceQuestion, answer: &str) -> Option<String> {
    if q.options.iter().any(|(k, _)| k == answer) {
        return Some(answer.to_string());
    }
    fn norm(s: &str) -> String {
        let ws = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c');
        let s = s.trim_matches(ws);
        s.strip_suffix('.')
            .unwrap_or(s)
            .trim_matches(ws)
            .to_lowercase()
    }
    let a = norm(answer);
    let mut hits = q.options.iter().filter(|(_, text)| norm(text) == a);
    match (hits.next(), hits.next()) {
        (Some((k, _)), None) => Some(k.clone()),
        _ => None,
    }
}

/// A chat answer read on its choices: every question answered with one of its options, or nothing.
fn read_choices(v: &Value, qs: &[(String, ChoiceQuestion)]) -> Option<BTreeMap<String, Choice>> {
    let o = v.as_object()?;
    let mut out = BTreeMap::new();
    for (id, q) in qs {
        let c = match o.get(id)? {
            Value::String(s) => s.clone(),
            Value::Object(m) => m.get("choice")?.as_str()?.to_string(),
            _ => return None,
        };
        let c = option_key(q, &c)?;
        let probabilities = q
            .options
            .iter()
            .map(|(k, _)| (k.clone(), if *k == c { 1.0 } else { 0.0 }))
            .collect();
        out.insert(
            id.clone(),
            Choice {
                choice: c,
                confidence: 1.0,
                probabilities,
            },
        );
    }
    Some(out)
}

/// Closed-choice questions on the configured route, cached in the user-level result cache.
pub struct Chooser<'a> {
    pub inf: &'a Inference,
    pub results: &'a Results,
    pub prompts: &'static Prompts,
    pub calls: std::cell::Cell<usize>,
    /// Requests this route refused in a row: past a few, the pass stops ([`super::Streak`]).
    pub rejected: super::Streak,
}

impl<'a> Chooser<'a> {
    pub fn new(inf: &'a Inference, results: &'a Results) -> Chooser<'a> {
        Chooser {
            inf,
            results,
            prompts: crate::prompts::prompts(),
            calls: Default::default(),
            rejected: Default::default(),
        }
    }

    fn version(&self, step: &str) -> u32 {
        if step == STEP_LABELS {
            self.prompts.labels.version
        } else {
            self.prompts.judge.version
        }
    }

    fn request_text(&self, state: &RawValue, qs: &[(String, ChoiceQuestion)]) -> String {
        match self.inf.provider.kind {
            Kind::Jev => String::from_utf8(crate::inference::jev_request_body(
                &self.inf.provider.model,
                state,
                qs,
            ))
            .unwrap_or_default(),
            _ => chat_prompt(self.prompts, state, qs),
        }
    }

    fn key(&self, step: &str, state: &RawValue, qs: &[(String, ChoiceQuestion)]) -> String {
        Results::key(
            step,
            &model_key(&self.inf.provider),
            self.version(step),
            &sha256_hex(state.get().as_bytes()),
            &self.request_text(state, qs),
        )
    }

    fn batch_key(&self, step: &str, state: &RawValue, qs: &[(String, ChoiceQuestion)]) -> String {
        Results::key_in(
            "batch8",
            step,
            &model_key(&self.inf.provider),
            self.version(step),
            &sha256_hex(state.get().as_bytes()),
            &self.request_text(state, qs),
        )
    }

    /// A standing entry for this request (asked alone, or in a batch on a route that writes text); a failure stands
    /// until its retry date.
    fn cached(
        &self,
        step: &str,
        state: &RawValue,
        qs: &[(String, ChoiceQuestion)],
        today: &str,
    ) -> Option<Entry> {
        let alone = self
            .results
            .get(&self.key(step, state, qs))
            .filter(|e| e.stands(today));
        alone.or_else(|| {
            (self.inf.provider.kind != Kind::Jev)
                .then(|| {
                    self.results
                        .get(&self.batch_key(step, state, qs))
                        .filter(|e| e.stands(today))
                })
                .flatten()
        })
    }

    fn entry(
        &self,
        step: &str,
        state: &RawValue,
        model_version: Option<String>,
        outcome: Outcome,
    ) -> Entry {
        Entry {
            step: step.into(),
            model: model_key(&self.inf.provider),
            prompt_version: self.version(step),
            chunk: sha256_hex(state.get().as_bytes()),
            provider: self.inf.provider.name.clone(),
            model_version,
            outcome,
        }
    }

    /// The answers to `qs` about `state`; `Ok(None)` when this request failed (unreadable after the attempts, refused,
    /// or too large): that item waits for its retry date while the rest go on. A deferral of the route stops the step.
    /// An answer is used even when it cannot be written to the cache.
    pub fn ask(
        &self,
        step: &str,
        state: &RawValue,
        qs: &[(String, ChoiceQuestion)],
    ) -> Result<Option<Answers>, Deferred> {
        let today = crate::util::today();
        if let Some(e) = self.cached(step, state, qs, &today) {
            return Ok(match e.outcome {
                Outcome::Answer { answer } => serde_json::from_value(answer).ok(),
                _ => None,
            });
        }
        let key = self.key(step, state, qs);
        let prior = self.results.get(&key);
        let got = match self.inf.provider.kind {
            Kind::Jev => {
                self.calls.set(self.calls.get() + 1);
                match self.rejected.check(self.inf.classify(state, qs))? {
                    // Part of the questions were answered: nothing is kept until all are.
                    Ok(c) if c.deferred.is_some() => {
                        return Err(c.deferred.unwrap_or(Deferred::Unavailable));
                    }
                    Ok(c) => Some(Answers {
                        classifier: "jev".into(),
                        model: c.model,
                        answers: c
                            .answers
                            .into_iter()
                            .map(|(k, v)| {
                                (
                                    k,
                                    Choice {
                                        choice: v.choice,
                                        confidence: v.confidence,
                                        probabilities: v.probabilities,
                                    },
                                )
                            })
                            .collect(),
                        calibrated: true,
                    }),
                    // This request only: unreadable, over the size limit or refused.
                    Err(Deferred::Malformed | Deferred::TooLong | Deferred::Rejected) => None,
                    Err(d) => return Err(d),
                }
            }
            _ => {
                let prompt = Prompt {
                    max_tokens: 16_000,
                    ..Prompt::new(chat_prompt(self.prompts, state, qs)).raw()
                };
                let mut got = None;
                for attempt in 0..ATTEMPTS {
                    if attempt > 0 {
                        std::thread::sleep(self.inf.limits.backoff * attempt as u32);
                    }
                    self.calls.set(self.calls.get() + 1);
                    match self.rejected.check(self.inf.complete(&prompt))? {
                        Ok(a) => {
                            let v = a.value.as_str().and_then(|t| {
                                super::extract::parse_json(t, super::extract::Kind2::Object)
                            });
                            if let Some(answers) = v.as_ref().and_then(|v| read_choices(v, qs)) {
                                got = Some(Answers {
                                    classifier: "chat".into(),
                                    model: a.model,
                                    answers,
                                    calibrated: false,
                                });
                                break;
                            }
                        }
                        Err(Deferred::Malformed) => {}
                        Err(Deferred::TooLong | Deferred::Rejected) => break,
                        Err(d) => return Err(d),
                    }
                }
                got
            }
        };
        let outcome = match &got {
            Some(a) => Outcome::Answer {
                answer: serde_json::to_value(a).unwrap_or(Value::Null),
            },
            None => Outcome::failed_after(prior.as_ref(), &today),
        };
        self.results.put(
            &key,
            &self.entry(step, state, got.as_ref().map(|a| a.model.clone()), outcome),
        );
        Ok(got)
    }

    /// On a route that writes text (a key or Codex; never the labelling service, which takes one record a request):
    /// these records' label requests not yet answered, up to eight to a call, answered by record id and cached apart
    /// from requests asked alone. Nearly all of a label request is the questions' text (about 1,550 of 1,630 input
    /// tokens), so eight records share it (`eval/edge-port/RESULTS.md`, "Labels, several records to a call").
    ///
    /// Whatever a batch does not answer is asked alone by [`Chooser::ask`]: a record it left out or answered
    /// unreadably, every record of a batch that came back unreadable, cut off or refused, and a record with no
    /// companion (a batch of one would save nothing). Each call is counted once in the token ledger, by the provider
    /// layer; a deferral of the route (the monthly limit, a key problem) stops here with the answers so far cached.
    pub fn prefetch(
        &self,
        step: &str,
        states: &[Box<RawValue>],
        qs: &[(String, ChoiceQuestion)],
    ) -> Result<(), Deferred> {
        if self.inf.provider.kind == Kind::Jev {
            return Ok(());
        }
        let today = crate::util::today();
        let todo: Vec<&Box<RawValue>> = states
            .iter()
            .filter(|s| self.cached(step, s, qs, &today).is_none())
            .collect();
        for group in todo.chunks(crate::inference::BATCH) {
            if group.len() < 2 {
                continue;
            }
            let ids: Vec<(String, &RawValue)> = group
                .iter()
                .enumerate()
                .map(|(i, s)| (format!("r{}", i + 1), &***s))
                .collect();
            let text = chat_batch_prompt(self.prompts, &ids, qs)?;
            self.calls.set(self.calls.get() + 1);
            let a = match self.rejected.check(self.inf.complete(&Prompt {
                max_tokens: 16_000,
                ..Prompt::new(text).raw()
            }))? {
                Ok(a) => a,
                Err(Deferred::Malformed | Deferred::TooLong | Deferred::Rejected) => continue,
                Err(d) => return Err(d),
            };
            let Some(all) = a
                .value
                .as_str()
                .and_then(|t| super::extract::parse_json(t, super::extract::Kind2::Object))
            else {
                continue;
            };
            for (id, s) in &ids {
                if let Some(answers) = all.get(id).and_then(|v| read_choices(v, qs)) {
                    let got = Answers {
                        classifier: "chat".into(),
                        model: a.model.clone(),
                        answers,
                        calibrated: false,
                    };
                    let e = self.entry(
                        step,
                        s,
                        Some(a.model.clone()),
                        Outcome::Answer {
                            answer: serde_json::to_value(&got).unwrap_or(Value::Null),
                        },
                    );
                    self.results.put(&self.batch_key(step, s, qs), &e);
                }
            }
        }
        Ok(())
    }
}

/// A record's labels (`interpret`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Labels {
    pub change_type: ChangeType,
    pub surface: Surface,
    pub breaking: bool,
    pub benefit: Vec<Benefit>,
    pub classifier: Classification,
}

fn enum_of<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(Value::String(s.into())).ok()
}

/// `interpret`: answers to labels, with the thresholds of `schema/prompts/thresholds.json`.
pub fn interpret(p: &Prompts, a: &Answers) -> Option<Labels> {
    let t = &p.thresholds;
    let border = |x: f64| x >= t.borderline[0] && x < t.borderline[1];
    let ct = a.answers.get("change_type")?;
    let sf = a.answers.get("surface")?;
    let mut borderline = vec![];
    if ct.confidence < t.choice_confidence {
        borderline.push("change_type".to_string());
    }
    if sf.confidence < t.choice_confidence {
        borderline.push("surface".to_string());
    }
    let p_breaking = *a.answers.get("breaking")?.probabilities.get("yes")?;
    if border(p_breaking) {
        borderline.push("breaking".into());
    }
    let mut scores = vec![];
    let mut present = vec![];
    for b in &p.labels.benefits {
        let pb = *a
            .answers
            .get(&format!("benefit_{}", b.id))?
            .probabilities
            .get("yes")?;
        if border(pb) {
            borderline.push(format!("benefit:{}", b.id));
        }
        let benefit: Benefit = enum_of(&b.id)?;
        if pb >= t.benefit_p {
            present.push(benefit);
        }
        scores.push(BenefitScore { benefit, p: pb });
    }
    Some(Labels {
        change_type: enum_of(&ct.choice)?,
        surface: enum_of(&sf.choice)?,
        breaking: p_breaking >= t.breaking_p,
        benefit: if present.is_empty() {
            vec![Benefit::None]
        } else {
            present
        },
        classifier: Classification {
            classifier: if a.classifier == "jev" {
                Classifier::Jev
            } else {
                Classifier::Chat
            },
            model: a.model.clone(),
            change_type: ct.confidence,
            surface: sf.confidence,
            breaking: p_breaking,
            benefit: scores,
            borderline,
        },
    })
}

#[cfg(test)]
mod choice_tests {
    use super::*;

    fn same(c: &str) -> (String, ChoiceQuestion) {
        (
            format!("same_{c}"),
            ChoiceQuestion {
                instructions: format!("Is the incoming change the same change as candidate {c}?"),
                options: vec![
                    ("yes".into(), format!("The same change as candidate {c}.")),
                    (
                        "no".into(),
                        format!("A different change from candidate {c}, or unsure."),
                    ),
                ],
            },
        )
    }

    fn picked(a: &BTreeMap<String, Choice>) -> Vec<(&str, &str)> {
        a.iter()
            .map(|(k, v)| (k.as_str(), v.choice.as_str()))
            .collect()
    }

    #[test]
    fn an_answer_repeating_one_options_text_reads_as_its_key() {
        let qs = [same("c1"), same("c2"), same("c3")];
        // The parity run's matching item nuxt@4.3.0#0.3, answered with the options' text.
        let v = serde_json::json!({
            "same_c1": "The same change as candidate c1.",
            "same_c2": "A different change from candidate c2, or unsure.",
            "same_c3": "A different change from candidate c3, or unsure."
        });
        let a = read_choices(&v, &qs).expect("read");
        assert_eq!(
            picked(&a),
            [("same_c1", "yes"), ("same_c2", "no"), ("same_c3", "no")]
        );
        assert_eq!(a["same_c1"].probabilities["yes"], 1.0);
        // Whitespace, the trailing full stop and case do not matter; keys still read as before.
        let v = serde_json::json!({
            "same_c1": "  the same change as candidate C1 \n",
            "same_c2": {"choice": "no"},
            "same_c3": "yes"
        });
        let a = read_choices(&v, &qs).expect("read");
        assert_eq!(
            picked(&a),
            [("same_c1", "yes"), ("same_c2", "no"), ("same_c3", "yes")]
        );
    }

    #[test]
    fn an_unknown_or_ambiguous_answer_stays_unreadable() {
        let qs = [same("c1")];
        for unknown in ["The same change", "maybe", "candidate c1", ""] {
            let v = serde_json::json!({ "same_c1": unknown });
            assert!(read_choices(&v, &qs).is_none(), "{unknown:?}");
        }
        let twice = (
            "q".to_string(),
            ChoiceQuestion {
                instructions: String::new(),
                options: vec![
                    ("a".into(), "Unsure.".into()),
                    ("b".into(), "unsure".into()),
                ],
            },
        );
        let v = serde_json::json!({ "q": "Unsure" });
        let twice = std::slice::from_ref(&twice);
        assert!(read_choices(&v, twice).is_none());
        // A key wins over another option's text.
        let v = serde_json::json!({ "q": "b" });
        assert_eq!(picked(&read_choices(&v, twice).unwrap()), [("q", "b")]);
    }
}
