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

/// A key reader for [`crate::inference::Inference::with_env`]: the process environment first; for a name in
/// `consented` that the environment leaves unset or empty, `{root}/.env`.
pub fn reader(
    root: Option<PathBuf>,
    consented: Vec<String>,
) -> impl Fn(&str) -> Option<String> + Send + Sync + 'static {
    move |k: &str| {
        let env = std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        if env.is_some() {
            return env;
        }
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
    fn reads_one_named_variable_and_nothing_else() {
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
        let r = reader(
            Some(d.path().to_path_buf()),
            vec!["UNSTALE_TEST_CONSENTED_KEY".into()],
        );
        std::fs::write(
            d.path().join(".env"),
            "UNSTALE_TEST_CONSENTED_KEY=v1\nUNSTALE_TEST_OTHER_KEY=v2\n",
        )
        .unwrap();
        assert_eq!(r("UNSTALE_TEST_CONSENTED_KEY").as_deref(), Some("v1"));
        assert_eq!(
            r("UNSTALE_TEST_OTHER_KEY"),
            None,
            "a variable the choice does not name is never read from the file"
        );
        #[cfg(unix)]
        {
            let elsewhere = tempfile::tempdir().unwrap();
            std::fs::write(
                elsewhere.path().join("other"),
                "UNSTALE_TEST_CONSENTED_KEY=from-elsewhere\n",
            )
            .unwrap();
            let linked = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(elsewhere.path().join("other"), linked.path().join(".env"))
                .unwrap();
            let r = reader(
                Some(linked.path().to_path_buf()),
                vec!["UNSTALE_TEST_CONSENTED_KEY".into()],
            );
            assert_eq!(
                r("UNSTALE_TEST_CONSENTED_KEY"),
                None,
                "a symlinked .env is never followed"
            );
        }
        assert_eq!(
            reader(None, vec!["UNSTALE_TEST_CONSENTED_KEY".into()])("UNSTALE_TEST_CONSENTED_KEY"),
            None
        );
    }
}
