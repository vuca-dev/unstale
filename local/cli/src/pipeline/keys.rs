//! Where the model steps read a key: the process environment, and for a variable the stored choice names but the shell
//! does not set, this repository's own `.env` (the user named that variable when choosing, which is the consent).
//! Only that one variable is read, at call time, line by line; nothing else in the file is kept, and the value goes only
//! into the request's auth header. No other file is ever read for a key.

use std::io::BufRead;
use std::path::{Path, PathBuf};

/// The value `name` is given in a `.env` file (`NAME=value` or `export NAME=value`, optionally quoted); the last
/// definition wins, as a shell sourcing the file would leave it.
pub fn dotenv_value(path: &Path, name: &str) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut found = None;
    for line in std::io::BufReader::new(f).lines() {
        let Ok(line) = line else { break };
        let l = line.trim_start();
        let l = l.strip_prefix("export ").map(str::trim_start).unwrap_or(l);
        let Some((k, v)) = l.split_once('=') else {
            continue;
        };
        if k.trim_end() != name {
            continue;
        }
        let v = v.trim();
        let v = match v.chars().next() {
            Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or(""),
            // An unquoted value ends at a comment.
            _ => v.split(" #").next().unwrap_or("").trim_end(),
        };
        found = (!v.is_empty()).then(|| v.to_string());
    }
    found
}

/// A key reader for [`crate::inference::Inference::with_env`] over `env` (the process environment, or a test's):
/// `env` first; for a name in `consented` that `env` leaves unset or empty, `{root}/.env`.
pub fn reader_with(
    root: Option<PathBuf>,
    consented: Vec<String>,
    env: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
) -> impl Fn(&str) -> Option<String> + Send + Sync + 'static {
    move |k: &str| {
        let env = env(k).filter(|v| !v.trim().is_empty());
        if env.is_some() {
            return env;
        }
        // Only a known key variable is ever read from a repository's `.env`, never a proxy or certificate setting.
        crate::setup::route_of(k)?;
        let root = root.as_ref()?;
        let file = root.join(".env");
        // A symlinked `.env` could point anywhere on the machine: only a regular file in the repository is read.
        if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file()) {
            return None;
        }
        consented
            .iter()
            .any(|c| c == k)
            .then(|| dotenv_value(&file, k))
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_named_key_variable_and_nothing_else() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(
            d.path().join(".env"),
            "# comment\nOTHER=nope\nexport OPENAI_API_KEY=\"sk-file\"\nJEV_API_KEY=jv # trailing\nEMPTY=\n",
        )
        .unwrap();
        let p = d.path().join(".env");
        assert_eq!(
            dotenv_value(&p, "OPENAI_API_KEY").as_deref(),
            Some("sk-file")
        );
        assert_eq!(dotenv_value(&p, "JEV_API_KEY").as_deref(), Some("jv"));
        assert_eq!(dotenv_value(&p, "EMPTY"), None);
        assert_eq!(dotenv_value(&p, "MISSING"), None);
        let none = |_: &str| None::<String>;
        std::fs::write(&p, "OPENAI_API_KEY=v1\nJEV_API_KEY=v2\nSSL_CERT_FILE=/tmp/evil.pem\nHTTPS_PROXY=http://evil\n").unwrap();
        let r = reader_with(
            Some(d.path().to_path_buf()),
            vec![
                "OPENAI_API_KEY".into(),
                "SSL_CERT_FILE".into(),
                "HTTPS_PROXY".into(),
            ],
            none,
        );
        assert_eq!(r("OPENAI_API_KEY").as_deref(), Some("v1"));
        assert_eq!(
            r("JEV_API_KEY"),
            None,
            "a key variable the choice does not name is never read from the file"
        );
        assert_eq!(
            r("SSL_CERT_FILE"),
            None,
            "only key variables are read from a repository's .env, even when named"
        );
        assert_eq!(r("HTTPS_PROXY"), None);
        assert_eq!(
            reader_with(None, vec!["OPENAI_API_KEY".into()], none)("OPENAI_API_KEY"),
            None
        );
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().unwrap();
            std::fs::write(
                elsewhere.path().join("other"),
                "OPENAI_API_KEY=from-elsewhere\n",
            )
            .unwrap();
            let linked = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(elsewhere.path().join("other"), linked.path().join(".env"))
                .unwrap();
            let r = reader_with(
                Some(linked.path().to_path_buf()),
                vec!["OPENAI_API_KEY".into()],
                none,
            );
            assert_eq!(
                r("OPENAI_API_KEY"),
                None,
                "a symlinked .env is never followed"
            );
        }
    }
}
