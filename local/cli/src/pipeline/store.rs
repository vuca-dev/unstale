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
    /// Absent when matching was off (every record new).
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

fn borderline(r: &CapabilityRecord) -> Vec<String> {
    r.classifier
        .as_ref()
        .map(|c| c.borderline.clone())
        .unwrap_or_default()
}

/// The catalog's records with the client's merged in: amendments applied to the catalog records they name, client
/// records added, each marked with its provenance; nothing for a release the catalog covers.
pub fn overlay(td: &mut TechData, local: &LocalStore) {
    let done = covered(td);
    let comps = components(td);
    let index = td.index.clone();
    let line_of = matching::line_fn(&index);
    for a in &local.amendments {
        if done.contains(&a.incoming.version) {
            continue;
        }
        let into = td
            .merged
            .get(&a.into)
            .cloned()
            .unwrap_or_else(|| a.into.clone());
        if let Some(rec) = td.records.iter_mut().find(|r| r.r.id == into) {
            matching::combine(&mut rec.r, &a.incoming, &a.labels, &comps, &line_of);
            td.provenance.insert(into, a.provenance.clone());
        }
    }
    for (id, l) in &local.records {
        let taken = td.records.iter().any(|r| r.r.id == *id)
            || td.merged.contains_key(id)
            || td.retracted.contains(id);
        if taken || done.contains(&l.version) {
            continue;
        }
        td.records.push(Rec {
            r: l.record.clone(),
            borderline: borderline(&l.record),
        });
        td.provenance.insert(id.clone(), l.provenance.clone());
    }
    td.records.sort_by(|a, b| a.r.id.cmp(&b.r.id));
}
