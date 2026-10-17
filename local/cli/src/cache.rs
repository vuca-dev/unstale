//! The per-user catalog cache, shared across repositories, and reading it.
//!
//! Layout under the cache directory, mirroring the published catalog:
//! `v1/root.json`, `v1/tech/{technology}.json` (the index bytes as published), `v1/shards/{technology}/{file}`.
//! An index is written only after every shard it names is present and verified, so the index rename is the swap.

use anyhow::{Context, Result, bail};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use unstale_schema::catalog::{CATALOG_SCHEMA, CapabilityRecord, ShardLine, ShardRef, TechIndex};

use crate::util::sha256_hex;

pub fn cache_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("UNSTALE_CACHE_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "macos") {
        home.join("Library/Caches/unstale")
    } else if let Some(x) = std::env::var_os("XDG_CACHE_HOME") {
        PathBuf::from(x).join("unstale")
    } else {
        home.join(".cache/unstale")
    }
}

pub fn index_path(cache: &Path, tech: &str) -> PathBuf {
    cache.join("v1/tech").join(format!("{tech}.json"))
}

pub fn shard_path(cache: &Path, tech: &str, r: &ShardRef) -> PathBuf {
    cache.join("v1/shards").join(tech).join(shard_file_name(&r.path))
}

pub fn shard_file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// `sha256:abc…` or `abc…`, lowercased.
pub fn bare_sha(s: &str) -> String {
    s.trim().trim_start_matches("sha256:").to_ascii_lowercase()
}

/// Check a shard's bytes against its reference: byte size and sha256.
pub fn verify_shard(r: &ShardRef, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != r.bytes {
        bail!("shard {}: {} bytes, the index says {}", r.path, bytes.len(), r.bytes);
    }
    let got = sha256_hex(bytes);
    if got != bare_sha(&r.sha256) {
        bail!("shard {}: sha256 {} does not match the index ({})", r.path, got, bare_sha(&r.sha256));
    }
    Ok(())
}

/// A live record with the classifier's borderline labels, read from the raw line so this crate does not depend on the
/// optional `classifier` field being in the schema yet (borderline calls are flagged, never dropped).
#[derive(Debug, Clone)]
pub struct Rec {
    pub r: CapabilityRecord,
    pub borderline: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Active(u32),
    Merged(String),
    Retracted,
    Missing,
}

#[derive(Debug, Clone)]
pub struct TechData {
    pub index: TechIndex,
    /// sha256 of the index bytes, named in the skill file header.
    pub index_sha: String,
    pub records: Vec<Rec>,
    pub merged: BTreeMap<String, String>,
    pub retracted: Vec<String>,
    /// Lines skipped: unknown status or a record that does not parse.
    pub skipped: usize,
}

/// A parsed shard: active records, merged ids (id to target), retracted ids, and lines skipped.
pub type Shard = (Vec<Rec>, BTreeMap<String, String>, Vec<String>, usize);

/// Parse a gzipped JSON-lines shard.
/// A record id is printed in skill files and typed back as a command argument (`unstale record <id> …`), so a line
/// whose id could carry anything else (spaces, backticks, brackets, line breaks) is skipped like an unreadable one.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:~@+".contains(&b))
}

pub fn parse_shard(gz: &[u8]) -> Result<Shard> {
    let mut text = String::new();
    flate2::read::GzDecoder::new(gz).read_to_string(&mut text).context("shard is not gzipped UTF-8 text")?;
    let (mut recs, mut merged, mut retracted, mut skipped) = (vec![], BTreeMap::new(), vec![], 0);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            skipped += 1;
            continue;
        };
        let borderline: Vec<String> = v
            .pointer("/classifier/borderline")
            .and_then(|b| b.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        match serde_json::from_value::<ShardLine>(v) {
            Ok(ShardLine::Active(r)) if safe_id(&r.id) => recs.push(Rec { r, borderline }),
            Ok(ShardLine::Merged { id, merged_into }) if safe_id(&id) && safe_id(&merged_into) => {
                merged.insert(id, merged_into);
            }
            Ok(ShardLine::Retracted { id }) if safe_id(&id) => retracted.push(id),
            _ => skipped += 1,
        }
    }
    Ok((recs, merged, retracted, skipped))
}

/// Load one technology from the cache, verifying every shard. `Ok(None)` when it was never synced.
pub fn load_tech(cache: &Path, tech: &str) -> Result<Option<TechData>> {
    let ip = index_path(cache, tech);
    let Ok(bytes) = std::fs::read(&ip) else { return Ok(None) };
    let index: TechIndex = serde_json::from_slice(&bytes).with_context(|| format!("cached index {}", ip.display()))?;
    if index.schema > CATALOG_SCHEMA {
        bail!("cached index for {tech} has schema {}; this unstale reads {CATALOG_SCHEMA}", index.schema);
    }
    let mut td = TechData {
        index_sha: sha256_hex(&bytes),
        index,
        records: vec![],
        merged: BTreeMap::new(),
        retracted: vec![],
        skipped: 0,
    };
    for s in td.index.shards.clone() {
        let p = shard_path(cache, tech, &s);
        let gz = std::fs::read(&p).with_context(|| format!("cached shard {} missing; run `unstale sync`", p.display()))?;
        verify_shard(&s, &gz).context("cached shard corrupted; run `unstale sync`")?;
        let (recs, merged, retracted, skipped) = parse_shard(&gz)?;
        td.records.extend(recs);
        td.merged.extend(merged);
        td.retracted.extend(retracted);
        td.skipped += skipped;
    }
    td.records.sort_by(|a, b| a.r.id.cmp(&b.r.id));
    td.records.dedup_by(|a, b| a.r.id == b.r.id);
    Ok(Some(td))
}

/// The loaded catalog for a stack: technologies by id, and a lookup across all of them (a merge target may sit
/// in another technology's shards).
#[derive(Debug, Default, Clone)]
pub struct Catalog {
    pub techs: BTreeMap<String, TechData>,
}

impl Catalog {
    pub fn lookup(&self, id: &str) -> Lookup {
        for t in self.techs.values() {
            if let Some(r) = t.records.iter().find(|r| r.r.id == id) {
                return Lookup::Active(r.r.revision);
            }
            if let Some(m) = t.merged.get(id) {
                return Lookup::Merged(m.clone());
            }
            if t.retracted.iter().any(|x| x == id) {
                return Lookup::Retracted;
            }
        }
        Lookup::Missing
    }


    /// `next sha256:…` per technology, sorted: the snapshot a skill file was built from.
    pub fn snapshot_line(&self) -> String {
        if self.techs.is_empty() {
            return "none".into();
        }
        self.techs.iter().map(|(t, d)| format!("{t} sha256:{}", d.index_sha)).collect::<Vec<_>>().join(", ")
    }
}
