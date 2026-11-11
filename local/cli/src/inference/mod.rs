//! The provider layer for model steps run on the user's own key or Codex plan: send a prompt, get a parsed answer and
//! metered usage, or a typed deferral. No pipeline logic lives here.
//!
//! - [`Inference::complete`] asks for one JSON answer (OpenAI-compatible chat, Anthropic Messages, Codex).
//! - [`Inference::complete_batch`] asks for up to [`BATCH`] items in one call, answered by item id.
//! - [`Inference::classify`] asks closed-choice questions about a state (the Jev decision API).
//!
//! Every outcome that is not an answer is a [`Deferred`]: the work waits for a later run, never fails. Each call's
//! usage goes to the local [`ledger`], and the monthly token budget ([`ledger::DEFAULT_MONTHLY_TOKENS`]) is checked
//! before every call. The key is read from its environment variable when the request is built and goes only into
//! that request's auth header.
//!
//! Nothing in the client calls this yet; the pipeline steps that will are built on it.
#![allow(dead_code)]

mod codex;
mod http;
/// The bytes of one Jev request (tests compare them with central's).
#[cfg(test)]
pub(crate) use http::jev_request_body;
pub mod ledger;
pub mod lock;
#[cfg(test)]
mod tests;

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

pub use ledger::{Ledger, Usage};

/// Items per call where a step can ask about several at once (records to label, chunks to extract).
pub const BATCH: usize = 8;

/// Whether the client runs model steps itself. Off by default: with it off the client makes no model calls.
pub fn enabled() -> bool {
    // The one reader of the switch, shared with sync's change events.
    crate::util::edge_inference()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `POST {base}/chat/completions` with a JSON-schema `response_format`.
    OpenAiCompatible,
    /// `POST {base}/v1/messages` with `output_config.format`.
    Anthropic,
    /// `POST {base}/v1/systemone`: closed-choice questions about a state.
    Jev,
    /// `codex exec` on the user's Codex login.
    Codex,
}

/// Which provider to call and how. The key itself is never held here, only the name of the variable it is read from.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub kind: Kind,
    /// The provider's name in the usage ledger (`openai`, `vercel`, `openrouter`, `anthropic`, `jev`, `codex`, or the
    /// name a custom route was given).
    pub name: String,
    /// API root for HTTP providers; for Codex, the program to run (`codex`, looked up on PATH).
    pub base_url: String,
    pub model: String,
    /// The environment variable holding the key (HTTP providers only).
    pub key_env: Option<String>,
    /// Reasoning effort (`low`, `none`, ...); `None` leaves the provider's default.
    pub effort: Option<String>,
    /// Extra top-level request fields (OpenAI-compatible only), such as a gateway's service tier.
    pub extra: Map<String, Value>,
}

impl ProviderConfig {
    fn http(kind: Kind, name: &str, base: &str, model: &str, key_env: &str) -> ProviderConfig {
        ProviderConfig {
            kind,
            name: name.into(),
            base_url: base.into(),
            model: model.into(),
            key_env: Some(key_env.into()),
            effort: None,
            extra: Map::new(),
        }
    }

    pub fn openai() -> ProviderConfig {
        let mut c = Self::http(
            Kind::OpenAiCompatible,
            "openai",
            "https://api.openai.com/v1",
            "gpt-6-luna",
            "OPENAI_API_KEY",
        );
        c.effort = Some("low".into());
        c
    }

    /// Vercel AI Gateway, on its flex tier (the same model at a lower price, slower).
    pub fn vercel() -> ProviderConfig {
        let mut c = Self::http(
            Kind::OpenAiCompatible,
            "vercel",
            "https://ai-gateway.vercel.sh/v1",
            "openai/gpt-6-luna",
            "AI_GATEWAY_API_KEY",
        );
        c.effort = Some("low".into());
        c.extra.insert(
            "providerOptions".into(),
            json!({"gateway": {"serviceTier": "flex"}}),
        );
        c
    }

    pub fn openrouter() -> ProviderConfig {
        let mut c = Self::http(
            Kind::OpenAiCompatible,
            "openrouter",
            "https://openrouter.ai/api/v1",
            "openai/gpt-6-luna",
            "OPENROUTER_API_KEY",
        );
        c.effort = Some("low".into());
        c
    }

    /// Any other OpenAI-compatible route.
    pub fn custom(name: &str, base_url: &str, model: &str, key_env: &str) -> ProviderConfig {
        Self::http(Kind::OpenAiCompatible, name, base_url, model, key_env)
    }

    /// Claude Haiku 5.5 with thinking off, for a user with only an Anthropic key.
    pub fn anthropic() -> ProviderConfig {
        let mut c = Self::http(
            Kind::Anthropic,
            "anthropic",
            "https://api.anthropic.com",
            "claude-haiku-5-5",
            "ANTHROPIC_API_KEY",
        );
        c.effort = Some("none".into());
        c
    }

    pub fn jev() -> ProviderConfig {
        Self::http(
            Kind::Jev,
            "jev",
            "https://api.typesafe.ai",
            "jev-latest",
            "JEV_API_KEY",
        )
    }

    pub fn codex() -> ProviderConfig {
        ProviderConfig {
            kind: Kind::Codex,
            name: "codex".into(),
            base_url: "codex".into(),
            model: "gpt-6-luna".into(),
            key_env: None,
            effort: Some("low".into()),
            extra: Map::new(),
        }
    }
}

/// Why work was deferred. Each maps to one plain line for the user ([`Deferred::line`]); none is an error exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Deferred {
    /// This month's token budget is spent.
    Budget,
    /// The key's environment variable is unset or empty.
    NoKey(String),
    /// 401 or 403: the key was refused.
    Auth,
    /// 402: the account has no credit.
    Billing,
    /// 429 after the retries.
    RateLimited,
    /// 5xx or no connection, after the retries.
    Unavailable,
    /// No answer in time, after the retries.
    Timeout,
    /// The model is not served to this key or plan (404, or Codex's "not supported").
    ModelNotOnPlan(String),
    /// Another 4xx: the provider would not take the request.
    Rejected,
    /// The answer did not fit its token limit; the caller asks again with less.
    TooLong,
    /// The answer could not be read as the expected JSON, or the provider declined to answer.
    Malformed,
    /// The usage ledger or worker lock beside the cache cannot be read or written, so spend cannot be counted.
    Storage,
    /// The provider answered with a redirect, which is never followed (the key would go to another address).
    Redirected,
    /// The provider address is not https (plain http is allowed only on this machine).
    InsecureUrl,
    /// More items than [`BATCH`] in one batch.
    BatchTooLarge,
    /// Codex is not on PATH.
    CodexMissing,
    /// Codex is older than [`codex::MIN_VERSION`].
    CodexTooOld,
    /// `codex login status` says not logged in, or a call was refused for auth.
    CodexLoggedOut,
}

impl Deferred {
    /// One line for the terminal: what happened and, where the user can act, what to do.
    pub fn line(&self) -> String {
        let why = match self {
            Deferred::Budget => {
                "this month's token budget is used up; the rest runs next month".into()
            }
            Deferred::NoKey(var) => format!("{var} is not set"),
            Deferred::Auth => "the provider did not accept the key".into(),
            Deferred::Billing => "the provider account has no credit left".into(),
            Deferred::RateLimited => "the provider is rate limiting; it runs next time".into(),
            Deferred::Unavailable => "the provider is not answering; it runs next time".into(),
            Deferred::Timeout => "the provider took too long; it runs next time".into(),
            Deferred::ModelNotOnPlan(m) => format!("{m} is not available on this key or plan"),
            Deferred::Rejected => "the provider refused the request".into(),
            Deferred::TooLong => "the answer was too long; it runs in smaller pieces".into(),
            Deferred::Malformed => {
                "the provider's answer could not be read; it runs next time".into()
            }
            Deferred::Storage => "unstale's usage record cannot be read or written".into(),
            Deferred::Redirected => "the provider address redirects elsewhere; check it".into(),
            Deferred::InsecureUrl => "the provider address must start with https://".into(),
            Deferred::BatchTooLarge => format!("more than {BATCH} items in one request"),
            Deferred::CodexMissing => "Codex is not installed".into(),
            Deferred::CodexTooOld => {
                format!("Codex is older than {}; update it", codex::MIN_VERSION)
            }
            Deferred::CodexLoggedOut => "Codex is not logged in; run `codex login`".into(),
        };
        format!("deferred: {why}")
    }

    /// Worth retrying within the same call (with backoff).
    fn transient(&self) -> bool {
        matches!(
            self,
            Deferred::RateLimited | Deferred::Unavailable | Deferred::Timeout
        )
    }
}

impl std::fmt::Display for Deferred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.line())
    }
}

/// One request for a JSON answer.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
    /// JSON Schema the answer must follow (every object closed with `additionalProperties: false`). Without one the
    /// first JSON object or array in the answer is taken.
    pub schema: Option<Value>,
    pub max_tokens: u32,
}

impl Prompt {
    pub fn new(text: impl Into<String>) -> Prompt {
        Prompt {
            text: text.into(),
            schema: None,
            max_tokens: 16_000,
        }
    }
    pub fn schema(mut self, schema: Value) -> Prompt {
        self.schema = Some(schema);
        self
    }
}

#[derive(Debug, Clone)]
pub struct Answer {
    pub value: Value,
    /// The model that answered, as the provider reported it.
    pub model: String,
    pub usage: Usage,
}

/// Up to [`BATCH`] items asked about in one call, each answered under its id.
#[derive(Debug, Clone)]
pub struct Batch {
    /// What to do with each item.
    pub instructions: String,
    /// `(id, item)`; ids are unique.
    pub items: Vec<(String, Value)>,
    /// The schema of one item's answer.
    pub answer_schema: Value,
    pub max_tokens: u32,
}

/// A batch's answers by item id. An item the model skipped is absent; the caller asks for it again.
#[derive(Debug, Clone)]
pub struct BatchAnswer {
    pub answers: BTreeMap<String, Value>,
    pub model: String,
    pub usage: Usage,
}

/// A closed-choice question: option → description, sent in the order given (the order can move an answer).
#[derive(Debug, Clone)]
pub struct ChoiceQuestion {
    pub instructions: String,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Choice {
    pub choice: String,
    pub confidence: f64,
    pub probabilities: BTreeMap<String, f64>,
}

#[derive(Debug, Clone)]
pub struct Classification {
    pub model: String,
    /// Answers by question id. When a later request was deferred, the questions it carried are absent and
    /// `deferred` says why; the answers already paid for are kept.
    pub answers: BTreeMap<String, Choice>,
    pub usage: Usage,
    pub deferred: Option<Deferred>,
}

/// Timeouts and retries for one provider call. Only transient failures (429, 5xx, timeouts, no connection) retry.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub timeout: Duration,
    pub retries: u32,
    /// The first retry's delay; it doubles each time. A `Retry-After` the provider names is used instead (at most a
    /// minute).
    pub backoff: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            timeout: Duration::from_secs(300),
            retries: 3,
            backoff: Duration::from_secs(2),
        }
    }
}

type EnvFn = dyn Fn(&str) -> Option<String> + Send + Sync;

/// A configured provider with its ledger and budget. Construct one per run; it is cheap.
pub struct Inference {
    pub provider: ProviderConfig,
    pub ledger: Ledger,
    /// Tokens per calendar month (UTC) across every provider.
    pub monthly_budget: u64,
    pub limits: Limits,
    env: Box<EnvFn>,
    codex_ready: std::sync::OnceLock<Result<(), Deferred>>,
    /// Set when a call's usage could not be recorded: no further call runs in this process.
    pub(crate) ledger_failed: std::sync::atomic::AtomicBool,
}

impl Inference {
    pub fn new(provider: ProviderConfig) -> Inference {
        Inference {
            provider,
            ledger: Ledger::default_location(),
            monthly_budget: ledger::DEFAULT_MONTHLY_TOKENS,
            limits: Limits::default(),
            env: Box::new(|k| std::env::var(k).ok()),
            codex_ready: std::sync::OnceLock::new(),
            ledger_failed: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Where keys and Codex's environment are read from (tests).
    #[cfg(test)]
    pub fn with_env(
        mut self,
        env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        self.env = Box::new(env);
        self
    }

    /// One prompt, one parsed JSON answer.
    pub fn complete(&self, p: &Prompt) -> Result<Answer, Deferred> {
        self.admit()?;
        // Each adapter records the call's usage, answer or not: the tokens were spent either way.
        match self.provider.kind {
            Kind::OpenAiCompatible => http::openai(self, p),
            Kind::Anthropic => http::anthropic(self, p),
            Kind::Codex => codex::exec(self, p),
            Kind::Jev => Err(Deferred::Rejected),
        }
    }

    /// Several items in one call ([`BATCH`] at most), answered by id.
    pub fn complete_batch(&self, b: &Batch) -> Result<BatchAnswer, Deferred> {
        if b.items.len() > BATCH {
            return Err(Deferred::BatchTooLarge);
        }
        let a = self.complete(&batch_prompt(b))?;
        let mut answers = BTreeMap::new();
        if let Value::Object(m) = a.value {
            for (id, _) in &b.items {
                if let Some(v) = m.get(id) {
                    answers.insert(id.clone(), v.clone());
                }
            }
        }
        Ok(BatchAnswer {
            answers,
            model: a.model,
            usage: a.usage,
        })
    }

    /// Closed-choice questions about a state, [`BATCH`] questions per request (Jev only). The state is JSON text
    /// and the questions a list, both sent in the order given: a [`Value`] would sort the state's keys.
    pub fn classify(
        &self,
        state: &RawValue,
        questions: &[(String, ChoiceQuestion)],
    ) -> Result<Classification, Deferred> {
        if self.provider.kind != Kind::Jev {
            return Err(Deferred::Rejected);
        }
        let mut out = Classification {
            model: self.provider.model.clone(),
            answers: BTreeMap::new(),
            usage: Usage::default(),
            deferred: None,
        };
        for qs in http::jev_batches(&self.provider.model, state, questions) {
            let (model, answers, usage) =
                match self.admit().and_then(|_| http::jev(self, state, &qs)) {
                    Ok(r) => r,
                    // Nothing answered yet: the whole request is deferred.
                    Err(d) if out.answers.is_empty() => return Err(d),
                    Err(d) => {
                        out.deferred = Some(d);
                        return Ok(out);
                    }
                };
            out.usage.add(&usage);
            out.answers.extend(answers);
            out.model = model;
        }
        Ok(out)
    }

    /// Whether Codex is installed, recent enough and logged in: `codex --version` and `codex login status`, run with
    /// the same minimal environment as a call. Nothing of Codex's own (its config or auth files) is read here.
    pub fn codex_status(&self) -> Result<(), Deferred> {
        codex::ready(self)
    }

    /// Defers when this month's tokens have reached the budget.
    fn admit(&self) -> Result<(), Deferred> {
        if self.ledger_failed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Deferred::Storage);
        }
        let month = ledger::this_month();
        if self.ledger.writable(&month).is_err() {
            return Err(Deferred::Storage);
        }
        match self.ledger.spent(&month) {
            Err(_) => Err(Deferred::Storage),
            Ok(n) if n >= self.monthly_budget => Err(Deferred::Budget),
            Ok(_) => Ok(()),
        }
    }

    /// Records a call's usage; when it cannot be written, every later call in this process defers.
    fn record(&self, model: &str, usage: &Usage) {
        if self
            .ledger
            .record(&self.provider.name, model, usage)
            .is_err()
        {
            self.ledger_failed
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn key(&self) -> Result<String, Deferred> {
        let var = self.provider.key_env.as_deref().unwrap_or("");
        match (self.env)(var) {
            Some(k) if !k.trim().is_empty() => Ok(k.trim().to_string()),
            _ => Err(Deferred::NoKey(var.to_string())),
        }
    }
}

/// The prompt for a batch: the instructions, then the items as one JSON object keyed by id, and a schema with one
/// required property per id.
fn batch_prompt(b: &Batch) -> Prompt {
    let items: Map<String, Value> = b.items.iter().cloned().collect();
    let ids: Vec<&String> = b.items.iter().map(|(id, _)| id).collect();
    let properties: Map<String, Value> = ids
        .iter()
        .map(|id| ((*id).clone(), b.answer_schema.clone()))
        .collect();
    let text = format!(
        "{}\n\nAnswer every item under its id, as one JSON object: {{\"<id>\": <answer>, ...}}.\n\nItems:\n{}\n",
        b.instructions.trim_end(),
        serde_json::to_string_pretty(&Value::Object(items)).unwrap_or_default()
    );
    Prompt {
        text,
        schema: Some(json!({
            "type": "object",
            "properties": properties,
            "required": ids,
            "additionalProperties": false,
        })),
        max_tokens: b.max_tokens,
    }
}

/// Splits items into batches of at most [`BATCH`].
pub fn batches<T>(items: &[T]) -> std::slice::Chunks<'_, T> {
    items.chunks(BATCH)
}

/// The first JSON value of the expected shape in a model's text (fenced or not).
fn parse_answer(text: &str, schema: Option<&Value>) -> Option<Value> {
    let t = text.trim();
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let want_array = match schema.and_then(|s| s.get("type")).and_then(Value::as_str) {
        Some(kind) => kind == "array",
        // No schema: whichever kind of JSON value starts first.
        None => matches!((t.find('['), t.find('{')), (Some(a), o) if o.is_none_or(|o| a < o)),
    };
    let (open, close) = if want_array { ('[', ']') } else { ('{', '}') };
    let start = t.find(open)?;
    let end = t.rfind(close)?;
    (end > start)
        .then(|| serde_json::from_str(&t[start..=end]).ok())
        .flatten()
}

/// Whether a value has the schema's top-level shape: its type and, for an object, every required property. Full
/// validation is the step's own; this catches an answer of the wrong kind from a route that does not enforce schemas.
fn fits(v: &Value, schema: Option<&Value>) -> bool {
    let Some(s) = schema else { return true };
    match s.get("type").and_then(Value::as_str) {
        Some("object") => v.as_object().is_some_and(|o| {
            s.get("required").and_then(Value::as_array).is_none_or(|r| {
                r.iter()
                    .filter_map(Value::as_str)
                    .all(|k| o.contains_key(k))
            })
        }),
        Some("array") => v.is_array(),
        _ => true,
    }
}

/// A cache-and-ledger-safe temporary directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> std::io::Result<TempDir> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "unstale-{tag}-{}-{nanos}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p)?;
        Ok(TempDir(p))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
