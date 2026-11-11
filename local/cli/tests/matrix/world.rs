//! One simulated developer machine per scenario: a temporary HOME with the repository and a sibling repository,
//! PATH, environment, the mock catalog and provider, a proxy trap, a fake `codex`, and the canaries.

use super::*;

/// Files the client must never open besides the sibling repository's `.env` and Codex's auth file, relative to
/// HOME: `.env` files above the repository, this repository's `.env.local`, and shell startup files.
#[rustfmt::skip]
pub(crate) const NEVER_OPENED: &[&str] = &[
    ".env", "code/.env", "code/shop/.env.local",
    ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv", ".config/fish/config.fish",
    ".aws/credentials", ".ssh/id_ed25519", ".ssh/config", ".netrc", ".config/gh/hosts.yml",
    "code/other/.env.local", "code/other/.env.production",
];

/// Where the client may open files in HOME: this repository, its own cache and user config, and the package
/// managers' registry configuration in HOME and in the directories above the repository (read to keep private
/// packages' names from public services; `src/privacy.rs`). Anything else it tries to open, whether or not it
/// exists, breaks hold-the-line 1.
#[rustfmt::skip]
pub(crate) const MAY_OPEN: &[&str] = &[
    "code/shop/", ".cache/unstale/", ".config/unstale/",
    ".config/pip/pip.conf", ".config/pnpm/rc", ".config/uv/uv.toml", ".config/.bunfig.toml", ".pip/pip.conf",
    "pip/pip.ini", "Library/Application Support/pip/pip.conf", "Library/Preferences/pnpm/rc",
];
/// The registry configuration files the client may read in HOME and in each directory above the repository.
#[rustfmt::skip]
pub(crate) const REGISTRY_CONFIG: &[&str] = &[
    ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".bunfig.toml", "pip.conf", "Pipfile", "pyproject.toml",
    "uv.toml", ".cargo/config", ".cargo/config.toml",
];

/// Whether the client may open `rel` (relative to HOME). Never another `.env.*` of this repository.
pub(crate) fn may_open(rel: &str) -> bool {
    if let Some(inside) = rel.strip_prefix("code/shop/") {
        let name = inside.trim_start_matches("./");
        return !(name.starts_with(".env.") && !name.contains('/'));
    }
    MAY_OPEN.iter().any(|p| rel.starts_with(p))
        || ["", "code/"].iter().any(|dir| {
            rel.strip_prefix(dir)
                .is_some_and(|f| REGISTRY_CONFIG.contains(&f))
        })
}

pub(crate) const TODAY: &str = "2026-11-10";
/// A line of the fixture repository's code: it must never reach a provider or the catalog.
pub(crate) const CODE_MARKER: &str = "shopCheckoutMarker4e1d";
/// The catalog's notice: what every user must do by its date (30 November in the fixture catalog).
pub(crate) const NOTICE: &str = "Upgrade unstale; this version stops receiving new changes then.";
/// The notice as the client prints it.
pub(crate) const NOTICE_LINE: &str = "unstale notice, act by 30 November: Upgrade unstale; this version stops receiving new changes then.";
/// Public release-note text from the fixture catalog's change event: what a model step may send.
pub(crate) const RELEASE_NOTE: &str =
    "The middleware file convention is renamed to proxy; middleware.ts keeps working until 17.";

/// The variable that loads a library into a process at start.
pub(crate) const PRELOAD_VAR: &str = if cfg!(target_os = "macos") {
    "DYLD_INSERT_LIBRARIES"
} else {
    "LD_PRELOAD"
};

/// The open logger (`openlog.c`), built once per test run: loaded into the client, it records every path the client
/// tries to open, whether or not the file exists.
pub(crate) fn open_logger() -> &'static Path {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let src = golden_dir().join("openlog.c");
        let out = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(if cfg!(target_os = "macos") {
            "openlog.dylib"
        } else {
            "openlog.so"
        });
        let mut cc = Command::new("cc");
        if cfg!(target_os = "macos") {
            cc.args(["-dynamiclib", "-O1", "-o"]);
        } else {
            cc.args(["-shared", "-fPIC", "-O1", "-o"]);
        }
        cc.arg(&out).arg(&src);
        if !cfg!(target_os = "macos") {
            cc.arg("-ldl");
        }
        let st = cc
            .status()
            .expect("a C compiler (`cc`) builds the open logger");
        assert!(st.success(), "building {} failed", src.display());
        out
    })
}

/// A shell line that loads the open logger again into what it runs: a system shell drops the variable on macOS.
pub(crate) fn reload_logger() -> String {
    format!("export {PRELOAD_VAR}=\"$UNSTALE_TEST_SHIM\"; ")
}

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

/// One release of the fixture catalog's change events: whether the catalog has records for it, and whether central
/// marked the event as processed (`extracted`). The client runs its own model steps only for an event with neither.
pub(crate) struct Release {
    pub(crate) technology: &'static str,
    pub(crate) version: &'static str,
    pub(crate) notes: &'static str,
    pub(crate) records: bool,
    pub(crate) extracted: bool,
}

#[rustfmt::skip]
pub(crate) const RELEASES: &[Release] = &[
    Release { technology: "next", version: "16.1.0", notes: RELEASE_NOTE, records: true, extracted: false },
    Release { technology: "next", version: "16.2.0", notes: "after() runs once the response is sent; it is stable.", records: false, extracted: true },
    Release { technology: "next", version: "16.3.0", notes: "middleware.ts no longer runs on the edge runtime; proxy.ts runs on Node.js.", records: false, extracted: false },
    Release { technology: "react", version: "19.1.0", notes: "Activity hides part of the tree and keeps its state.", records: true, extracted: false },
    Release { technology: "react", version: "19.2.0", notes: "forwardRef is no longer needed: ref is a prop.", records: false, extracted: false },
];

/// The releases the client must read itself (`technology@version`): change events with no catalog records and no
/// `extracted` mark. Every other release costs no model call.
pub(crate) fn releases_to_read() -> BTreeSet<String> {
    RELEASES
        .iter()
        .filter(|r| !r.records && !r.extracted)
        .map(|r| format!("{}@{}", r.technology, r.version))
        .collect()
}

pub(crate) fn catalog() -> testcat::FixtureCatalog {
    catalog_with(
        &json!({"schema": 1, "min_client": "0.1.0", "latest_client": newer_version(),
        "notice": {"id": "matrix", "until": "2026-11-30", "text": NOTICE}}),
    )
}

pub(crate) fn catalog_with(root: &serde_json::Value) -> testcat::FixtureCatalog {
    use testcat::{event, rec, with};
    let cat = testcat::FixtureCatalog::new();
    cat.root(&root.to_string());
    let next_records = vec![
        with(
            rec("next:middleware-to-proxy", "pkg:npm/next", "16.1.0"),
            json!({"change_type": "deprecation", "subject": "middleware.ts", "summary": "The middleware file convention is renamed to proxy.",
                "terms": [["middleware.ts", 0]], "replaces": ["middleware.ts"], "introduces": ["proxy.ts"],
                "evidence": [{"kind": "release_notes", "url": "https://example.org/next/16.1.0", "quote": "q", "snapshot": "sha256:11"}]}),
        ),
        with(
            rec("next:csrf", "pkg:npm/next", "16.0.3"),
            json!({"change_type": "security", "benefit": ["security"], "summary": "Server actions check the Origin header."}),
        ),
    ];
    // React's record names both of its packages, so this stack needs it more than next: its releases are read first.
    let react_records = vec![with(
        rec("react:activity", "pkg:npm/react", "19.1.0"),
        json!({"summary": "Activity hides part of the tree and keeps its state.",
            "releases": [{"component": "pkg:npm/react", "version": "19.1.0", "date": "2026-01-01", "line": "19"},
                {"component": "pkg:npm/react-dom", "version": "19.1.0", "date": "2026-01-01", "line": "19"}]}),
    )];
    for (tech, line, records) in [("next", "16", next_records), ("react", "19", react_records)] {
        let events: Vec<serde_json::Value> = RELEASES
            .iter()
            .filter(|r| r.technology == tech)
            .map(|r| {
                let mut e = event(tech, r.version, r.notes);
                if r.extracted {
                    e["extracted"] = json!(true);
                }
                e
            })
            .collect();
        cat.tech_events(tech, 0, &[(line, records)], &[(line, events)]);
    }
    cat
}

/// The coverage service's answer for a package: public coverage, nothing in progress.
pub(crate) fn coverage_job(purl: &str) -> String {
    let name = purl.rsplit('/').next().unwrap_or(purl);
    let (state, records) = match name {
        "next" => ("monitoring", 2),
        "react" => ("monitoring", 1),
        _ => ("unsupported", 0),
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

pub(crate) const CODEX_NOT_ON_PLAN: &str = r#"{"type":"error","message":"The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."}"#;

/// The model provider: OpenAI-compatible chat, Anthropic Messages and the labelling service on one host, each answered
/// by the mock model ([`model::answer`]), or failing as `answer` says.
pub(crate) fn provider_host(answer: Answer, elsewhere: &str) -> Mock {
    let elsewhere = elsewhere.to_string();
    Mock::start(move |r: &Request| {
        let ok = if r.path.ends_with("/v1/systemone") {
            model::jev_answer(&r.body)
        } else {
            let text = model::answer(&model::prompt_of(&r.body));
            if r.path.ends_with("/v1/messages") {
                json!({"model": "claude-haiku-5-5", "stop_reason": "end_turn", "content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 10, "output_tokens": 2}})
                .to_string()
            } else {
                json!({"model": "m", "choices": [{"message": {"content": text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 2}})
                .to_string()
            }
        };
        // Retries are asked for at once, so a failing provider costs the scenario no waiting.
        let again = |mut r: Response| {
            r.headers.push(("Retry-After".into(), "0".into()));
            r
        };
        match answer {
            Answer::Ok | Answer::BudgetSpent | Answer::LimitPartway => Response::json(200, &ok),
            Answer::Refused => {
                Response::json(401, r#"{"error":{"message":"Incorrect API key provided"}}"#)
            }
            Answer::RateLimited => again(Response::json(
                429,
                r#"{"error":{"message":"Rate limit reached"}}"#,
            )),
            Answer::Down => again(Response::json(
                503,
                r#"{"error":{"message":"Service unavailable"}}"#,
            )),
            Answer::NotOnPlan => {
                Response::json(404, r#"{"error":{"message":"The model does not exist"}}"#)
            }
            Answer::Slow => Response::json(200, &ok).after(Duration::from_millis(2500)),
            Answer::Redirect => {
                let mut to = Response::json(307, "{}");
                to.headers
                    .push(("Location".into(), format!("{elsewhere}{}", r.path)));
                to
            }
        }
    })
}

/// What the fake `codex` asks: its prompt in, `codex exec --json` lines out, answered by the mock model.
pub(crate) fn codex_backend(answer: Answer) -> Mock {
    Mock::start(move |r: &Request| {
        if answer == Answer::NotOnPlan {
            return Response::json(200, CODEX_NOT_ON_PLAN);
        }
        let text = model::answer(&r.body);
        let lines = [
            json!({"type": "item.completed", "item": {"type": "agent_message", "text": text}}),
            json!({"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 0, "output_tokens": 2, "reasoning_output_tokens": 0}}),
        ];
        Response::bytes(
            200,
            lines
                .iter()
                .map(|l| format!("{l}\n"))
                .collect::<String>()
                .into_bytes(),
        )
    })
}

/// A fake `codex` in `bin`: `--version` and `login status` as a real one answers them; `codex exec` appends its
/// arguments to `<dir>/args` and its environment to `<dir>/env` (each call ending with a `---` line), and hands its
/// prompt (the last argument) to the mock model at `backend`. Every invocation's first two arguments go to
/// `<dir>/invocations`.
pub(crate) fn fake_codex(bin: &Path, dir: &Path, logged_in: bool, backend: &str, code: i32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).unwrap();
    let login = if logged_in {
        "echo 'Logged in using ChatGPT'; exit 0"
    } else {
        "echo 'Not logged in'; exit 1"
    };
    let script = format!(
        "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"{d}/invocations\"\n\
         if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.166.0'; exit 0; fi\n\
         if [ \"$1\" = \"login\" ]; then {login}; fi\n\
         printf '%s\\n' \"$@\" '---' >> \"{d}/args\"\nenv >> \"{d}/env\"\necho '---' >> \"{d}/env\"\n\
         for a; do last=\"$a\"; done\n\
         printf '%s' \"$last\" | /usr/bin/curl -s --noproxy '*' --data-binary @- \"{backend}/exec\"\nexit {code}\n",
        d = dir.display(),
    );
    std::fs::write(bin.join("codex"), script).unwrap();
    std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// The public registries and the advisory database, asked through the proxy (`CONNECT host:443`) when registry lookups
/// are on, about public package names only.
pub(crate) const REGISTRY_HOSTS: &[&str] =
    &["registry.npmjs.org:443", "pypi.org:443", "api.osv.dev:443"];

/// Anything the client tries to reach that is not on this machine: every proxy variable points here.
pub(crate) fn trap() -> Mock {
    Mock::start(|r: &Request| {
        // A tunnel is refused at once, as a proxy that forbids the host would.
        if r.method == "CONNECT" {
            return Response::bytes(502, vec![]);
        }
        Response::bytes(403, vec![])
    })
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
    /// Where the fake `codex` takes its prompts: the mock model, as Codex's own service would answer.
    pub(crate) codex_backend: Mock,
    /// Where a redirecting provider points: a client that follows it sends the key here.
    pub(crate) redirect_target: Mock,
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
    /// Every path the client tried to open, one per line (the open logger's).
    pub(crate) fn open_log(&self) -> PathBuf {
        self.base.path().join("opened.log")
    }

    pub(crate) fn new(s: &Scenario) -> World {
        let cat = catalog();
        let redirect_target = Mock::start(|_| Response::json(200, "{}"));
        let w = World {
            base: tempfile::tempdir().unwrap(),
            catalog_host: catalog_host(cat.dir.path().to_path_buf()),
            provider_host: provider_host(s.answer, &redirect_target.url),
            codex_backend: codex_backend(s.answer),
            redirect_target,
            trap: trap(),
            sentinels: vec![],
            _catalog: cat,
        };
        let repo = w.repo();
        write(
            &repo.join("package.json"),
            r#"{"name":"shop","private":true,"dependencies":{"next":"^16.0.0","react":"^19.0.0","react-dom":"^19.0.0"}}"#,
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
        for k in s.keys.blank {
            env += &format!("{k}=\n");
        }
        // A secret that is not a key: never read as one, never copied anywhere.
        env += &format!(
            "DATABASE_URL=postgres://shop:{}@localhost/shop\n",
            support::REPO_CANARY
        );
        write(&repo.join(".env"), &env);
        if let Some(choice) = s.config.choice {
            let parsed = choice_json(choice);
            let mut config = json!({"schema": 1, "catalog": w.catalog_host.url, "mode": "collaborative",
                "service": w.catalog_host.url, "inference": parsed});
            if s.config.session_sync_off {
                config["session_sync"] = json!(false);
            }
            write(
                &repo.join(".unstale/config.json"),
                &serde_json::to_string_pretty(&config).unwrap(),
            );
        }
        if let Some((user, repo_limit)) = s.limits {
            let v = |t: &str| t.parse::<u64>().map(|n| json!(n)).unwrap_or(json!(t));
            write(
                &w.home().join(".config/unstale/config.json"),
                &json!({"monthly_token_limit": v(user)}).to_string(),
            );
            let p = repo.join(".unstale/config.json");
            let mut c: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            c["monthly_token_limit"] = v(repo_limit);
            write(&p, &c.to_string());
        }
        if s.answer == Answer::LimitPartway {
            write(
                &w.home().join(".config/unstale/config.json"),
                r#"{"monthly_token_limit": 1}"#,
            );
        }
        std::fs::create_dir_all(w.base.path().join("bin")).unwrap();
        if s.codex.installed {
            fake_codex(
                &w.base.path().join("bin"),
                &w.codex_dir(),
                s.codex.logged_in,
                &w.codex_backend.url,
                if s.answer == Answer::NotOnPlan { 1 } else { 0 },
            );
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
        for rel in NEVER_OPENED {
            w.sentinels.push(Sentinel::plant(
                &w.home().join(rel),
                &format!("export OPENAI_API_KEY={}\n", support::OTHER_CANARY),
            ));
        }
        // A registry token the client may read (its registry configuration) but must never repeat anywhere.
        write(
            &w.home().join(".npmrc"),
            &format!("//npm.corp.example/:_authToken={}\n", support::OTHER_CANARY),
        );
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
            ("UNSTALE_EDGE_INFERENCE".into(), "1".into()),
            ("LANG".into(), "C.UTF-8".into()),
            (
                "UNSTALE_TEST_SHIM".into(),
                open_logger().display().to_string(),
            ),
            (PRELOAD_VAR.into(), open_logger().display().to_string()),
            (
                "UNSTALE_TEST_OPEN_LOG".into(),
                self.open_log().display().to_string(),
            ),
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
        if !s.registry {
            e.push(("UNSTALE_NO_REGISTRY".into(), "1".into()));
        }
        for k in s.keys.shell {
            e.push((k.to_string(), shell_value(k)));
        }
        for k in s.keys.blank {
            e.push((k.to_string(), "  ".into()));
        }
        for (k, v) in s.invocation.env {
            e.push((k.to_string(), v.to_string()));
        }
        // The chosen route's address moved to the mock provider (the client allows only this machine there).
        let route = chosen(self)
            .and_then(|c| c["provider"].as_str().map(String::from))
            .unwrap_or_default();
        // Not for Codex: its route's address is the `codex` command, which the variable would replace.
        match route.as_str() {
            "codex" => {}
            "anthropic" => e.push((
                "UNSTALE_INFERENCE_BASE_URL".into(),
                self.provider_host.url.clone(),
            )),
            _ => e.push((
                "UNSTALE_INFERENCE_BASE_URL".into(),
                format!("{}/v1", self.provider_host.url),
            )),
        }
        e.push((
            "UNSTALE_LABELS_BASE_URL".into(),
            self.provider_host.url.clone(),
        ));
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
        // The client's own path, as an installed hook names it.
        let exe = PathBuf::from(env!("CARGO_BIN_EXE_unstale"));
        for e in [exe.canonicalize().unwrap_or(exe.clone()), exe] {
            t = t.replace(&e.display().to_string(), "unstale");
        }
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
            .replace(&self.codex_backend.url, "https://codex.example")
            .replace(&self.redirect_target.url, "https://elsewhere.example")
            .replace(&self.trap.url, "http://proxy.example");
        // How long ago something failed depends on how long the scenario took.
        t = regex_lite_minutes(&t);
        t = t
            .replace(&newer_version(), "<newer version>")
            .replace(this_version(), "<this version>");
        // A progress line's elapsed time depends on the machine.
        t.lines()
            .map(|l| match l.rsplit_once(" · ") {
                // The spinner's frame depends on the moment too.
                Some((head, secs))
                    if l.trim_start().starts_with(['◐', '◓', '◑', '◒'])
                        && secs.ends_with('s')
                        && secs[..secs.len() - 1].bytes().all(|b| b.is_ascii_digit()) =>
                {
                    let head = head.replacen(['◓', '◑', '◒'], "◐", 1);
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

/// What `--inference <value>` records, as the repository config stores it (`jev+` before a choice adds the labelling
/// service for labels and matching).
pub(crate) fn choice_json(value: &str) -> serde_json::Value {
    if let Some(rest) = value.strip_prefix("jev+") {
        let mut v = choice_json(rest);
        v["labels"] = json!({"provider": "jev", "key_env": "JEV_API_KEY"});
        return v;
    }
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

/// `3 min ago` → `0 min ago`: a scenario's own age, not its content.
pub(crate) fn regex_lite_minutes(t: &str) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find(" min ago") {
        let head = &rest[..i];
        let digits = head.len() - head.trim_end_matches(|c: char| c.is_ascii_digit()).len();
        out.push_str(&head[..head.len() - digits]);
        out.push_str(if digits > 0 { "0" } else { "" });
        out.push_str(" min ago");
        rest = &rest[i + " min ago".len()..];
    }
    out + rest
}
