"""Shared helpers for the majors held-out set (PREREG.md). Standard library plus the `gh` CLI; no model calls.
Every network read is cached under eval/select/out/holdout-majors/cache/ so a rerun reads the same bytes."""
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
OUT = os.path.join(ROOT, "eval/select/out/holdout-majors")
CACHE = os.path.join(OUT, "cache")
SEED = "unstale-majors-v1"
WINDOW = "2025-10-15"


def H(kind, i):
    return hashlib.sha256(f"{SEED}:{kind}:{i}".encode()).hexdigest()


def _cache_path(key):
    return os.path.join(CACHE, hashlib.sha256(key.encode()).hexdigest()[:32])


def _cached(key, fetch):
    p = _cache_path(key)
    if os.path.exists(p):
        with open(p, encoding="utf8") as fh:
            d = json.load(fh)
        return d["status"], d["body"]
    status, body = fetch()
    if status in (200, 404):
        os.makedirs(CACHE, exist_ok=True)
        with open(p, "w", encoding="utf8") as fh:
            json.dump({"key": key, "status": status, "body": body}, fh)
    return status, body


def http_get(url):
    """(status, text). 404 -> (404, None)."""
    def fetch():
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "unstale-eval/1 (held-out set build)", "Accept": "application/json, text/plain, */*"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return 200, r.read().decode("utf8", errors="replace")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return 404, None
                if attempt == 3:
                    return e.code, None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 3:
                    return 0, None
            time.sleep(2 * (attempt + 1))
        return 0, None
    return _cached("GET " + url, fetch)


def gh(path):
    """(status, parsed JSON) for `gh api <path>`; 404 -> (404, None)."""
    def fetch():
        for attempt in range(3):
            p = subprocess.run(["gh", "api", path], capture_output=True, text=True)
            if p.returncode == 0:
                return 200, json.loads(p.stdout)
            if "Not Found" in p.stderr or "HTTP 404" in p.stderr:
                return 404, None
            if "HTTP 409" in p.stderr:  # empty repository
                return 404, None
            time.sleep(3 * (attempt + 1))
        return 1, None
    return _cached("GH " + path, fetch)


def repo_head(repo):
    """(default branch, HEAD commit sha) of a repository."""
    s, r = gh(f"repos/{repo}")
    if s != 200:
        return None, None
    br = r["default_branch"]
    s, c = gh(f"repos/{repo}/commits/{urllib.parse.quote(br, safe='')}")
    return br, (c or {}).get("sha")


def tree(repo, sha):
    """[(path, size)] of blobs at a commit (recursive), and whether GitHub truncated the listing."""
    s, t = gh(f"repos/{repo}/git/trees/{sha}?recursive=1")
    if s != 200:
        return [], False
    return [(e["path"], e.get("size", 0)) for e in t["tree"] if e["type"] == "blob"], bool(t.get("truncated"))


def raw(repo, sha, path):
    s, txt = http_get(f"https://raw.githubusercontent.com/{repo}/{sha}/{urllib.parse.quote(path)}")
    return txt if s == 200 else None

# ---------------------------------------------------------------- headings (Markdown and reStructuredText)

MD_HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
RST_ADORN = re.compile(r"^([=\-~^*+#`'\":.<>_!$%&(),/;?@\[\]{|}])\1{2,}\s*$")


def headings(text):
    """[(line_index, level, title, end_line_index_exclusive_of_heading)] in order. Markdown `#` levels are 1-6; rst levels
    are numbered 1.. by first appearance of their adornment style (char, overline). Fenced code blocks are skipped."""
    lines = text.split("\n")
    out = []
    styles = []
    fence = None
    i = 0
    while i < len(lines):
        l = lines[i].rstrip("\r")
        st = l.strip()
        f = re.match(r"^(```+|~~~+)", st)
        if f:
            if fence is None:
                fence = f.group(1)[0] * 3
            elif st.startswith(fence):
                fence = None
            i += 1
            continue
        if fence is not None:
            i += 1
            continue
        m = MD_HEAD.match(l)
        if m:
            out.append((i, len(m.group(1)), m.group(2).strip()))
            i += 1
            continue
        # rst: overline + title + underline
        if RST_ADORN.match(l) and i + 2 < len(lines):
            t, u = lines[i + 1].rstrip("\r"), lines[i + 2].rstrip("\r")
            if t.strip() and RST_ADORN.match(u) and u.strip()[0] == st[0] and len(u.strip()) >= len(t.strip()):
                key = (st[0], True)
                if key not in styles:
                    styles.append(key)
                out.append((i, 100 + styles.index(key), t.strip()))
                i += 3
                continue
        # rst: title + underline
        if st and i + 1 < len(lines) and not RST_ADORN.match(l):
            u = lines[i + 1].rstrip("\r")
            if RST_ADORN.match(u) and len(u.strip()) >= max(3, len(st)) and not l.startswith(" "):
                key = (u.strip()[0], False)
                if key not in styles:
                    styles.append(key)
                out.append((i, 100 + styles.index(key), st))
                i += 2
                continue
        i += 1
    return out


def section(text, start_line):
    """Lines from the heading at start_line to the next heading of the same or a higher level (exclusive)."""
    hs = headings(text)
    lines = text.split("\n")
    lvl = next(h[1] for h in hs if h[0] == start_line)
    end = len(lines)
    for ln, lv, _ in hs:
        if ln > start_line and lv <= lvl:
            end = ln
            break
    return "\n".join(lines[start_line:end]).rstrip() + "\n"


def version_re(versions):
    alts = "|".join(re.escape(v) for v in sorted(versions, key=len, reverse=True))
    return re.compile(r"(?<![\w.])v?(?:%s)(?![0-9A-Za-z]|\.[0-9])" % alts)


def release_clean(body):
    """The pipeline's release `clean` (central/src/pipeline/technologies.ts noCredits)."""
    return re.sub(r"\n#+\s*Credits[\s\S]*$", "", body)
