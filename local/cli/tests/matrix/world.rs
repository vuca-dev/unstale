//! One simulated developer machine per scenario: a temporary HOME with the repository and a sibling repository,
//! PATH, environment, the mock catalog and provider, a proxy trap, a fake `codex`, and the canaries.

use super::*;

pub(crate) const TODAY: &str = "2026-11-10";
/// A line of the fixture repository's code: it must never reach a provider or the catalog.
pub(crate) const CODE_MARKER: &str = "shopCheckoutMarker4e1d";
/// The catalog's notice, shown once a day.
pub(crate) const NOTICE: &str = "This is the catalog's notice for the matrix (shown once a day).";
/// Public release-note text from the fixture catalog's change event: what a model step may send.
pub(crate) const RELEASE_NOTE: &str =
    "The middleware file convention is renamed to proxy; middleware.ts keeps working until 17.";

pub(crate) fn this_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A newer client than this one, for the catalog's update line.
pub(crate) fn newer_version() -> String {
    let v = semver::Version::parse(this_version()).unwrap();
    format!("{}.{}.0", v.major, v.minor + 1)
}

pub(crate) fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

pub(crate) fn catalog() -> testcat::FixtureCatalog {
    use testcat::{event, rec, with};
    let cat = testcat::FixtureCatalog::new();
    cat.root(
        &json!({"schema": 1, "min_client": "0.1.0", "latest_client": newer_version(),
            "notice": {"id": "matrix", "until": "2026-11-30", "text": NOTICE}})
        .to_string(),
    );
    let records = vec![
        with(
            rec("next:middleware-to-proxy", "pkg:npm/next", "16.1.0"),
            json!({"change_type": "deprecation", "summary": "The middleware file convention is renamed to proxy.",
                "terms": [["middleware.ts", 0]], "replaces": ["middleware.ts"], "introduces": ["proxy.ts"]}),
        ),
        with(
            rec("next:csrf", "pkg:npm/next", "16.0.3"),
            json!({"change_type": "security", "benefit": ["security"], "summary": "Server actions check the Origin header."}),
        ),
    ];
    cat.tech_events(
        "next",
        0,
        &[("16", records)],
        &[("16", vec![event("next", "16.1.0", RELEASE_NOTE)])],
    );
    cat
}

/// The coverage service's answer for a package: public coverage, nothing in progress.
pub(crate) fn coverage_job(purl: &str) -> String {
    let name = purl.rsplit('/').next().unwrap_or(purl);
    let (state, records) = if name == "next" {
        ("monitoring", 2)
    } else {
        ("unsupported", 0)
    };
    json!({"purl": purl, "technology": name, "name": name, "state": state, "stage": "", "records": records, "updated": ""})
        .to_string()
}

/// The catalog host: the published catalog files and the coverage service, as one service answers both.
pub(crate) fn catalog_host(dir: PathBuf) -> Mock {
    Mock::start(move |r: &Request| {
        let path = r.path.split('?').next().unwrap_or("");
        if r.method == "GET" && path == "/health" {
            return Response::json(200, r#"{"service":"unstale-coverage","schema":1}"#);
        }
        if path == "/coverage" {
            let purl = if r.method == "POST" {
                serde_json::from_str::<serde_json::Value>(&r.body)
                    .ok()
                    .and_then(|v| v["purl"].as_str().map(String::from))
            } else {
                r.path.split_once("purl=").map(|(_, p)| {
                    p.replace("%3A", ":")
                        .replace("%2F", "/")
                        .replace("%40", "@")
                })
            };
            return match purl {
                Some(p) => Response::json(200, &coverage_job(&p)),
                None => Response::json(400, "{}"),
            };
        }
        if r.method == "GET" && path.starts_with("/v1/") && !path.contains("..") {
            return match std::fs::read(dir.join(&path[1..])) {
                Ok(b) => Response::bytes(200, b),
                Err(_) => Response::bytes(404, vec![]),
            };
        }
        // Batch routes and anything else: unknown here, so the client asks a package at a time.
        Response::bytes(404, vec![])
    })
}

pub(crate) const OPENAI_OK: &str = r#"{"model":"m","choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}"#;
pub(crate) const ANTHROPIC_OK: &str = r#"{"model":"claude-haiku-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"{\"ok\":true}"}],"usage":{"input_tokens":10,"output_tokens":2}}"#;
pub(crate) const CODEX_NOT_ON_PLAN: &str = r#"{"type":"error","message":"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."}"#;

/// The model provider: OpenAI-compatible chat and Anthropic Messages on one host, answering as `answer` says.
pub(crate) fn provider_host(answer: Answer) -> Mock {
    Mock::start(move |r: &Request| {
        let ok = if r.path.ends_with("/v1/messages") {
            ANTHROPIC_OK
        } else {
            OPENAI_OK
        };
        match answer {
            Answer::Ok | Answer::BudgetSpent => Response::json(200, ok),
            Answer::Refused => {
                Response::json(401, r#"{"error":{"message":"Incorrect API key provided"}}"#)
            }
            Answer::RateLimited => {
                Response::json(429, r#"{"error":{"message":"Rate limit reached"}}"#)
            }
            Answer::Down => Response::json(503, r#"{"error":{"message":"Service unavailable"}}"#),
            Answer::Slow => Response::json(200, ok).after(Duration::from_millis(2500)),
            Answer::NotOnPlan => {
                Response::json(404, r#"{"error":{"message":"The model does not exist"}}"#)
            }
        }
    })
}

/// Anything the client tries to reach that is not on this machine: every proxy variable points here.
pub(crate) fn trap() -> Mock {
    Mock::start(|_| Response::bytes(403, vec![]))
}

// -------------------------------------------------------------------------------------------------------- session

/// One simulated developer machine: a temporary HOME holding the repository and a sibling repository, a `bin` with
/// a fake `codex` (when installed), the mocks, and the canaries.
pub(crate) struct World {
    /// First, so the sentinels are released before the directory holding them is removed.
    pub(crate) sentinels: Vec<Sentinel>,
    pub(crate) base: tempfile::TempDir,
    pub(crate) catalog_host: Mock,
    pub(crate) provider_host: Mock,
    pub(crate) trap: Mock,
    pub(crate) _catalog: testcat::FixtureCatalog,
}

impl World {
    pub(crate) fn home(&self) -> PathBuf {
        self.base.path().join("home")
    }
    pub(crate) fn repo(&self) -> PathBuf {
        self.home().join("code/shop")
    }
    pub(crate) fn codex_dir(&self) -> PathBuf {
        self.base.path().join("codex")
    }
    pub(crate) fn cache(&self) -> PathBuf {
        self.home().join(".cache/unstale")
    }

    pub(crate) fn new(s: &Scenario) -> World {
        let cat = catalog();
        let w = World {
            base: tempfile::tempdir().unwrap(),
            catalog_host: catalog_host(cat.dir.path().to_path_buf()),
            provider_host: provider_host(s.answer),
            trap: trap(),
            sentinels: vec![],
            _catalog: cat,
        };
        let repo = w.repo();
        write(
            &repo.join("package.json"),
            r#"{"name":"shop","private":true,"dependencies":{"next":"^16.0.0","react":"^19.0.0"}}"#,
        );
        write(
            &repo.join("node_modules/next/package.json"),
            r#"{"name":"next","version":"16.0.1"}"#,
        );
        write(
            &repo.join("src/middleware.ts"),
            &format!(
                "import {{ NextResponse }} from 'next/server';\nexport const {CODE_MARKER} = true;\nexport function middleware() {{ return NextResponse.next(); }}\n"
            ),
        );
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        let mut env = String::new();
        for k in s.keys.repo_env {
            env += &format!("{k}={}\n", repo_value(k));
        }
        // A secret that is not a key: never read as one, never copied anywhere.
        env += &format!(
            "DATABASE_URL=postgres://shop:{}@localhost/shop\n",
            support::REPO_CANARY
        );
        write(&repo.join(".env"), &env);
        if let Some(choice) = s.config.choice {
            let parsed = choice_json(choice);
            write(
                &repo.join(".unstale/config.json"),
                &serde_json::to_string_pretty(
                    &json!({"schema": 1, "catalog": w.catalog_host.url, "mode": "collaborative",
                    "service": w.catalog_host.url, "inference": parsed}),
                )
                .unwrap(),
            );
        }
        std::fs::create_dir_all(w.base.path().join("bin")).unwrap();
        if s.codex.installed {
            let out = if s.answer == Answer::NotOnPlan {
                CODEX_NOT_ON_PLAN
            } else {
                support::CODEX_OK
            };
            let bin = support::fake_codex(
                &w.codex_dir(),
                s.codex.logged_in,
                out,
                if s.answer == Answer::NotOnPlan { 1 } else { 0 },
            );
            std::fs::rename(bin.join("codex"), w.base.path().join("bin/codex")).unwrap();
        }
        if s.answer == Answer::BudgetSpent {
            write(
                &w.cache().join("inference/usage-2026-11.jsonl"),
                "{\"day\":\"2026-11-02\",\"provider\":\"openai\",\"model\":\"gpt-6-luna\",\"input\":48000000,\"cached\":0,\"output\":0}\n",
            );
        }
        let mut w = w;
        let mut other = String::new();
        for k in s.keys.other_env {
            other += &format!("{k}={}\n", support::OTHER_CANARY);
        }
        other += &format!("SESSION_SECRET={}\n", support::OTHER_CANARY);
        w.sentinels
            .push(Sentinel::plant(&w.home().join("code/other/.env"), &other));
        w.sentinels.push(Sentinel::plant(
            &w.home().join(".codex/auth.json"),
            &format!(
                "{{\"tokens\":{{\"access_token\":\"{}\"}}}}",
                support::AUTH_CANARY
            ),
        ));
        if s.fault == Some(Fault::OpenPlantedUserConfig) {
            w.sentinels.push(Sentinel::plant(
                &w.home().join(".config/unstale/config.json"),
                &format!(
                    "{{\"inference\":{{\"provider\":\"{}\"}}}}",
                    support::AUTH_CANARY
                ),
            ));
        }
        w
    }

    /// The environment every command runs in: nothing inherited from the machine running the tests.
    pub(crate) fn env(&self, s: &Scenario) -> Vec<(String, String)> {
        let mut e: Vec<(String, String)> = vec![
            ("HOME".into(), self.home().display().to_string()),
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin", self.base.path().join("bin").display()),
            ),
            (
                "UNSTALE_CACHE_DIR".into(),
                self.cache().display().to_string(),
            ),
            ("UNSTALE_SERVICE".into(), self.catalog_host.url.clone()),
            ("UNSTALE_TODAY".into(), TODAY.into()),
            ("UNSTALE_NO_REGISTRY".into(), "1".into()),
            ("UNSTALE_EDGE_INFERENCE".into(), "1".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
            ("no_proxy".into(), "127.0.0.1,localhost".into()),
        ];
        for v in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            e.push((v.into(), self.trap.url.clone()));
        }
        e.push((
            "TERM".into(),
            if s.invocation.terminal {
                "xterm-256color"
            } else {
                "dumb"
            }
            .into(),
        ));
        if s.invocation.ci {
            e.push(("CI".into(), "true".into()));
        }
        for k in s.keys.shell {
            e.push((k.to_string(), shell_value(k)));
        }
        e
    }

    pub(crate) fn command(&self, s: &Scenario, args: &[String]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
        c.args(args).current_dir(self.repo()).env_clear();
        for (k, v) in self.env(s) {
            c.env(k, v);
        }
        c
    }

    /// Replaces what differs from run to run (temporary paths, ports, the client's version) with stable names.
    pub(crate) fn normalise(&self, text: &str) -> String {
        let mut t = text.to_string();
        let base = self.base.path().to_path_buf();
        let canon = base.canonicalize().unwrap_or(base.clone());
        for b in [canon, base] {
            let b = b.display().to_string();
            t = t
                .replace(&format!("{b}/home"), "~")
                .replace(&format!("{b}/bin"), "~/bin")
                .replace(&b, "<tmp>");
        }
        t = t
            .replace(&self.catalog_host.url, "https://catalog.example")
            .replace(&self.provider_host.url, "https://provider.example")
            .replace(&self.trap.url, "http://proxy.example");
        t = t
            .replace(&newer_version(), "<newer version>")
            .replace(this_version(), "<this version>");
        // A progress line's elapsed time depends on the machine.
        t.lines()
            .map(|l| match l.rsplit_once(" · ") {
                Some((head, secs))
                    if l.trim_start().starts_with('◐')
                        && secs.ends_with('s')
                        && secs[..secs.len() - 1].bytes().all(|b| b.is_ascii_digit()) =>
                {
                    format!("{head} · 0s")
                }
                _ => l.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + if t.ends_with('\n') { "\n" } else { "" }
    }
}

pub(crate) fn shell_value(name: &str) -> String {
    format!("{}-{}", support::SHELL_CANARY, name.to_ascii_lowercase())
}

pub(crate) fn repo_value(name: &str) -> String {
    format!("{}-{}", support::REPO_CANARY, name.to_ascii_lowercase())
}

/// What `--inference <value>` records, as the repository config stores it.
pub(crate) fn choice_json(value: &str) -> serde_json::Value {
    let (provider, key_env) = match value.strip_prefix("env:") {
        Some(var) => (
            match var {
                "AI_GATEWAY_API_KEY" => "vercel",
                "OPENAI_API_KEY" => "openai",
                "OPENROUTER_API_KEY" => "openrouter",
                "ANTHROPIC_API_KEY" => "anthropic",
                v => panic!("no route for {v}"),
            },
            Some(var),
        ),
        None => (value, None),
    };
    match key_env {
        Some(k) => json!({"provider": provider, "key_env": k}),
        None => json!({"provider": provider}),
    }
}
