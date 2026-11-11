//! Extraction on the client: a change event's chunks become raw records (central's `Incoming`) through the same two
//! calls central makes (`central/src/pipeline/extract.ts`, two-call structure, quoted evidence): the extract call per
//! chunk, then the label call for that chunk's records, answered by record id. A chunk whose extract answer runs out
//! of room is split into pieces (`splitChunk`) and each piece extracted. Through Codex the extract calls of short chunks
//! go up to eight at a time, bounded in length, answered by chunk id ([`Extractor::prefetch`]); long ones go alone.
//!
//! Every answer goes to the user-level result cache ([`super::results`]) as soon as it returns. A provider or budget
//! problem stops the step with a [`Deferred`]; what was answered stays cached for the next run.

use super::js::{self, MIN_SPLIT};
use super::results::{Entry, Outcome, Results, model_key};
use crate::inference::{Deferred, Inference, Kind, Prompt};
use crate::prompts::{Prompts, apply_edits, fill};
use crate::util::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use unstale_schema::catalog::{EventLine, EvidenceKind};

/// Attempts at a request whose answer cannot be read, as central makes (`extractLlm`).
const ATTEMPTS: usize = 3;
/// The answer budget of one call (central's `MAX_TOKENS`).
const MAX_TOKENS: u32 = 16_000;

pub const STEP_EXTRACT: &str = "extract";
pub const STEP_LABEL: &str = "extract-label";

/// A requirement the notes state, as a manifest declares it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prerequisite {
    pub ecosystem: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<String>,
}

/// One record as extracted and labelled from one event, before classification and matching (central's `Incoming`,
/// with its field names).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Incoming {
    /// `{event id}#{chunk}.{index}`.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub impact: Option<String>,
    pub technology: String,
    pub version: String,
    #[serde(
        default,
        rename = "noLaterThan",
        skip_serializing_if = "Option::is_none"
    )]
    pub no_later_than: Option<String>,
    pub date: String,
    pub line: String,
    pub url: String,
    pub snapshot: String,
    pub subject: String,
    pub subject_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint_change_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint_surface: Option<String>,
    pub summary: String,
    pub introduces: Vec<String>,
    pub quote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    pub grounded: bool,
    pub terms: Vec<String>,
    pub replaces: Vec<String>,
    pub requires: Vec<String>,
    pub prerequisites: Vec<Prerequisite>,
    pub conditions: Vec<String>,
}

/// Who answered: what a record made from these calls carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub provider: String,
    pub model: String,
    /// The model the provider reported, when it reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_version: Option<String>,
    /// `schema/prompts/extract.json`'s version.
    pub prompt_version: u32,
}

/// An event's records, and the calls that gave no usable answer (as central counts them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Extraction {
    pub event: String,
    pub incoming: Vec<Incoming>,
    pub failed: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<Provenance>,
}

/// An extract answer's record that passes central's `Extracted` schema.
#[derive(Debug, Clone)]
struct Extracted {
    subject: String,
    subject_kind: Option<String>,
    facet: Option<String>,
    change_type: Option<String>,
    surface: Option<String>,
    summary: String,
    audience: Option<String>,
    introduces: Option<Value>,
    evidence: Option<String>,
}

/// `Extracted.safeParse`: subject and summary non-empty strings; the other fields absent, null or of their type;
/// `audience` absent or one of its four values.
fn parse_extracted(v: &Value) -> Option<Extracted> {
    let o = v.as_object()?;
    let req = |k: &str| {
        o.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(String::from)
    };
    let opt = |k: &str| -> Result<Option<String>, ()> {
        match o.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            _ => Err(()),
        }
    };
    let audience = match o.get("audience") {
        None => None,
        Some(Value::String(a))
            if ["application", "extension_author", "maintainer", "general"]
                .contains(&a.as_str()) =>
        {
            Some(a.clone())
        }
        Some(_) => return None,
    };
    let introduces = match o.get("introduces") {
        None | Some(Value::Null) => None,
        Some(a @ Value::Array(_)) => Some(a.clone()),
        Some(_) => return None,
    };
    Some(Extracted {
        subject: req("subject")?,
        subject_kind: opt("subject_kind").ok()?,
        facet: opt("facet").ok()?,
        change_type: opt("change_type").ok()?,
        surface: opt("surface").ok()?,
        summary: req("summary")?,
        audience,
        introduces,
        evidence: opt("evidence").ok()?,
    })
}

/// The label call's brief of one record, in central's key order.
#[derive(Serialize)]
struct Brief<'a> {
    id: String,
    subject: &'a str,
    facet: Option<&'a str>,
    change_type: Option<&'a str>,
    summary: &'a str,
    introduces: Vec<String>,
    evidence: &'a str,
}

/// `JSON.stringify(v, null, 1)`.
fn pretty1(v: &impl Serialize) -> String {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b" "),
    );
    if v.serialize(&mut ser).is_err() {
        return String::new();
    }
    String::from_utf8(out).unwrap_or_default()
}

/// The labels' five fields as central's `Labels` schema reads them: all, or (any of the wrong type) none.
fn label_fields(v: Option<&Value>) -> serde_json::Map<String, Value> {
    let Some(Value::Object(o)) = v else {
        return Default::default();
    };
    for k in [
        "terms",
        "replaces",
        "requires",
        "prerequisites",
        "conditions",
    ] {
        if !matches!(o.get(k), None | Some(Value::Null) | Some(Value::Array(_))) {
            return Default::default();
        }
    }
    o.clone()
}

/// `String(x)` of a prerequisite bound (a string, or a JSON number as JavaScript prints it).
fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            Some(f) => format!("{f}"),
            None => n.to_string(),
        }),
        _ => None,
    }
}

fn prerequisites(v: Option<&Value>) -> Vec<Prerequisite> {
    let mut out: Vec<Prerequisite> = Vec::new();
    for p in v.and_then(Value::as_array).into_iter().flatten() {
        let Some(o) = p.as_object() else { continue };
        let s = |k: &str| o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
        let (Some(eco), Some(name)) = (s("ecosystem"), s("name")) else {
            continue;
        };
        let bound = |k: &str| -> Result<Option<String>, ()> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v @ (Value::String(_) | Value::Number(_))) => Ok(js_string(v)),
                _ => Err(()),
            }
        };
        let (Ok(min), Ok(max)) = (bound("min"), bound("max")) else {
            continue;
        };
        let keep = |b: Option<String>| {
            b.filter(|x| !js::js_trim(x).is_empty())
                .map(|x| js::one_line(&x, 40))
        };
        let pr = Prerequisite {
            ecosystem: js::one_line(eco, 40).to_lowercase(),
            name: js::one_line(name, 200),
            min: keep(min),
            max: keep(max),
        };
        if !out
            .iter()
            .any(|x| x.ecosystem == pr.ecosystem && x.name == pr.name)
        {
            out.push(pr);
        }
    }
    out
}

fn kind_name(k: EvidenceKind) -> Option<&'static str> {
    match k {
        EvidenceKind::UpgradeGuide => Some("upgrade_guide"),
        EvidenceKind::Docs => Some("docs"),
        _ => None,
    }
}

/// `toIncoming`: one extracted record with its labels, as central builds it.
fn to_incoming(
    p: &Prompts,
    ev: &EventLine,
    ci: usize,
    i: usize,
    r: &Extracted,
    raw_labels: Option<&Value>,
    notes: &str,
) -> Incoming {
    let lab = label_fields(raw_labels);
    let introduces = js::strings(r.introduces.as_ref(), 20);
    let subject = js::clean_subject(&r.subject);
    let facet = r
        .facet
        .as_deref()
        .filter(|f| !f.is_empty())
        .map(js::clean_subject)
        .filter(|f| !f.is_empty());
    let whole_starts = ev.chunks.first().map(|c| c.text.as_str()).unwrap_or("");
    let marked = whole_starts.starts_with(&p.extract.docs_preamble_marked);
    let evidence = js::js_trim(r.evidence.as_deref().unwrap_or(""));
    let quote = if marked {
        js::js_trim(&js::unmark_quote(evidence)).to_string()
    } else {
        evidence.to_string()
    };
    let (grounded, section) = if marked {
        let (after, before) = js::mark_views(notes);
        [js::locate(&after, &quote), js::locate(&before, &quote)]
            .into_iter()
            .find(|w| w.0)
            .unwrap_or((false, None))
    } else {
        js::locate(notes, &quote)
    };
    let subject_kind = match r.subject_kind.as_deref() {
        Some("concept") => "concept",
        Some("literal") => "literal",
        _ if js::looks_literal(&subject) => "literal",
        _ => "concept",
    };
    let mut conditions = js::strings(lab.get("conditions"), 6);
    match r.audience.as_deref() {
        Some("extension_author") => conditions.push(
            "Audience: authors of custom providers, plugins, adapters or integrations.".into(),
        ),
        Some("maintainer") => conditions.push(
            "Audience: technology maintainers; ordinary applications may not benefit.".into(),
        ),
        _ => {}
    }
    let kind = kind_name(ev.kind);
    if kind == Some("docs") {
        conditions.push(format!(
            "Documentation change observed on {}; confirm version applicability against the linked source.",
            ev.date
        ));
    }
    let impact = if kind == Some("upgrade_guide") {
        js::impact_of(notes, section.as_deref())
    } else {
        None
    };
    let terms: Vec<String> = js::strings(lab.get("terms"), 40)
        .into_iter()
        .filter(|x| !introduces.contains(x))
        .take(12)
        .collect();
    Incoming {
        key: format!("{}#{ci}.{i}", ev.id),
        kind: kind.map(String::from),
        impact,
        technology: ev.technology.clone(),
        version: ev.version.clone(),
        no_later_than: ev.no_later_than.clone(),
        date: ev.date.clone(),
        line: js::release_line(&ev.version),
        url: ev.url.clone(),
        snapshot: ev.snapshot.clone(),
        subject,
        subject_kind: subject_kind.into(),
        facet,
        hint_change_type: r.change_type.clone().filter(|s| !s.is_empty()),
        hint_surface: r.surface.clone().filter(|s| !s.is_empty()),
        summary: js::words(&r.summary, 40),
        introduces,
        quote,
        section,
        grounded,
        terms,
        replaces: js::strings(lab.get("replaces"), 4),
        requires: js::strings(lab.get("requires"), 6),
        prerequisites: prerequisites(lab.get("prerequisites")),
        conditions,
    }
}

/// What one extract call came to.
enum First {
    Records(Vec<Extracted>),
    Truncated,
    Failed,
}

pub struct Extractor<'a> {
    pub inf: &'a Inference,
    pub results: &'a Results,
    pub prompts: &'static Prompts,
    /// Provider calls made (cache hits are not calls).
    pub calls: std::cell::Cell<usize>,
    /// Requests this route refused in a row: past a few, the pass stops ([`super::Streak`]).
    pub rejected: super::Streak,
}

impl<'a> Extractor<'a> {
    pub fn new(inf: &'a Inference, results: &'a Results) -> Extractor<'a> {
        Extractor {
            inf,
            results,
            prompts: crate::prompts::prompts(),
            calls: Default::default(),
            rejected: Default::default(),
        }
    }

    fn version(&self) -> u32 {
        self.prompts.extract.version
    }

    fn model(&self) -> String {
        model_key(&self.inf.provider)
    }

    fn date(ev: &EventLine) -> &str {
        ev.prompt_date.as_deref().unwrap_or(&ev.date)
    }

    /// The extract prompt for one chunk or piece.
    pub fn extract_prompt(&self, ev: &EventLine, notes: &str, part: &str) -> String {
        let vars = [
            ("TECH", ev.name.as_str()),
            ("VERSION", ev.version.as_str()),
            ("DATE", Self::date(ev)),
            ("PART", part),
            ("NOTES", notes),
        ];
        fill(&self.prompts.extract.extract, &vars)
    }

    fn part_line(&self, n: usize, of: usize) -> String {
        if of > 1 {
            fill(
                &self.prompts.extract.part_line,
                &[("N", &(n + 1).to_string()), ("OF", &of.to_string())],
            )
        } else {
            String::new()
        }
    }

    fn key(&self, step: &str, notes: &str, prompt: &str) -> String {
        Results::key(
            step,
            &self.model(),
            self.version(),
            &sha256_hex(notes.as_bytes()),
            prompt,
        )
    }

    fn entry(
        &self,
        step: &str,
        notes: &str,
        model_version: Option<String>,
        outcome: Outcome,
    ) -> Entry {
        Entry {
            step: step.into(),
            model: self.model(),
            prompt_version: self.version(),
            chunk: sha256_hex(notes.as_bytes()),
            provider: self.inf.provider.name.clone(),
            model_version,
            outcome,
        }
    }

    fn batch_key(&self, step: &str, notes: &str, prompt: &str) -> String {
        Results::key_in(
            BATCH_FORM,
            step,
            &self.model(),
            self.version(),
            &sha256_hex(notes.as_bytes()),
            prompt,
        )
    }

    /// One call with central's attempts: an answer that `accept` takes, `Truncated`, `Failed` after the attempts, or a
    /// deferral that stops the step. The outcome is cached before it is returned.
    fn ask(&self, step: &str, notes: &str, prompt: &str, kind: Kind2) -> Result<Entry, Deferred> {
        let key = self.key(step, notes, prompt);
        let today = crate::util::today();
        let prior = self.results.get(&key);
        if let Some(e) = prior.as_ref().filter(|e| e.stands(&today)) {
            return Ok(e.clone());
        }
        // Through Codex, an answer given in a batch ([`Extractor::prefetch`]) stands in for one asked alone.
        if self.inf.provider.kind == Kind::Codex
            && let Some(e) = self
                .results
                .get(&self.batch_key(step, notes, prompt))
                .filter(|e| e.stands(&today))
        {
            return Ok(e);
        }
        let p = Prompt::new(prompt).raw();
        let p = Prompt {
            max_tokens: MAX_TOKENS,
            ..p
        };
        let mut outcome = None;
        let mut model_version = None;
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                std::thread::sleep(self.inf.limits.backoff * attempt as u32);
            }
            self.calls.set(self.calls.get() + 1);
            match self.rejected.check(self.inf.complete(&p))? {
                Ok(a) => {
                    if let Some(v) = a.value.as_str().and_then(|t| parse_json(t, kind)) {
                        model_version = Some(a.model);
                        outcome = Some(Outcome::Answer { answer: v });
                        break;
                    }
                }
                Err(Deferred::Malformed) => {}
                Err(Deferred::TooLong) => {
                    outcome = Some(Outcome::Truncated);
                    break;
                }
                // The provider refused this request (a 400): the item fails; the rest of the queue goes on.
                Err(Deferred::Rejected) => break,
                Err(d) => return Err(d),
            }
        }
        let outcome = outcome.unwrap_or_else(|| Outcome::failed_after(prior.as_ref(), &today));
        let e = self.entry(step, notes, model_version, outcome);
        // Kept for this pass even when it cannot be written: the answer was paid for.
        self.results.put(&key, &e);
        Ok(e)
    }

    fn first(
        &self,
        ev: &EventLine,
        notes: &str,
        part: &str,
        prov: &mut Option<Provenance>,
    ) -> Result<First, Deferred> {
        let prompt = self.extract_prompt(ev, notes, part);
        let e = self.ask(STEP_EXTRACT, notes, &prompt, Kind2::Array)?;
        if prov.is_none() && matches!(e.outcome, Outcome::Answer { .. }) {
            *prov = Some(Provenance {
                provider: e.provider.clone(),
                model: e.model.clone(),
                model_version: e.model_version.clone(),
                prompt_version: e.prompt_version,
            });
        }
        Ok(match e.outcome {
            Outcome::Answer { answer } => First::Records(
                answer
                    .as_array()
                    .map(|a| a.iter().filter_map(parse_extracted).collect())
                    .unwrap_or_default(),
            ),
            Outcome::Truncated => First::Truncated,
            Outcome::Failed { .. } => First::Failed,
        })
    }

    /// `twoCall`: records of one chunk or piece with their raw labels, and the failed calls.
    #[allow(clippy::type_complexity)]
    fn two_call(
        &self,
        ev: &EventLine,
        notes: &str,
        part: &str,
        prov: &mut Option<Provenance>,
    ) -> Result<(Vec<(Extracted, Option<Value>, String)>, usize), Deferred> {
        if js::js_trim(notes).is_empty() || js::content_free(notes) {
            return Ok((vec![], 0));
        }
        let recs = match self.first(ev, notes, part, prov)? {
            First::Failed => return Ok((vec![], 1)),
            First::Truncated if js::len16(notes) < MIN_SPLIT => return Ok((vec![], 1)),
            First::Truncated => {
                let e = &self.prompts.extract;
                let pieces = js::split_chunk(notes, [&e.docs_preamble_marked, &e.docs_preamble]);
                let (mut all, mut failed) = (vec![], 0);
                for (j, piece) in pieces.iter().enumerate() {
                    let piece_part = format!(
                        "{part}{}",
                        fill(
                            &e.piece_line,
                            &[
                                ("N", &(j + 1).to_string()),
                                ("OF", &pieces.len().to_string())
                            ]
                        )
                    );
                    let (r, f) = self.two_call(ev, piece, &piece_part, prov)?;
                    all.extend(r);
                    failed += f;
                }
                return Ok((all, failed));
            }
            First::Records(r) => r,
        };
        if recs.is_empty() {
            return Ok((vec![], 0));
        }
        let briefs: Vec<Brief> = recs
            .iter()
            .enumerate()
            .map(|(i, r)| Brief {
                id: format!("r{}", i + 1),
                subject: &r.subject,
                facet: r.facet.as_deref(),
                change_type: r.change_type.as_deref(),
                summary: &r.summary,
                introduces: js::strings(r.introduces.as_ref(), 20),
                evidence: r.evidence.as_deref().unwrap_or(""),
            })
            .collect();
        let prompt = fill(
            &self.prompts.extract.label,
            &[
                ("TECH", &ev.name),
                ("VERSION", &ev.version),
                ("RECORDS", &pretty1(&briefs)),
                ("NOTES", notes),
            ],
        );
        let labels = match self.ask(STEP_LABEL, notes, &prompt, Kind2::Object)?.outcome {
            Outcome::Answer { answer } => Some(answer),
            _ => None,
        };
        let failed = usize::from(labels.is_none());
        let out = recs
            .into_iter()
            .enumerate()
            .map(|(i, r)| {
                let l = labels
                    .as_ref()
                    .and_then(|l| l.get(format!("r{}", i + 1)))
                    .cloned();
                (r, l, notes.to_string())
            })
            .collect();
        Ok((out, failed))
    }

    /// `extractRelease`: an event's records in key order, or the deferral that stopped it (its answers stay cached).
    pub fn event(&self, ev: &EventLine) -> Result<Extraction, Deferred> {
        let mut prov = None;
        let mut out = vec![];
        let mut failed = 0;
        let n = ev.chunks.len();
        for (ci, c) in ev.chunks.iter().enumerate() {
            if c.content_free {
                continue;
            }
            let (recs, f) = self.two_call(ev, &c.text, &self.part_line(ci, n), &mut prov)?;
            failed += f;
            for (i, (r, l, notes)) in recs.iter().enumerate() {
                out.push(to_incoming(self.prompts, ev, ci, i, r, l.as_ref(), notes));
            }
        }
        out.sort_by(|a, b| numeric_cmp(&a.key, &b.key));
        Ok(Extraction {
            event: ev.id.clone(),
            incoming: out,
            failed,
            provenance: prov,
        })
    }

    /// Through Codex: the extract calls of these events' chunks not yet answered, up to eight to a call and at most
    /// [`BATCH_CHARS`] of notes in all, answered by chunk id and cached under each chunk's own key (a batch form of
    /// it). A chunk longer than [`ALONE_ABOVE_CHARS`], or one the batch leaves out, is asked alone by
    /// [`Extractor::event`], under the key of a call asked alone.
    pub fn prefetch(&self, events: &[&EventLine]) -> Result<(), Deferred> {
        if self.inf.provider.kind != Kind::Codex {
            return Ok(());
        }
        let mut todo: Vec<(&EventLine, &str, String)> = vec![];
        for ev in events {
            let n = ev.chunks.len();
            for (ci, c) in ev.chunks.iter().enumerate() {
                if c.content_free
                    || js::js_trim(&c.text).is_empty()
                    || js::content_free(&c.text)
                    || c.text.chars().count() > ALONE_ABOVE_CHARS
                {
                    continue;
                }
                let prompt = self.extract_prompt(ev, &c.text, &self.part_line(ci, n));
                let today = crate::util::today();
                let answered = |k: String| self.results.get(&k).is_some_and(|e| e.stands(&today));
                if !answered(self.key(STEP_EXTRACT, &c.text, &prompt))
                    && !answered(self.batch_key(STEP_EXTRACT, &c.text, &prompt))
                {
                    todo.push((ev, &c.text, prompt));
                }
            }
        }
        let e = &self.prompts.extract;
        let template =
            apply_edits(&e.extract, &e.variants.batch).map_err(|_| Deferred::Rejected)?;
        for group in batches(&todo, |(_, notes, _)| notes.chars().count()) {
            let body: Vec<String> = group
                .iter()
                .enumerate()
                .map(|(i, (ev, notes, _))| {
                    let id = format!("c{}", i + 1);
                    fill(
                        &e.batch_chunk,
                        &[
                            ("ID", &id),
                            ("TECH", &ev.name),
                            ("VERSION", &ev.version),
                            ("DATE", Self::date(ev)),
                            ("NOTES", notes),
                        ],
                    )
                })
                .collect();
            let text = fill(&template, &[("CHUNKS", &body.join("\n"))]);
            self.calls.set(self.calls.get() + 1);
            let a = match self.rejected.check(self.inf.complete(&Prompt {
                max_tokens: MAX_TOKENS,
                ..Prompt::new(text).raw()
            }))? {
                Ok(a) => a,
                // A batch that cannot be read is asked chunk by chunk instead.
                Err(Deferred::Malformed | Deferred::TooLong | Deferred::Rejected) => continue,
                Err(d) => return Err(d),
            };
            let Some(answers) = a.value.as_str().and_then(|t| parse_json(t, Kind2::Object)) else {
                continue;
            };
            for (i, (_, notes, prompt)) in group.iter().enumerate() {
                if let Some(v) = answers.get(format!("c{}", i + 1)).filter(|v| v.is_array()) {
                    // Kept apart from answers asked alone: the same model, another request.
                    let e = self.entry(
                        STEP_EXTRACT,
                        notes,
                        Some(a.model.clone()),
                        Outcome::Answer { answer: v.clone() },
                    );
                    self.results
                        .put(&self.batch_key(STEP_EXTRACT, notes, prompt), &e);
                }
            }
        }
        Ok(())
    }
}

/// Through Codex, a chunk longer than this many characters is extracted alone, never in a batch. In the parity run
/// (`eval/edge-port/RESULTS.md`, short notes, eight chunks to a call) the lost recall was in the batches holding long
/// chunks: the longest, 29,820 characters, gave 14 records in its batch against 37 to 75 alone, and the technology
/// with the long notes gave 96 records against 188 while the three with short notes came out level. The bound sits
/// between the short chunks that came out level and the long ones that lost records; with it, pooled recall went
/// from 53.5% to 60.1% (the same file, addendum 1).
///
/// Both bounds were derived from JavaScript string lengths (UTF-16 units); the client counts code points, which
/// differ only for astral characters.
pub const ALONE_ABOVE_CHARS: usize = 6_000;

/// Through Codex, the most characters of release notes one batched extract call carries. In the same run the batches
/// that lost recall were the ones carrying the most text; the bound keeps a batch near the size of those that came
/// out level. Measured together with [`ALONE_ABOVE_CHARS`] (`eval/edge-port/RESULTS.md`, addendum 1).
pub const BATCH_CHARS: usize = 12_000;

/// The cache form of an extract answer given in a batch, naming the bounds it was given under: an answer from a
/// batch built with other bounds is not reused.
pub(super) const BATCH_FORM: &str = "batch8-6000-12000";

/// Items in order, cut into batches of at most [`crate::inference::BATCH`] items and [`BATCH_CHARS`] characters in
/// all (`size` of each item). An item over the bound on its own still gets a batch of its own.
fn batches<T>(items: &[T], size: impl Fn(&T) -> usize) -> Vec<&[T]> {
    let mut out = vec![];
    let (mut start, mut total) = (0, 0);
    for (i, item) in items.iter().enumerate() {
        let n = size(item);
        if i > start && (i - start == crate::inference::BATCH || total + n > BATCH_CHARS) {
            out.push(&items[start..i]);
            (start, total) = (i, 0);
        }
        total += n;
    }
    if start < items.len() {
        out.push(&items[start..]);
    }
    out
}

/// The JSON kind a step's answer must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind2 {
    Array,
    Object,
}

/// Central's `parseJson`: one code fence around the whole text dropped, then from the first `[` (or `{`) to the last
/// `]` (or `}`), parsed; nothing when that is not JSON. So `{"records": [...]}` and prose around an array read as the
/// array, as central reads them.
pub fn parse_json(text: &str, kind: Kind2) -> Option<Value> {
    static FENCE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let fence = FENCE.get_or_init(|| regex::Regex::new(r"^```(?:json)?\s*|\s*```$").unwrap());
    let t = fence.replace_all(text, "");
    let (open, close) = match kind {
        Kind2::Array => ('[', ']'),
        Kind2::Object => ('{', '}'),
    };
    let start = t.find(open)?;
    let end = t.rfind(close)?;
    if end < start {
        return None;
    }
    serde_json::from_str(&t[start..=end]).ok()
}

/// `localeCompare(…, { numeric: true })` on record keys: digit runs compare as numbers.
pub fn numeric_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(s: &str) -> Vec<(bool, &str)> {
        let mut out = vec![];
        let mut start = 0;
        let b = s.as_bytes();
        for i in 1..=b.len() {
            if i == b.len() || b[i].is_ascii_digit() != b[start].is_ascii_digit() {
                out.push((b[start].is_ascii_digit(), &s[start..i]));
                start = i;
            }
        }
        out
    }
    let (pa, pb) = (parts(a), parts(b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let o = match (x.0, y.0) {
            (true, true) => {
                x.1.parse::<u128>()
                    .unwrap_or(0)
                    .cmp(&y.1.parse::<u128>().unwrap_or(0))
            }
            _ => x.1.cmp(y.1),
        };
        if o.is_ne() {
            return o;
        }
    }
    pa.len().cmp(&pb.len())
}
