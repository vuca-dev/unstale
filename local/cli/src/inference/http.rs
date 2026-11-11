//! The HTTP adapters: OpenAI-compatible chat completions, Anthropic Messages and the Jev decision API, on one POST with
//! timeouts and retries for transient failures only.

use super::{Answer, Choice, ChoiceQuestion, Deferred, Inference, Prompt, Usage, parse_answer};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

/// The Anthropic API version the request shape follows.
const ANTHROPIC_VERSION: &str = "2026-10-21";
/// A Jev request carries at most this many questions and this many bytes of JSON.
const JEV_MAX_QUESTIONS: usize = super::BATCH;
const JEV_MAX_BYTES: usize = 32 * 1024;
/// The longest `Retry-After` honoured between attempts.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(60);

/// POSTs `body` and returns the parsed JSON response. `auth` names the header the key goes in and its prefix; the key
/// is read here, used for this request only, and never appears in a returned value.
fn post(
    inf: &Inference,
    url: &str,
    auth: (&str, &str),
    headers: &[(&str, &str)],
    body: &Value,
) -> Result<Value, Deferred> {
    let key = inf.key()?;
    let bytes = serde_json::to_vec(body).map_err(|_| Deferred::Rejected)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(inf.limits.timeout))
        .build()
        .into();
    let mut attempt = 0;
    loop {
        let mut req = agent
            .post(url)
            .header("Content-Type", "application/json")
            .header(auth.0, format!("{}{key}", auth.1));
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let (outcome, wait) = match req.send(&bytes[..]) {
            Err(ureq::Error::Timeout(_)) => (Err(Deferred::Timeout), None),
            Err(_) => (Err(Deferred::Unavailable), None),
            Ok(mut r) => {
                let status = r.status().as_u16();
                let wait = r
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| crate::onboarding::retry_after_secs(v, unix_now()))
                    .map(|s| Duration::from_secs(s).min(RETRY_AFTER_MAX));
                let outcome = match status {
                    200..=299 => r
                        .body_mut()
                        .with_config()
                        .limit(16 * 1024 * 1024)
                        .read_to_vec()
                        // The request was answered (and may have been billed): not sent again.
                        .map_err(|_| Deferred::Malformed)
                        .and_then(|b| serde_json::from_slice(&b).map_err(|_| Deferred::Malformed)),
                    401 | 403 => Err(Deferred::Auth),
                    402 => Err(Deferred::Billing),
                    404 => Err(Deferred::ModelNotOnPlan(inf.provider.model.clone())),
                    408 => Err(Deferred::Timeout),
                    429 => Err(Deferred::RateLimited),
                    500.. => Err(Deferred::Unavailable),
                    _ => Err(Deferred::Rejected),
                };
                (outcome, wait)
            }
        };
        match outcome {
            Err(d) if d.transient() && attempt < inf.limits.retries => {
                std::thread::sleep(wait.unwrap_or(inf.limits.backoff * 2u32.pow(attempt)));
                attempt += 1;
            }
            other => return other,
        }
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn base(inf: &Inference) -> &str {
    inf.provider.base_url.trim_end_matches('/')
}

fn num(v: &Value, path: &[&str]) -> Option<u64> {
    path.iter()
        .try_fold(v, |v, k| v.get(k))
        .and_then(Value::as_u64)
}

/// OpenAI-compatible `chat/completions` with a strict JSON-schema response format.
pub(super) fn openai(inf: &Inference, p: &Prompt) -> Result<Answer, Deferred> {
    let c = &inf.provider;
    let mut body = json!({
        "model": c.model,
        "messages": [{"role": "user", "content": p.text}],
        "max_tokens": p.max_tokens,
    });
    if let Some(e) = &c.effort {
        body["reasoning_effort"] = json!(e);
    }
    if let Some(s) = &p.schema {
        body["response_format"] = json!({
            "type": "json_schema",
            "json_schema": {"name": "answer", "strict": true, "schema": s},
        });
    }
    for (k, v) in &c.extra {
        body[k] = v.clone();
    }
    let r = post(
        inf,
        &format!("{}/chat/completions", base(inf)),
        ("Authorization", "Bearer "),
        &[],
        &body,
    )?;
    let u = r.get("usage").cloned().unwrap_or(Value::Null);
    let usage = if u.get("prompt_tokens").is_none() {
        Usage::estimate(&body, &r)
    } else {
        Usage {
            input: num(&u, &["prompt_tokens"]).unwrap_or(0),
            cached: num(&u, &["prompt_tokens_details", "cached_tokens"]).unwrap_or(0),
            output: num(&u, &["completion_tokens"]).unwrap_or(0),
            reasoning: num(&u, &["completion_tokens_details", "reasoning_tokens"]),
        }
    };
    let model = r
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&c.model)
        .to_string();
    let choice = r.pointer("/choices/0").cloned().unwrap_or(Value::Null);
    let finish = choice.get("finish_reason").and_then(Value::as_str);
    let text = choice.pointer("/message/content").and_then(Value::as_str);
    // The tokens were spent whether or not the answer is usable.
    inf.ledger.record(&c.name, &model, &usage);
    if finish == Some("length") {
        return Err(Deferred::TooLong);
    }
    let value = text
        .and_then(|t| parse_answer(t, p.schema.as_ref()))
        .ok_or(Deferred::Malformed)?;
    Ok(Answer {
        value,
        model,
        usage,
    })
}

/// Anthropic Messages with `output_config.format` (JSON schema). Effort `none` turns thinking off; another effort is
/// sent as `output_config.effort`.
pub(super) fn anthropic(inf: &Inference, p: &Prompt) -> Result<Answer, Deferred> {
    let c = &inf.provider;
    let mut body = json!({
        "model": c.model,
        "max_tokens": p.max_tokens,
        "messages": [{"role": "user", "content": p.text}],
    });
    let mut output_config = serde_json::Map::new();
    match c.effort.as_deref() {
        Some("none") => body["thinking"] = json!({"type": "disabled"}),
        Some(e) => {
            output_config.insert("effort".into(), json!(e));
        }
        None => {}
    }
    if let Some(s) = &p.schema {
        output_config.insert("format".into(), json!({"type": "json_schema", "schema": s}));
    }
    if !output_config.is_empty() {
        body["output_config"] = Value::Object(output_config);
    }
    let r = post(
        inf,
        &format!("{}/v1/messages", base(inf)),
        ("x-api-key", ""),
        &[("anthropic-version", ANTHROPIC_VERSION)],
        &body,
    )?;
    let u = r.get("usage").cloned().unwrap_or(Value::Null);
    let read = num(&u, &["cache_read_input_tokens"]).unwrap_or(0);
    let usage = if u.get("input_tokens").is_none() {
        Usage::estimate(&body, &r)
    } else {
        Usage {
            // `input_tokens` excludes cache reads and writes.
            input: num(&u, &["input_tokens"]).unwrap_or(0)
                + read
                + num(&u, &["cache_creation_input_tokens"]).unwrap_or(0),
            cached: read,
            output: num(&u, &["output_tokens"]).unwrap_or(0),
            reasoning: None,
        }
    };
    let model = r
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&c.model)
        .to_string();
    inf.ledger.record(&c.name, &model, &usage);
    match r.get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => return Err(Deferred::TooLong),
        Some("refusal") => return Err(Deferred::Malformed),
        _ => {}
    }
    let text: String = r
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let value = parse_answer(&text, p.schema.as_ref()).ok_or(Deferred::Malformed)?;
    Ok(Answer {
        value,
        model,
        usage,
    })
}

fn jev_body(model: &str, state: &Value, qs: &BTreeMap<String, ChoiceQuestion>) -> Value {
    let questions: serde_json::Map<String, Value> = qs
        .iter()
        .map(|(id, q)| {
            (
                id.clone(),
                json!({"type": "choice", "instructions": q.instructions, "criteria": q.options}),
            )
        })
        .collect();
    json!({"model": model, "state": state, "questions": questions})
}

/// Splits questions into requests of at most [`JEV_MAX_QUESTIONS`] questions and [`JEV_MAX_BYTES`] of JSON.
pub(super) fn jev_batches(
    model: &str,
    state: &Value,
    questions: &BTreeMap<String, ChoiceQuestion>,
) -> Vec<BTreeMap<String, ChoiceQuestion>> {
    let mut out = Vec::new();
    let mut cur: BTreeMap<String, ChoiceQuestion> = BTreeMap::new();
    for (id, q) in questions {
        let mut next = cur.clone();
        next.insert(id.clone(), q.clone());
        let size = serde_json::to_vec(&jev_body(model, state, &next))
            .map(|b| b.len())
            .unwrap_or(0);
        if !cur.is_empty() && (next.len() > JEV_MAX_QUESTIONS || size > JEV_MAX_BYTES) {
            out.push(std::mem::take(&mut cur));
            cur.insert(id.clone(), q.clone());
        } else {
            cur = next;
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// One Jev request: every answer checked against its question's options.
pub(super) fn jev(
    inf: &Inference,
    state: &Value,
    qs: &BTreeMap<String, ChoiceQuestion>,
) -> Result<(String, BTreeMap<String, Choice>, Usage), Deferred> {
    let c = &inf.provider;
    let body = jev_body(&c.model, state, qs);
    if serde_json::to_vec(&body).map_or(0, |b| b.len()) > JEV_MAX_BYTES {
        // One question alone is over the request limit: never sent.
        return Err(Deferred::TooLong);
    }
    let r = post(
        inf,
        &format!("{}/v1/systemone", base(inf)),
        ("Authorization", "Bearer "),
        &[],
        &body,
    )?;
    let usage = if r.pointer("/usage/input_tokens").is_none() {
        Usage::estimate(&body, &r)
    } else {
        Usage {
            input: num(&r, &["usage", "input_tokens"]).unwrap_or(0),
            cached: 0,
            output: num(&r, &["usage", "output_tokens"]).unwrap_or(0),
            reasoning: None,
        }
    };
    let model = r
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(&c.model)
        .to_string();
    inf.ledger.record(&c.name, &model, &usage);
    let mut answers = BTreeMap::new();
    for (id, q) in qs {
        let a = r.get("answers").and_then(|a| a.get(id));
        let choice = a.and_then(|a| a.get("choice")).and_then(Value::as_str);
        let confidence = a.and_then(|a| a.get("confidence")).and_then(Value::as_f64);
        let (Some(choice), Some(confidence)) = (choice, confidence) else {
            return Err(Deferred::Malformed);
        };
        let probabilities: Option<BTreeMap<String, f64>> = q
            .options
            .keys()
            .map(|o| {
                a.and_then(|a| a.get("probabilities"))
                    .and_then(|p| p.get(o))
                    .and_then(Value::as_f64)
                    .map(|p| (o.clone(), p))
            })
            .collect();
        match probabilities {
            Some(probabilities) if q.options.contains_key(choice) => {
                answers.insert(
                    id.clone(),
                    Choice {
                        choice: choice.into(),
                        confidence,
                        probabilities,
                    },
                );
            }
            _ => return Err(Deferred::Malformed),
        }
    }
    Ok((model, answers, usage))
}
