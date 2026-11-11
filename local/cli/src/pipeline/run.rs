//! One pass of the client's model steps over a stack: plan, extract, label, match, write the local store.

use super::extract::{Extractor, Incoming, Provenance, numeric_cmp};
use super::labels::{Chooser, STEP_JUDGE, STEP_LABELS, interpret, record_state};
use super::matching;
use super::results::{Results, model_key};
use super::store::{Amendment, Folded, Local, LocalStore, RecordProvenance, components};
use super::{Routes, plan};
use crate::inference::{Deferred, Inference, Kind};
use std::collections::BTreeSet;
use std::path::Path;

/// What a pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Summary {
    pub technologies: usize,
    pub created: usize,
    pub matched: usize,
    /// Records whose labels could not be read this pass (asked again after their retry date).
    pub unlabelled: usize,
    /// Provider calls made (cached answers are not calls).
    pub calls: usize,
    pub deferred: Option<Deferred>,
}

impl Summary {
    /// At most one line for the terminal; none when there was nothing to do.
    pub fn line(&self) -> Option<String> {
        if let Some(d) = &self.deferred {
            return Some(format!("Records from new releases: {}", d.line()));
        }
        (self.created + self.matched > 0).then(|| {
            format!(
                "Records from new releases: {} new, {} added to existing records, for {} technolog{} ({} model call{})",
                self.created,
                self.matched,
                self.technologies,
                if self.technologies == 1 { "y" } else { "ies" },
                self.calls,
                if self.calls == 1 { "" } else { "s" }
            )
        })
    }
}

fn provenance_of(inf: &Inference, version: u32, model_version: Option<String>) -> Provenance {
    Provenance {
        provider: inf.provider.name.clone(),
        model: model_key(&inf.provider),
        model_version,
        prompt_version: version,
    }
}

/// Runs the steps for these technologies, in demand order, until done or deferred. Each record is saved as it is
/// made; every model answer is in the result cache, so a deferred pass resumes where it stopped.
pub fn run(
    cache: &Path,
    routes: &Routes,
    techs: &BTreeSet<String>,
    purls: &BTreeSet<String>,
    today: &str,
) -> Summary {
    let results = Results::at(cache);
    let x = Extractor::new(&routes.main, &results);
    let classify = routes.labels.as_ref().unwrap_or(&routes.main);
    let ch = Chooser::new(classify, &results);
    // With an Anthropic key only, matching is off: every record is new.
    let matching_on = routes.labels.is_some() || routes.main.provider.kind != Kind::Anthropic;
    let p = crate::prompts::prompts();
    let questions = p.labels.questions();
    let mut s = Summary::default();
    let todo = plan(cache, techs, purls, today);
    let calls = |s: &mut Summary| s.calls = x.calls.get() + ch.calls.get();
    for t in &todo {
        let Ok(Some(td)) = crate::cache::load_catalog_tech(cache, &t.technology) else {
            continue;
        };
        let mut store = LocalStore::load(cache, &t.technology);
        let cover = super::store::Cover::new(&td, super::store::processed(cache, &t.technology));
        let name = t.events.first().map(|e| e.name.clone()).unwrap_or_default();
        // One technology at a time, most needed first: its records are written before the next one's extraction
        // starts. When extraction stops early, what it extracted is still labelled and written.
        let events: Vec<&unstale_schema::catalog::EventLine> = t.events.iter().collect();
        let mut stopped = x.prefetch(&events).err();
        let mut incoming: Vec<(Incoming, Option<Provenance>)> = vec![];
        // Events extracted whole, with the keys of their changes.
        let mut whole: Vec<(String, Vec<String>)> = vec![];
        for ev in &t.events {
            if stopped.is_some() {
                break;
            }
            match x.event(ev) {
                Ok(r) => {
                    if r.failed == 0 {
                        whole.push((
                            ev.id.clone(),
                            r.incoming.iter().map(|i| i.key.clone()).collect(),
                        ));
                    }
                    incoming.extend(r.incoming.into_iter().map(|i| (i, r.provenance.clone())))
                }
                Err(d) => stopped = Some(d),
            }
        }
        // Oldest first, as central ingests, so a later release's change finds the earlier record.
        incoming.sort_by(|a, b| {
            a.0.date
                .cmp(&b.0.date)
                .then_with(|| numeric_cmp(&a.0.version, &b.0.version))
                .then_with(|| numeric_cmp(&a.0.key, &b.0.key))
        });
        let fresh: Vec<&(Incoming, Option<Provenance>)> = incoming
            .iter()
            .filter(|(i, _)| !store.ingested.contains_key(&i.key))
            .collect();
        let states: Vec<_> = fresh
            .iter()
            .map(|(i, _)| record_state(p, &name, i))
            .collect();
        if let Err(d) = ch.prefetch(STEP_LABELS, &states, &questions) {
            s.deferred = Some(d);
        }
        let comps = components(&td);
        let line_of = matching::line_fn(&td.index);
        let mut touched = false;
        for ((inc, xprov), state) in fresh.iter().zip(&states) {
            if s.deferred.is_some() {
                break;
            }
            let answers = match ch.ask(STEP_LABELS, state, &questions) {
                Ok(a) => a,
                Err(d) => {
                    s.deferred = Some(d);
                    break;
                }
            };
            // No labels this pass: the record waits (its request is asked again after its retry date).
            let Some(labels) = answers.as_ref().and_then(|a| interpret(p, a)) else {
                s.unlabelled += 1;
                continue;
            };
            let extraction = xprov
                .clone()
                .unwrap_or_else(|| provenance_of(&routes.main, p.extract.version, None));
            let lab_prov = provenance_of(
                classify,
                p.labels.version,
                answers.as_ref().map(|a| a.model.clone()),
            );
            // The catalog's records with what this machine added, as candidates.
            let mut view = td.clone();
            super::store::overlay(&mut view, &store, &cover);
            let mut chosen = None;
            let mut judge_prov = None;
            if matching_on {
                let cands: Vec<matching::Cand> = view
                    .records
                    .iter()
                    .map(|r| matching::Cand {
                        rec: &r.r,
                        sources: store.records.get(&r.r.id).map(|l| l.sources.as_slice()),
                    })
                    .collect();
                let found = matching::retrieve(inc, &cands);
                let recs: Vec<&unstale_schema::catalog::CapabilityRecord> =
                    found.iter().map(|(c, _)| c.rec).collect();
                let scores: Vec<f64> = found.iter().map(|(_, sc)| *sc).collect();
                if !recs.is_empty() {
                    let (jstate, qs) = matching::match_request(
                        p,
                        &name,
                        inc,
                        labels.breaking,
                        &recs,
                        Some(&scores),
                    );
                    if !qs.is_empty() {
                        match ch.ask(STEP_JUDGE, &jstate, &qs) {
                            Ok(Some(a)) => {
                                judge_prov = Some(provenance_of(
                                    classify,
                                    p.judge.version,
                                    Some(a.model.clone()),
                                ));
                                chosen = matching::pick(p, inc, labels.breaking, &recs, &a).0;
                            }
                            // No readable verdict: the record is new.
                            Ok(None) => {}
                            Err(d) => {
                                s.deferred = Some(d);
                                break;
                            }
                        }
                    }
                }
                if chosen.is_none() {
                    let related: Vec<String> = recs
                        .iter()
                        .filter(|c| matching::finer_or_broader(inc, c))
                        .map(|c| c.id.clone())
                        .collect();
                    let taken = |id: &str| {
                        view.records.iter().any(|r| r.r.id == id)
                            || view.merged.contains_key(id)
                            || view.retracted.iter().any(|x| x == id)
                            || store.records.contains_key(id)
                    };
                    let mut r = matching::create(inc, &labels, &comps, &line_of, &taken);
                    r.related = {
                        let mut v = related;
                        v.sort();
                        v
                    };
                    let id = r.id.clone();
                    let provenance = RecordProvenance {
                        extraction,
                        labels: lab_prov,
                        judge: judge_prov,
                    };
                    store.records.insert(
                        id.clone(),
                        Local {
                            record: r,
                            sources: vec![inc.key.clone()],
                            version: inc.version.clone(),
                            provenance,
                            folded: vec![],
                        },
                    );
                    store.ingested.insert(inc.key.clone(), id);
                    s.created += 1;
                    touched = true;
                    store.save(cache);
                    continue;
                }
            }
            let provenance = RecordProvenance {
                extraction,
                labels: lab_prov,
                judge: judge_prov,
            };
            match chosen {
                Some((id, pr)) => {
                    if let Some(l) = store.records.get_mut(&id) {
                        matching::combine(&mut l.record, inc, &labels, &comps, &line_of);
                        l.sources.push(inc.key.clone());
                        l.folded.push(Folded {
                            incoming: (*inc).clone(),
                            labels: labels.clone(),
                            provenance,
                        });
                    } else {
                        store.amendments.push(Amendment {
                            into: id.clone(),
                            incoming: (*inc).clone(),
                            labels: labels.clone(),
                            p: pr,
                            provenance,
                        });
                    }
                    store.ingested.insert(inc.key.clone(), id);
                    s.matched += 1;
                }
                None => {
                    // Matching off: every record is new.
                    let taken = |id: &str| {
                        view.records.iter().any(|r| r.r.id == id)
                            || view.merged.contains_key(id)
                            || view.retracted.iter().any(|x| x == id)
                            || store.records.contains_key(id)
                    };
                    let r = matching::create(inc, &labels, &comps, &line_of, &taken);
                    let id = r.id.clone();
                    store.records.insert(
                        id.clone(),
                        Local {
                            record: r,
                            sources: vec![inc.key.clone()],
                            version: inc.version.clone(),
                            provenance,
                            folded: vec![],
                        },
                    );
                    store.ingested.insert(inc.key.clone(), id);
                    s.created += 1;
                }
            }
            touched = true;
            store.save(cache);
        }
        let before = store.done.len();
        for (id, keys) in whole {
            if keys.iter().all(|k| store.ingested.contains_key(k)) {
                store.done.insert(id);
            }
        }
        if touched || store.done.len() != before {
            store.save(cache);
        }
        if touched {
            s.technologies += 1;
        }
        if s.deferred.is_none() {
            s.deferred = stopped.take();
        }
        if s.deferred.is_some() {
            break;
        }
    }
    calls(&mut s);
    s
}
