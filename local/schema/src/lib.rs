//! Types shared across the schema seam. Rust is the source of truth: `gen-schema` writes the JSON Schema
//! in `schema/`, and the central pipeline's Zod is generated from that.

pub mod catalog;
pub mod ledger;

/// The generated JSON Schema documents, by file name under the repository's `schema/` directory.
pub fn schemas() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("catalog-shard-line.v1.json", serde_json::to_value(schemars::schema_for!(catalog::ShardLine)).unwrap()),
        ("catalog-tech-index.v1.json", serde_json::to_value(schemars::schema_for!(catalog::TechIndex)).unwrap()),
        ("catalog-root.v1.json", serde_json::to_value(schemars::schema_for!(catalog::Root)).unwrap()),
        ("catalog-technologies.v1.json", serde_json::to_value(schemars::schema_for!(catalog::Technologies)).unwrap()),
        ("ledger-header.v1.json", serde_json::to_value(schemars::schema_for!(ledger::Header)).unwrap()),
        ("ledger-entry.v1.json", serde_json::to_value(schemars::schema_for!(ledger::Entry)).unwrap()),
    ]
}
