//! The user-level result cache: every model answer the client paid for, shared by every repository on the machine.
//!
//! An entry is keyed by the step, the model (route prefix dropped, so `openai/gpt-6-luna` through a gateway and
//! `gpt-6-luna` direct or through Codex share answers) and its effort, the step's prompt-file version, the hash of the
//! chunk the answer is about, and the hash of the full prompt. It is written as soon as the call returns, so an
//! interrupted run resumes without paying twice, and a second repository with the same technologies asks nothing.
//! Truncated and unreadable answers are kept too (they cost tokens): the same request would fail the same way.
//!
//! Layout: `{cache}/inference/results/{key[..2]}/{key}.json`, beside the ledger and the worker lock, which cache
//! clean-up keeps.

use crate::inference::ProviderConfig;
use crate::util::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// What a call came to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum Outcome {
    /// The parsed answer.
    Answer { answer: Value },
    /// The answer ran out of room (the step splits its input instead).
    Truncated,
    /// No readable answer after the step's attempts.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub step: String,
    /// The model as the key names it.
    pub model: String,
    pub prompt_version: u32,
    /// sha256 of the chunk (or piece) text the answer is about.
    pub chunk: String,
    /// The provider that answered, as the ledger names it.
    pub provider: String,
    /// The model the provider reported, when it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_version: Option<String>,
    #[serde(flatten)]
    pub outcome: Outcome,
}

/// The model part of a key: the provider's model id without a route prefix, and the effort.
pub fn model_key(p: &ProviderConfig) -> String {
    let m = p.model.rsplit('/').next().unwrap_or(&p.model);
    match &p.effort {
        Some(e) => format!("{m}@{e}"),
        None => m.to_string(),
    }
}

pub struct Results {
    dir: PathBuf,
}

impl Results {
    pub fn new(dir: PathBuf) -> Results {
        Results { dir }
    }

    /// `{cache}/inference/results`.
    pub fn at(cache: &Path) -> Results {
        Results::new(cache.join("inference").join("results"))
    }

    pub fn key(step: &str, model: &str, prompt_version: u32, chunk: &str, prompt: &str) -> String {
        sha256_hex(
            format!(
                "{step}\n{model}\n{prompt_version}\n{chunk}\n{}",
                sha256_hex(prompt.as_bytes())
            )
            .as_bytes(),
        )
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(&key[..2]).join(format!("{key}.json"))
    }

    /// A stored entry; an unreadable file reads as absent (the call is made again).
    pub fn get(&self, key: &str) -> Option<Entry> {
        serde_json::from_slice(&std::fs::read(self.path(key)).ok()?).ok()
    }

    /// Stores an entry at once. A write that fails is not an error for the step: the answer is still used, and a later
    /// run would ask again.
    pub fn put(&self, key: &str, e: &Entry) -> bool {
        let Ok(bytes) = serde_json::to_vec(e) else {
            return false;
        };
        crate::util::write_atomic(&self.path(key), &bytes).is_ok()
    }
}
