//! The client's own records, shared by every repository on the machine: `{cache}/inference/records/{technology}.json`,
//! beside the result cache. Records the client made, the extraction keys already taken, and the records of the catalog
//! a new release's change was matched into (kept as the change to apply, so the catalog's copy stays the base).
//!
//! The report reads them through [`crate::cache::load_tech`], merged into the catalog's records in the same schema
//! ([`overlay`]), with the switch on only. Catalog records win: anything the client made for a release the catalog now
//! has records for is left out, and a client record never takes the id of a catalog one.

use super::extract::{Incoming, Provenance};
use super::labels::Labels;
use super::matching;
use crate::cache::{Rec, TechData};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use unstale_schema::catalog::CapabilityRecord;

/// Who made a record: the extraction route, and the labelling and matching routes, with the prompt versions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordProvenance {
    pub extraction: Provenance,
    pub labels: Provenance,
    /// Who said same-or-new: a judge, or the rule (`matching::RULE_PROVIDER`). Absent when nothing was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge: Option<Provenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Local {
    pub record: CapabilityRecord,
    /// The extraction keys folded into it.
    pub sources: Vec<String>,
    /// The release its first source came from.
    pub version: String,
    pub provenance: RecordProvenance,
    /// The changes matched into it after its first, kept whole: when the catalog comes to cover the first, they make a
    /// record of their own instead of leaving with it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folded: Vec<Folded>,
}

/// A change matched into a record this machine made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Folded {
    pub incoming: Incoming,
    pub labels: Labels,
    pub provenance: RecordProvenance,
}

/// A change of a new release matched into a catalog record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Amendment {
    pub into: String,
    pub incoming: Incoming,
    pub labels: Labels,
    pub p: f64,
    pub provenance: RecordProvenance,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LocalStore {
    pub technology: String,
    pub records: BTreeMap<String, Local>,
    /// Extraction key → the record it went into (`""`: no labels could be read; not asked again).
    pub ingested: BTreeMap<String, String>,
    pub amendments: Vec<Amendment>,
    /// Change events whose every change this machine has taken in (extracted, labelled, matched): nothing left to pay
    /// for them here. Each pass still reads them from the result cache, as the catalog decides what is covered.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub done: BTreeSet<String>,
}

pub fn path(cache: &Path, tech: &str) -> PathBuf {
    cache
        .join("inference")
        .join("records")
        .join(format!("{tech}.json"))
}

impl LocalStore {
    /// The store, or an empty one (a file that cannot be read starts over: its results are still in the result cache).
    pub fn load(cache: &Path, tech: &str) -> LocalStore {
        std::fs::read(path(cache, tech))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| LocalStore {
                technology: tech.into(),
                ..Default::default()
            })
    }

    pub fn save(&self, cache: &Path) -> bool {
        serde_json::to_vec(self)
            .is_ok_and(|b| crate::util::write_atomic(&path(cache, &self.technology), &b).is_ok())
    }
}

/// The technology's components: the index's, else every package its records name.
pub fn components(td: &TechData) -> Vec<String> {
    if !td.index.components.is_empty() {
        return td.index.components.clone();
    }
    let mut out: Vec<String> = vec![];
    for r in &td.records {
        for x in &r.r.releases {
            if !out.contains(&x.component) {
                out.push(x.component.clone());
            }
        }
    }
    out
}

/// The versions the catalog's records name.
pub fn covered(td: &TechData) -> BTreeSet<String> {
    td.records
        .iter()
        .flat_map(|r| r.r.releases.iter().map(|x| x.version.clone()))
        .collect()
}

/// What the catalog covers: a release its records name, or a change event central processed (`extracted`).
pub struct Cover {
    versions: BTreeSet<String>,
    events: BTreeSet<String>,
}

impl Cover {
    pub fn new(td: &TechData, processed: BTreeSet<String>) -> Cover {
        Cover {
            versions: covered(td),
            events: processed,
        }
    }

    /// Whether the catalog covers this change: its release, or the event its key names (`{event id}#{chunk}.{n}`).
    pub fn has(&self, inc: &Incoming) -> bool {
        self.versions.contains(&inc.version) || self.events.contains(event_of(&inc.key))
    }
}

/// The change event an extraction key came from.
pub fn event_of(key: &str) -> &str {
    key.split('#').next().unwrap_or(key)
}

/// The ids of a technology's change events central processed (none when its events cannot be read).
pub fn processed(cache: &Path, tech: &str) -> BTreeSet<String> {
    crate::cache::load_events(cache, tech)
        .ok()
        .flatten()
        .map(|e| {
            e.events
                .into_iter()
                .filter(|e| e.extracted)
                .map(|e| e.id)
                .collect()
        })
        .unwrap_or_default()
}

fn borderline(r: &CapabilityRecord) -> Vec<String> {
    r.classifier
        .as_ref()
        .map(|c| c.borderline.clone())
        .unwrap_or_default()
}

/// A change with nowhere to go: the rest of a record the catalog now covers, or a change matched into a catalog record
/// that has since been retracted. It becomes a record of its own.
struct Loose<'a> {
    incoming: &'a Incoming,
    labels: &'a Labels,
    provenance: &'a RecordProvenance,
}

/// The catalog's records with the client's merged in: client records added, amendments applied to the catalog records
/// they name, each marked with its provenance; nothing for a change the catalog covers (its release named by a catalog
/// record, or its event processed by central). No paid change leaves without cause: when the catalog covers a client
/// record's first change, the changes matched into it later make a record of their own, and so does a change matched
/// into a catalog record that was since retracted.
pub fn overlay(td: &mut TechData, local: &LocalStore, cover: &Cover) {
    let comps = components(td);
    let index = td.index.clone();
    let line_of = matching::line_fn(&index);
    // Every id in use: a record made here never takes one of them.
    let mut taken: BTreeSet<String> = td
        .records
        .iter()
        .map(|r| r.r.id.clone())
        .chain(td.merged.keys().cloned())
        .chain(td.retracted.iter().cloned())
        .collect();
    let catalog = taken.clone();
    taken.extend(local.records.keys().cloned());
    let mut hidden: Vec<Vec<Loose>> = vec![];
    for (id, l) in &local.records {
        let first_covered = cover.versions.contains(&l.version)
            || l.sources
                .first()
                .is_some_and(|k| cover.events.contains(event_of(k)));
        if !first_covered {
            // Its id since taken by a catalog record (a different change, the catalog not covering this one): kept
            // under an id of its own, the same on every load.
            let mut r = l.record.clone();
            if catalog.contains(id) {
                r.id = stable_id(id, l.sources.first().map_or(id.as_str(), String::as_str));
            }
            td.provenance.insert(r.id.clone(), l.provenance.clone());
            td.records.push(Rec {
                borderline: borderline(&r),
                r,
            });
            continue;
        }
        // Hidden: what the catalog does not cover of it stays, as a record of its own.
        let rest: Vec<Loose> = l
            .folded
            .iter()
            .filter(|f| !cover.has(&f.incoming))
            .map(|f| Loose {
                incoming: &f.incoming,
                labels: &f.labels,
                provenance: &f.provenance,
            })
            .collect();
        if !rest.is_empty() {
            hidden.push(rest);
        }
    }
    let mut make = |td: &mut TechData, group: Vec<Loose>| {
        let first = &group[0];
        // Made on each load: an id from its first change's key, so it is the same every time, whatever else is taken.
        let mut r = matching::create(first.incoming, first.labels, &comps, &line_of, &|_| false);
        r.id = stable_id(&r.id, &first.incoming.key);
        for more in &group[1..] {
            matching::combine(&mut r, more.incoming, more.labels, &comps, &line_of);
        }
        taken.insert(r.id.clone());
        td.provenance.insert(r.id.clone(), first.provenance.clone());
        td.records.push(Rec {
            borderline: borderline(&r),
            r,
        });
    };
    for group in hidden {
        make(td, group);
    }
    // Amendments, onto the record their target now is (a merge followed to its end); a target that is gone takes them
    // as a record of their own, one per target.
    let mut orphans: BTreeMap<String, Vec<Loose>> = BTreeMap::new();
    for a in &local.amendments {
        if cover.has(&a.incoming) {
            continue;
        }
        let mut into = a.into.clone();
        for _ in 0..16 {
            match td.merged.get(&into) {
                Some(next) if *next != into => into = next.clone(),
                _ => break,
            }
        }
        if let Some(rec) = td.records.iter_mut().find(|r| r.r.id == into) {
            matching::combine(&mut rec.r, &a.incoming, &a.labels, &comps, &line_of);
            td.provenance.insert(into, a.provenance.clone());
        } else {
            orphans.entry(a.into.clone()).or_default().push(Loose {
                incoming: &a.incoming,
                labels: &a.labels,
                provenance: &a.provenance,
            });
        }
    }
    for group in orphans.into_values() {
        make(td, group);
    }
    td.records.sort_by(|a, b| a.r.id.cmp(&b.r.id));
}

/// `{id}~{8 hex of the key}`: an id for a record the overlay makes, stable across loads.
fn stable_id(id: &str, key: &str) -> String {
    format!("{id}~{}", &crate::util::sha256_hex(key.as_bytes())[..8])
}
