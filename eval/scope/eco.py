"""Cached GET helpers for the scope track (ecosyste.ms, npm, PyPI, GitHub). Raw responses cached under cache/."""
import hashlib, json, os, subprocess, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
UA = "unstale-scope-research (github.com/unstale-ai/unstale)"
_gh = None


def gh_token():
    global _gh
    if _gh is None:
        _gh = os.environ.get("GITHUB_TOKEN") or subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()
    return _gh


def get(url, kind="json", headers=None, retries=4, sleep=0.0):
    """GET with an on-disk cache keyed by url. Returns parsed JSON (or text), or None on 404/persistent failure."""
    key = hashlib.sha256(url.encode()).hexdigest()
    path = os.path.join(CACHE, key[:2], key + (".json" if kind == "json" else ".txt"))
    if os.path.exists(path):
        raw = open(path).read()
        if raw == "__404__":
            return None
        return json.loads(raw) if kind == "json" else raw
    h = {"User-Agent": UA, **(headers or {})}
    if "api.github.com" in url and gh_token():
        h["Authorization"] = f"Bearer {gh_token()}"
    for a in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=60) as r:
                raw = r.read().decode("utf8", "replace")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w").write(raw)
            if sleep:
                time.sleep(sleep)
            return json.loads(raw) if kind == "json" else raw
        except urllib.error.HTTPError as e:
            if e.code in (404, 410, 422):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, "w").write("__404__")
                return None
            time.sleep(2 * 2 ** a + (30 if e.code in (403, 429) else 0))
        except Exception:
            time.sleep(2 * 2 ** a)
    return None
