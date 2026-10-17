//! Test helper: a catalog in the published format (gzipped JSON lines named by content hash, a per-technology
//! index, a root), written to a temporary directory. Shared by unit tests and the end-to-end test.
#![allow(dead_code)]

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;

pub struct FixtureCatalog {
    pub dir: tempfile::TempDir,
    loc: String,
}

impl Default for FixtureCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl FixtureCatalog {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let loc = dir.path().to_string_lossy().to_string();
        let c = FixtureCatalog { dir, loc };
        c.root(r#"{"schema":1,"min_client":"0.1.0"}"#);
        c
    }

    pub fn loc(&self) -> &str {
        &self.loc
    }

    pub fn root(&self, json: &str) {
        let p = self.dir.path().join("v1/root.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, json).unwrap();
    }

    /// Publish a technology: one shard per (line, lines). Returns the shard paths. `sample_n` is 0.
    pub fn tech(&self, tech: &str, shards: &[(&str, Vec<Value>)]) -> Vec<PathBuf> {
        self.tech_n(tech, 0, shards)
    }

    pub fn tech_n(&self, tech: &str, sample_n: u32, shards: &[(&str, Vec<Value>)]) -> Vec<PathBuf> {
        let mut refs = vec![];
        let mut paths = vec![];
        for (line, lines) in shards {
            let mut text = String::new();
            for l in lines {
                text.push_str(&serde_json::to_string(l).unwrap());
                text.push('\n');
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(text.as_bytes()).unwrap();
            let bytes = gz.finish().unwrap();
            let sha = {
                use sha2::{Digest, Sha256};
                Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()
            };
            let rel = format!("v1/shards/{tech}/{line}.{}.jsonl.gz", &sha[..12]);
            let p = self.dir.path().join(&rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, &bytes).unwrap();
            refs.push(json!({"line": line, "path": rel, "sha256": sha, "bytes": bytes.len(), "records": lines.len()}));
            paths.push(p);
        }
        let idx = json!({"schema": 1, "technology": tech, "sample_n": sample_n, "checked": "2026-10-15T00:00:00Z", "shards": refs});
        let p = self.dir.path().join(format!("v1/tech/{tech}.json"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, serde_json::to_string(&idx).unwrap()).unwrap();
        paths
    }
}

/// A minimal valid active record: a non-breaking `new_api` with a `performance` benefit, one release.
pub fn rec(id: &str, component: &str, version: &str) -> Value {
    let tech = id.split(':').next().unwrap();
    let line = version.split('.').next().unwrap();
    json!({
        "status": "active", "id": id, "technology": tech, "revision": 1, "label_version": 1,
        "change_type": "new_api", "breaking": false, "surface": "code_api",
        "subject": id, "subject_kind": "literal", "summary": format!("Summary of {id}."),
        "benefit": ["performance"],
        "releases": [{"component": component, "version": version, "date": "2026-01-01", "line": line}],
        "prerequisites": [], "conditions": [], "requires": [], "introduces": [], "terms": [], "replaces": [],
        "evidence": [{"kind": "release_notes", "url": format!("https://example.org/{id}"), "quote": "q", "snapshot": "sha256:00"}],
        "related": []
    })
}

/// Overlay fields on a record.
pub fn with(mut v: Value, over: Value) -> Value {
    if let (Some(o), Some(m)) = (v.as_object_mut(), over.as_object()) {
        for (k, x) in m {
            o.insert(k.clone(), x.clone());
        }
    }
    v
}

pub fn merged(id: &str, into: &str) -> Value {
    json!({"status": "merged", "id": id, "merged_into": into})
}

pub fn retracted(id: &str) -> Value {
    json!({"status": "retracted", "id": id})
}
