#![cfg(unix)]
//! Which catalog a repository may read, and what one repository's catalog can leave for another, through the binary.
//!
//! A main repository reads a signed catalog over HTTP. A sibling repository's committed `.unstale/config.json` names a
//! catalog directory inside the sibling. The directory is read only once this machine's user chose it, and even then
//! nothing it gives (catalog files, or records the model steps make from its release notes) reaches the main
//! repository. With the release-notes switch on and off.

#[path = "../src/testcat.rs"]
mod testcat;

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use testcat::{FixtureCatalog, event, rec, with};

const PLANTED: &str = "PLANTED-BY-THE-SIBLING";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One request's head and body.
fn request(s: &mut std::net::TcpStream) -> (String, String) {
    let (mut got, mut buf) = (Vec::new(), [0u8; 65536]);
    loop {
        let k = s.read(&mut buf).unwrap_or(0);
        got.extend_from_slice(&buf[..k]);
        let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
            if k == 0 {
                return (String::new(), String::new());
            }
            continue;
        };
        let head = String::from_utf8_lossy(&got[..end]).to_string();
        let len = head
            .to_ascii_lowercase()
            .lines()
            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
            .unwrap_or(0);
        if k == 0 || got.len() >= end + 4 + len {
            return (head, String::from_utf8_lossy(&got[end + 4..]).to_string());
        }
    }
}

/// Serves a catalog directory's files over HTTP.
fn serve(dir: PathBuf) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (head, _) = request(&mut s);
            let path = head.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
            match std::fs::read(dir.join(&path)) {
                Ok(b) if !path.contains("..") => {
                    let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len());
                    let _ = s.write_all(&b);
                }
                _ => {
                    let _ = write!(s, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
        }
    });
    url
}

/// A model that does what the release notes say: the notes become the record's summary and evidence, and every change
/// is a breaking deprecation. Counts requests.
fn model() -> (String, Arc<Mutex<usize>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let n = Arc::new(Mutex::new(0));
    let count = n.clone();
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let (_, body) = request(&mut s);
            *count.lock().unwrap() += 1;
            let prompt = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["messages"][0]["content"].as_str().map(String::from))
                .unwrap_or_default();
            let content = answer(&prompt);
            let reply = json!({"model": "mock", "choices": [{"message": {"content": content}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}}).to_string();
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
        }
    });
    (url, n)
}

fn answer(prompt: &str) -> String {
    if prompt.starts_with("You extract change records") {
        let notes = prompt.rsplit_once("<notes>\n").and_then(|x| x.1.split_once("\n</notes>")).map(|x| x.0.trim()).unwrap_or("");
        let subject = notes.split_whitespace().next().unwrap_or("change");
        return json!([{"subject": subject, "summary": notes, "change_type": "deprecation", "surface": "code_api", "evidence": notes}]).to_string();
    }
    if prompt.starts_with("You write search terms") {
        let mut out = serde_json::Map::new();
        let mut n = 1;
        while prompt.contains(&format!("\"id\": \"r{n}\"")) {
            out.insert(format!("r{n}"), json!({"terms": ["legacyThing"], "replaces": [], "requires": [], "prerequisites": [], "conditions": []}));
            n += 1;
        }
        return Value::Object(out).to_string();
    }
    if let Some((_, qs)) = prompt.rsplit_once("\nQuestions:\n") {
        let qs: Value = serde_json::from_str(qs.trim()).unwrap_or_default();
        let mut out = serde_json::Map::new();
        for (id, q) in qs.as_object().into_iter().flatten() {
            let options = q["options"].as_object().cloned().unwrap_or_default();
            let pick = if options.contains_key("deprecation") {
                "deprecation".to_string()
            } else if id.contains("breaking") && options.contains_key("yes") {
                "yes".into()
            } else if options.contains_key("no") {
                "no".into()
            } else {
                options.keys().next().cloned().unwrap_or_default()
            };
            out.insert(id.clone(), json!(pick));
        }
        return Value::Object(out).to_string();
    }
    "{}".into()
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A repository using `next` 16.0.0 and calling `legacyThing`.
fn repo(root: &Path) {
    write(&root.join("package.json"), r#"{"name":"app","version":"1.0.0","dependencies":{"next":"16.0.0"}}"#);
    write(
        &root.join("package-lock.json"),
        r#"{"name":"app","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"app","version":"1.0.0","dependencies":{"next":"16.0.0"}},"node_modules/next":{"version":"16.0.0","resolved":"https://registry.npmjs.org/next/-/next-16.0.0.tgz"}}}"#,
    );
    write(&root.join("src/app.js"), "import { legacyThing } from 'next';\nlegacyThing();\n");
    std::fs::create_dir_all(root.join(".git")).unwrap();
}

struct World {
    dir: tempfile::TempDir,
    key: String,
    signed: String,
    provider: String,
    calls: Arc<Mutex<usize>>,
    _real: FixtureCatalog,
}

impl World {
    fn new() -> World {
        use ring::signature::{Ed25519KeyPair, KeyPair};
        let dir = tempfile::tempdir().unwrap();
        // The signed catalog: one genuine record, for a later release than the sibling's planted one.
        let real = FixtureCatalog::new();
        let genuine = with(
            rec("next:genuine", "pkg:npm/next", "16.2.0"),
            json!({"change_type": "deprecation", "breaking": true, "summary": "The genuine record.", "terms": [["legacyThing", 0]]}),
        );
        real.tech("next", &[("16", vec![genuine])]);
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        for rel in ["v1/root.json", "v1/tech/next.json"] {
            let sig = hex(pair.sign(&std::fs::read(real.dir.path().join(rel)).unwrap()).as_ref());
            std::fs::write(real.dir.path().join(format!("{rel}.sig")), sig).unwrap();
        }
        let signed = serve(real.dir.path().to_path_buf());
        let (provider, calls) = model();
        let w = World { key: hex(pair.public_key().as_ref()), dir, signed, provider, calls, _real: real };
        repo(&w.path("main"));
        repo(&w.path("sibling"));
        // The sibling's own catalog directory, and the committed config that names it and a provider.
        let cat = w.path("sibling/docs/cat");
        write(&cat.join("v1/root.json"), &format!(r#"{{"schema":1,"min_client":"0.1.0","notice":{{"id":"n","until":"2099-01-01","text":"{PLANTED} notice"}}}}"#));
        let planted = FixtureCatalog::new();
        let record = with(
            rec("next:planted", "pkg:npm/next", "16.0.5"),
            json!({"change_type": "deprecation", "breaking": true, "summary": format!("{PLANTED} record."), "terms": [["legacyThing", 0]]}),
        );
        planted.tech_events("next", 0, &[("16", vec![record])], &[("16", vec![event("next", "16.1.0", &format!("legacyThing is deprecated. {PLANTED} note."))])]);
        copy(&planted.dir.path().join("v1/tech"), &cat.join("v1/tech"));
        copy(&planted.dir.path().join("v1/shards"), &cat.join("v1/shards"));
        w
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    fn sibling_config(&self, catalog: &str) {
        write(
            &self.path("sibling/.unstale/config.json"),
            &json!({"schema": 1, "catalog": catalog, "mode": "collaborative", "inference": {"provider": "openai", "key_env": "OPENAI_API_KEY"}}).to_string(),
        );
        write(&self.path("sibling/.unstale/ledger.jsonl"), "{\"schema\":1}\n");
    }

    /// Runs the client in `repo` as this machine's user would: no development setting.
    fn run(&self, repo: &str, args: &[&str], switch: bool) -> (bool, String) {
        let (home, config) = (self.path("home"), self.path("config"));
        self.run_with(repo, args, switch, &[("HOME", home.to_str().unwrap()), ("UNSTALE_CONFIG_DIR", config.to_str().unwrap())])
    }

    /// [`World::run`] with the variables that place the user's config given by the caller.
    fn run_with(&self, repo: &str, args: &[&str], switch: bool, env: &[(&str, &str)]) -> (bool, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_unstale"));
        c.args(args)
            .current_dir(self.path(repo))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .envs(env.iter().copied())
            .env("UNSTALE_CACHE_DIR", self.path("cache"))
            .env("UNSTALE_CATALOG_KEY", &self.key)
            .env("UNSTALE_TODAY", "2026-11-10")
            .env("UNSTALE_NO_REGISTRY", "1")
            .env("OPENAI_API_KEY", "not-a-real-key")
            .env("UNSTALE_INFERENCE_BASE_URL", format!("{}/v1", self.provider))
            .stdin(std::process::Stdio::null());
        if switch {
            c.env("UNSTALE_EDGE_INFERENCE", "1");
        }
        let out = c.output().unwrap();
        (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }

    fn ok(&self, repo: &str, args: &[&str], switch: bool) -> String {
        let (ok, out) = self.run(repo, args, switch);
        assert!(ok, "{repo} {args:?}: {out}");
        out
    }

    /// Everything the main repository is shown, and the files of the cache it reads (its own catalog's).
    fn main_sees(&self, switch: bool) -> String {
        let written = || -> String {
            files(&self.path("main/.unstale")).iter().map(|f| String::from_utf8_lossy(&std::fs::read(f).unwrap_or_default()).to_string()).collect()
        };
        let mut seen = self.ok("main", &["run"], switch);
        seen += &written();
        // Past the first batch, where a second record would be.
        let _ = self.run("main", &["record", "next:genuine", "no-site"], switch);
        seen += &self.run("main", &["review", "--next", "--pass", "upgrade-review"], switch).1;
        seen + &written()
    }

    /// The per-user cache without the folders of unsigned sources: path → bytes.
    fn shared_cache(&self) -> Vec<(PathBuf, Vec<u8>)> {
        files(&self.path("cache"))
            .into_iter()
            .filter(|p| {
                let rel = p.strip_prefix(self.path("cache")).unwrap();
                !rel.starts_with("unsigned") && (rel.starts_with("v1") || rel.starts_with("inference/records"))
            })
            .map(|p| (p.clone(), std::fs::read(&p).unwrap_or_default()))
            .collect()
    }
}

fn copy(from: &Path, to: &Path) {
    for f in files(from) {
        let dest = to.join(f.strip_prefix(from).unwrap());
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(&f, &dest).unwrap();
    }
}

fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(files(&p));
        } else {
            out.push(p);
        }
    }
    out.sort();
    out
}

#[test]
fn a_catalog_directory_a_repository_names_is_not_read_until_the_user_chooses_it() {
    for switch in [false, true] {
        let w = World::new();
        w.ok("main", &["init", "--catalog", &w.signed, "--yes"], switch);
        let first = w.main_sees(switch);
        assert!(first.contains("The genuine record."), "{first}");
        let before = w.shared_cache();
        let absolute = w.path("sibling/docs/cat").canonicalize().unwrap();
        // As committed (a path inside the repository), and as an absolute path: neither is this user's choice.
        for catalog in ["docs/cat", absolute.to_str().unwrap(), &format!("file://{}", absolute.display())] {
            w.sibling_config(catalog);
            for cmd in [&["sync"][..], &["run"], &["session-sync"], &["review"], &["init", "--yes"]] {
                let (ok, out) = w.run("sibling", cmd, switch);
                assert!(!ok, "switch {switch}, {catalog}, {cmd:?}: {out}");
                assert!(
                    out.contains("names a catalog directory") && out.contains("that you have not chosen on this machine, so it is not read. If it is yours, run `unstale init --catalog <dir>`."),
                    "{out}"
                );
            }
            // Session start says nothing and reads nothing.
            let (ok, out) = w.run("sibling", &["notify"], switch);
            assert!(ok && out.trim().is_empty(), "{out}");
        }
        assert_eq!(*w.calls.lock().unwrap(), 0, "no release note of an unchosen directory is sent to a model");
        assert_eq!(w.shared_cache(), before, "switch {switch}: the shared cache is as it was");
        assert!(!w.main_sees(switch).contains(PLANTED));
    }
}

#[test]
fn a_chosen_catalog_directory_leaves_nothing_for_a_repository_on_the_signed_catalog() {
    for switch in [false, true] {
        let w = World::new();
        w.ok("main", &["init", "--catalog", &w.signed, "--yes"], switch);
        let first = w.main_sees(switch);
        assert!(first.contains("The genuine record."), "{first}");
        let before = w.shared_cache();
        assert!(!before.is_empty());
        // The user chooses the directory themselves: it is read, in a cache of its own.
        w.sibling_config("docs/cat");
        let dir = w.path("sibling/docs/cat");
        w.ok("sibling", &["init", "--catalog", dir.to_str().unwrap(), "--yes"], switch);
        w.ok("sibling", &["run"], switch);
        // The provider the sibling's config names is a suggestion: the user makes the choice theirs.
        w.ok("sibling", &["setup", "--inference", "env:OPENAI_API_KEY"], switch);
        w.ok("sibling", &["session-sync"], switch);
        if switch {
            assert!(*w.calls.lock().unwrap() > 0, "the chosen directory's release notes are read");
            let made = files(&w.path("cache/unsigned")).into_iter().any(|p| p.ends_with("inference/records/next.json"));
            assert!(made, "its records are kept with it");
        }
        let sibling = files(&w.path("sibling/.unstale")).iter().map(|f| String::from_utf8_lossy(&std::fs::read(f).unwrap_or_default()).to_string()).collect::<String>();
        assert!(sibling.contains(PLANTED), "the sibling reads its own catalog");
        assert_eq!(w.shared_cache(), before, "switch {switch}: nothing of it is in the cache the signed catalog's repositories read");
        let seen = w.main_sees(switch);
        assert!(!seen.contains(PLANTED), "switch {switch}: {seen}");
        // `cache clean` removes the directory's cache too: what it says it removed is everything.
        if switch {
            // Files written in the last few minutes are never removed: these are an hour old.
            let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
            for f in files(&w.path("cache/unsigned")) {
                if let Ok(file) = std::fs::File::options().write(true).open(&f) {
                    let _ = file.set_modified(hour_ago);
                }
            }
            let out = w.ok("main", &["cache", "clean", "--results", "--yes"], switch);
            assert!(out.contains("A catalog directory's cache"), "{out}");
            let left: Vec<PathBuf> = files(&w.path("cache/unsigned"))
                .into_iter()
                .filter(|p| p.to_string_lossy().contains("/v1/shards/") || p.to_string_lossy().contains("/inference/"))
                .collect();
            assert!(left.is_empty(), "{out}\n{left:?}");
        }
        // The approval is the user's own, by canonical path; another directory stays refused.
        let config = std::fs::read_to_string(w.path("config/config.json")).unwrap();
        assert!(config.contains(dir.canonicalize().unwrap().to_str().unwrap()), "{config}");
    }
}

#[test]
fn a_catalog_address_a_repository_names_is_checked_against_the_catalog_key() {
    let w = World::new();
    w.ok("main", &["init", "--catalog", &w.signed, "--yes"], true);
    w.main_sees(true);
    let before = w.shared_cache();
    // The sibling's files over HTTP, signed by nobody: nothing of them is used, here or anywhere.
    let unsigned = serve(w.path("sibling/docs/cat"));
    w.sibling_config(&unsigned);
    for cmd in [&["sync"][..], &["session-sync"]] {
        let (_, out) = w.run("sibling", cmd, true);
        assert!(!out.contains(PLANTED), "{out}");
    }
    assert_eq!(*w.calls.lock().unwrap(), 0);
    assert_eq!(w.shared_cache(), before);
    assert!(!w.main_sees(true).contains(PLANTED));
}

/// With no place for a user config (no `HOME`, no config directory named, or only empty or relative ones), there is no
/// user config: a file a repository commits at `unstale/config.json` is never read as one. It approves no catalog
/// directory and is nobody's provider choice, and nothing is saved into the repository in its place.
#[test]
fn a_file_in_the_repository_is_never_the_users_config() {
    let w = World::new();
    let dir = w.path("sibling/docs/cat").canonicalize().unwrap();
    w.sibling_config(dir.to_str().unwrap());
    let planted = json!({"catalog_directories": [dir], "inference": {"provider": "openai", "key_env": "OPENAI_API_KEY"}}).to_string();
    for at in ["unstale/config.json", ".config/unstale/config.json", "config.json"] {
        write(&w.path("sibling").join(at), &planted);
    }
    for env in [&[][..], &[("XDG_CONFIG_HOME", "")], &[("HOME", ""), ("XDG_CONFIG_HOME", "")], &[("HOME", "."), ("UNSTALE_CONFIG_DIR", ".")]] {
        // It approves nothing: the directory stays refused.
        let (ok, out) = w.run_with("sibling", &["session-sync"], true, env);
        assert!(!ok && out.contains("that you have not chosen on this machine"), "{env:?}: {out}");
        // With the directory read all the same (the development setting), it is nobody's choice of provider.
        let mut dev = env.to_vec();
        dev.push(("UNSTALE_DEV_UNSIGNED_CATALOG", "1"));
        let (_, out) = w.run_with("sibling", &["session-sync"], true, &dev);
        assert!(!out.contains("New release notes read"), "{env:?}: {out}");
        // And nothing is saved in its place.
        let (ok, out) = w.run_with("sibling", &["setup", "--inference", "env:OPENAI_API_KEY"], true, &dev);
        assert!(!ok && out.contains("HOME is not set"), "{env:?}: {out}");
        for at in ["unstale/config.json", ".config/unstale/config.json", "config.json"] {
            assert_eq!(std::fs::read_to_string(w.path("sibling").join(at)).unwrap(), planted, "{env:?} {at}");
        }
    }
    assert_eq!(*w.calls.lock().unwrap(), 0, "no request to a provider");
}
