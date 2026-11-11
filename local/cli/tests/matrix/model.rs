//! The mock model behind every route: it answers the client's own pipeline steps (extraction and its labels, the
//! label questions, matching) from the prompt alone, the way a model would, so a scenario runs the real path end to
//! end. It reads only the shape of each prompt (the published templates in `schema/prompts/`), never anything a
//! scenario planted.

use super::*;

/// What the model says to one prompt: the text a chat route returns.
pub(crate) fn answer(prompt: &str) -> String {
    if prompt.starts_with("You extract change records") {
        return extraction(prompt);
    }
    if prompt.starts_with("You write search terms") {
        return labels_for_records(prompt);
    }
    if prompt.starts_with("You answer closed-choice questions") {
        return choices(prompt);
    }
    // Anything else (the fault steps' `unstale infer`): a plain JSON answer.
    r#"{"ok":true}"#.into()
}

/// One record per release-note chunk: its first word is the subject, its text the summary and the evidence.
fn record(notes: &str) -> serde_json::Value {
    let notes = notes.trim();
    let subject: String = notes
        .split_whitespace()
        .next()
        .unwrap_or("change")
        .trim_matches(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.'))
        .to_string();
    let summary = notes.split(['.', ';']).next().unwrap_or(notes).trim();
    json!({"subject": subject, "summary": format!("{summary}."), "change_type": "deprecation",
        "surface": "code_api", "evidence": notes})
}

fn extraction(prompt: &str) -> String {
    // Batched (Codex): `<chunk id="c1" ...>notes</chunk>`, answered by chunk id.
    if prompt.contains("<chunk id=\"") {
        let mut out = serde_json::Map::new();
        for part in prompt.split("<chunk id=\"").skip(1) {
            let Some((id, rest)) = part.split_once('"') else {
                continue;
            };
            let body = rest.split_once(">\n").map(|x| x.1).unwrap_or("");
            let notes = body.split("\n</chunk>").next().unwrap_or("");
            out.insert(id.to_string(), json!([record(notes)]));
        }
        return serde_json::Value::Object(out).to_string();
    }
    let notes = prompt
        .rsplit_once("<notes>\n")
        .map(|x| x.1)
        .and_then(|t| t.split_once("\n</notes>"))
        .map(|x| x.0)
        .unwrap_or("");
    json!([record(notes)]).to_string()
}

/// The label call of extraction: search terms for each record it lists (`"id": "r1"`, ...).
fn labels_for_records(prompt: &str) -> String {
    let mut out = serde_json::Map::new();
    let mut n = 1;
    while prompt.contains(&format!("\"id\": \"r{n}\"")) {
        out.insert(
            format!("r{n}"),
            json!({"terms": [], "replaces": [], "requires": [], "prerequisites": [], "conditions": []}),
        );
        n += 1;
    }
    serde_json::Value::Object(out).to_string()
}

/// A closed-choice answer: `no` wherever it is an option (not breaking, no benefit, not the same change), else the
/// first option.
fn pick(options: &serde_json::Map<String, serde_json::Value>) -> String {
    if options.contains_key("no") {
        "no".into()
    } else {
        options.keys().next().cloned().unwrap_or_default()
    }
}

fn choices(prompt: &str) -> String {
    let Some((head, qs)) = prompt
        .rsplit_once("\nQuestions:\n")
        .or_else(|| prompt.rsplit_once("\nQuestions (the same for every record):\n"))
    else {
        return "{}".into();
    };
    let qs: serde_json::Value = serde_json::from_str(qs.trim()).unwrap_or_default();
    let mut one = serde_json::Map::new();
    for (id, q) in qs.as_object().into_iter().flatten() {
        let options = q["options"].as_object().cloned().unwrap_or_default();
        one.insert(id.clone(), json!(pick(&options)));
    }
    // Batched (Codex): one answer per record id listed under `Records:`.
    if let Some((_, records)) = head.rsplit_once("\nRecords:\n") {
        let mut all = serde_json::Map::new();
        for line in records.lines() {
            if let Some((id, _)) = line.split_once(": ")
                && id.starts_with('r')
                && id[1..].bytes().all(|b| b.is_ascii_digit())
            {
                all.insert(id.to_string(), serde_json::Value::Object(one.clone()));
            }
        }
        return serde_json::Value::Object(all).to_string();
    }
    serde_json::Value::Object(one).to_string()
}

/// The labelling service's answer: every question it was sent, answered as [`pick`] does, with probabilities.
pub(crate) fn jev_answer(body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let mut answers = serde_json::Map::new();
    for (id, q) in v["questions"].as_object().into_iter().flatten() {
        let options = q["criteria"].as_object().cloned().unwrap_or_default();
        let choice = pick(&options);
        let probs: serde_json::Map<String, serde_json::Value> = options
            .keys()
            .map(|o| (o.clone(), json!(if *o == choice { 0.9 } else { 0.1 })))
            .collect();
        answers.insert(
            id.clone(),
            json!({"choice": choice, "confidence": 0.9, "probabilities": probs}),
        );
    }
    json!({"model": "jev-1.14.0", "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 1}})
        .to_string()
}

/// The prompt a request to the provider carries: the first message's text (OpenAI-compatible and Anthropic alike).
pub(crate) fn prompt_of(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["messages"][0]["content"].as_str().map(String::from))
        .unwrap_or_default()
}

/// The releases an extraction prompt asks about, as `technology@version`: `Technology: …` with `Release: … (`, or each
/// batched chunk's `technology="…" release="… (`.
pub(crate) fn releases_asked(prompt: &str) -> Vec<String> {
    if !prompt.starts_with("You extract change records") {
        return vec![];
    }
    let mut out = vec![];
    for part in prompt.split("<chunk id=\"").skip(1) {
        let attr = |name: &str| {
            part.split_once(&format!("{name}=\""))
                .and_then(|x| x.1.split_once('"'))
                .map(|x| x.0.to_string())
        };
        if let (Some(t), Some(r)) = (attr("technology"), attr("release")) {
            out.push(format!("{t}@{}", r.split(" (").next().unwrap_or(&r)));
        }
    }
    let line = |name: &str| {
        prompt
            .lines()
            .find_map(|l| l.strip_prefix(name))
            .map(|v| v.trim().to_string())
    };
    if let (Some(t), Some(r)) = (line("Technology: "), line("Release: ")) {
        out.push(format!("{t}@{}", r.split(" (").next().unwrap_or(&r)));
    }
    out
}
