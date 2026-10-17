//! Writes the JSON Schema files. `--check` fails if the committed files differ (CI drift check).
use std::{fs, path::PathBuf};

fn main() {
    let check = std::env::args().any(|a| a == "--check");
    // `UNSTALE_SCHEMA_DIR` points it at another directory (the drift test runs it on a temp copy).
    let dir = std::env::var_os("UNSTALE_SCHEMA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema"));
    let mut drift = vec![];
    for (name, schema) in unstale_schema::schemas() {
        let text = serde_json::to_string_pretty(&schema).unwrap() + "\n";
        let path = dir.join(name);
        if check {
            if fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
                drift.push(name);
            }
        } else {
            fs::write(&path, text).unwrap();
        }
    }
    if !drift.is_empty() {
        eprintln!("schema drift, regenerate with `cargo run --bin gen-schema`: {drift:?}");
        std::process::exit(1);
    }
}
