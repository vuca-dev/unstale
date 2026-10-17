"""Population signals per download band: random 100-package pages of the downloads-sorted ecosyste.ms listing.
Shares of packages passing each admission rule and carrying each weakness (archived, fork, deprecated, @types, ...)."""
import json, random, datetime as dt
import eco

NOW = dt.datetime(2026, 10, 16, tzinfo=dt.timezone.utc)
REG = {"npm": "npmjs.org", "pypi": "pypi.org"}
frame = json.load(open("frame.json"))
BANDS = [("b0 100-1k/wk", 100, 1_000), ("b1 1k-10k/wk", 1_000, 10_000), ("b2 10k-100k/wk", 10_000, 100_000),
         ("b3 100k-1M/wk", 100_000, 1_000_000), ("b4 >=1M/wk", 1_000_000, None)]
PAGES = {"b0": 6, "b1": 8, "b2": 6, "b3": 4, "b4": 3}


def days(s):
    if not s:
        return None
    return (NOW - dt.datetime.fromisoformat(s.replace("Z", "+00:00"))).days


def band_ranks(e, lo, hi):
    top = 1 if hi is None else frame[f"{e}>={hi}/wk"] + 1
    bottom = frame[f"{e}>={lo}/wk"]
    return top, bottom


def sample_band(e, key, lo, hi, rng):
    top, bottom = band_ranks(e, lo, hi)
    pages = sorted(rng.sample(range((top - 1) // 100 + 1, bottom // 100 + 1), PAGES[key[:2]]))
    pk = []
    for p in pages:
        d = eco.get(f"https://packages.ecosyste.ms/api/v1/registries/{REG[e]}/packages?sort=downloads&order=desc&per_page=100&page={p}") or []
        pk += [x for x in d if top <= 0 or True]
    return pk, top, bottom


def signals(x):
    rm = x.get("repo_metadata") or {}
    rel = days(x.get("latest_release_published_at"))
    push = days(rm.get("pushed_at"))
    stars = rm.get("stargazers_count")
    return {
        "name": x["name"], "downloads_month": x.get("downloads"), "status": x.get("status"),
        "repo": rm.get("full_name") or (x.get("repository_url") or ""), "has_repo": bool(rm),
        "archived": bool(rm.get("archived")), "fork": bool(rm.get("fork")), "stars": stars,
        "release_age": rel, "push_age": push, "dep_repos": x.get("dependent_repos_count") or 0,
        "dep_pkgs": x.get("dependent_packages_count") or 0, "versions": x.get("versions_count"),
        "types": x["name"].startswith("@types/") or x["name"].startswith("types-"),
    }


if __name__ == "__main__":
    rng = random.Random(16102026)
    out = {}
    for e in REG:
        for key, lo, hi in BANDS:
            pk, top, bottom = sample_band(e, key, lo, hi, rng)
            out[f"{e} {key}"] = {"ranks": [top, bottom], "population": bottom - top + 1, "packages": [signals(x) for x in pk]}
            print(e, key, bottom - top + 1, len(pk), flush=True)
    json.dump(out, open("pop.json", "w"))
