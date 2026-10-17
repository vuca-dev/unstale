"""Population-weighted admission counts under the current rule and candidate refinements (from pop.json)."""
import json
P = json.load(open("pop.json"))
FLOOR = 1000 * 30.44 / 7  # 1k/week as a monthly count (ecosyste.ms reports last-month)


def fresh(p, release_only=False):
    ages = [p["release_age"]] if release_only else [p["release_age"], p["push_age"]]
    ages = [a for a in ages if a is not None]
    return None if not ages else min(ages) <= 365


def current(p):
    f = fresh(p)
    used = [p["downloads_month"] >= FLOOR if p["downloads_month"] is not None else None,
            p["stars"] >= 100 if p["stars"] is not None else None]
    if f is None and all(u is None for u in used):
        return True
    if f is False:
        return False
    if any(u is True for u in used):
        return True
    return all(u is None for u in used)


RULES = {
    "archived repo": lambda p: p["archived"],
    "deprecated/removed": lambda p: p["status"] in ("deprecated", "removed"),
    "fork repo": lambda p: p["fork"],
    "@types/*": lambda p: p["types"],
    "no linked repo": lambda p: not p["has_repo"],
    "fresh by push only (no release in 365d)": lambda p: fresh(p) and not fresh(p, True),
    "0 dependent repos and 0 dependent packages": lambda p: p["dep_repos"] == 0 and p["dep_pkgs"] == 0,
    "admitted by stars only (downloads under floor)": lambda p: (p["downloads_month"] or 0) < FLOOR,
}

if __name__ == "__main__":
    out = {}
    for eco in ("npm", "pypi"):
        tot = {"current": 0.0, **{k: 0.0 for k in RULES}}
        for band, b in P.items():
            if not band.startswith(eco):
                continue
            pk = b["packages"]
            w = b["population"] / len(pk)
            adm = [p for p in pk if current(p)]
            tot["current"] += w * len(adm)
            row = {"population": b["population"], "admitted_share": round(len(adm) / len(pk), 3)}
            for k, f in RULES.items():
                n = sum(1 for p in adm if f(p))
                tot[k] += w * n
                row[k] = round(n / max(1, len(adm)), 3)
            out[band] = row
        out[f"{eco} TOTAL admitted (est.)"] = {k: round(v) for k, v in tot.items()}
    json.dump(out, open("popstats.json", "w"), indent=1)
    for k, v in out.items():
        print(k, v)
