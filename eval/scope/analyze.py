"""Scope analysis: records per technology-quarter (median, percentiles, mean) per ecosystem, per fleet tier and
population-weighted; cost per technology-quarter and -year; the effect of each candidate admission rule."""
import json, math, sys

FIT = json.load(open("calib_fit.json"))
FLOOR = 1000 * 30.44 / 7
# Per-step $ per mean technology-year at R = 114.6 (A+B on N_mean = 6,462 note tokens, cost.mts): A+B 38% input
# (scales with notes), 62% output (scales with records); D and E scale with records.
AB, D, E, RM, NM = 0.0192, 0.0100, 0.0110, 114.6, 6462


def records(n):
    return 0.0 if not n else math.exp(FIT["a"] + FIT["b"] * math.log(n))


def cost(n, r):
    return AB * (0.38 * n / NM + 0.62 * r / RM) + (D + E) * r / RM


def wq(vals, ws, q):
    pts = sorted(zip(vals, ws))
    tot = sum(ws)
    acc = 0
    for v, w in pts:
        acc += w
        if acc >= q * tot:
            return v
    return pts[-1][0]


def summarise(rows, label):
    ws = [r["tw"] for r in rows]
    rq = [r["R"] / 4 for r in rows]
    cy = [r["cost"] for r in rows]
    if not rows:
        return None
    return {"group": label, "n": len(rows), "technologies_est": round(sum(ws)), "packages_est": round(sum(r["w"] for r in rows)),
            "records/quarter": {k: round(wq(rq, ws, q), 1) for k, q in [("p50", .5), ("p75", .75), ("p90", .9), ("p99", .99)]} | {"mean": round(sum(a * b for a, b in zip(rq, ws)) / sum(ws), 1)},
            "$/tech-quarter": {"p50": round(wq(cy, ws, .5) / 4, 5), "p90": round(wq(cy, ws, .9) / 4, 5), "mean": round(sum(a * b for a, b in zip(cy, ws)) / sum(ws) / 4, 5)},
            "$/tech-year mean": round(sum(a * b for a, b in zip(cy, ws)) / sum(ws), 5),
            "share with no notes": round(sum(w for r, w in zip(rows, ws) if not r.get("notes_tokens")) / sum(ws), 3)}


def borrowed(r):
    """Stars and pushes borrowed: the package is not its repository's main package (under 1% of the top package's
    downloads among packages pointing at that repository)."""
    import urllib.parse, eco
    if "/" not in (r.get("repo") or ""):
        return False
    d = eco.get(f"https://packages.ecosyste.ms/api/v1/packages/lookup?repository_url={urllib.parse.quote('https://github.com/' + r['repo'], safe='')}") or []
    top = max([x.get("downloads") or 0 for x in d] or [0])
    return top > 0 and (r.get("downloads_month") or 0) < 0.01 * top


FLAGS = {
    "not the repository's main package (<1% of its downloads)": lambda r: r["borrowed"],
    "stars-only AND not the main package (borrowed stars)": lambda r: r["borrowed"] and (r.get("downloads_month") or 0) < FLOOR,
    "archived repo": lambda r: r.get("archived"),
    "deprecated / inactive / all yanked": lambda r: r.get("deprecated") or r.get("status") in ("deprecated", "removed") or r.get("inactive") or r.get("all_yanked"),
    "fork repo": lambda r: r.get("fork"),
    "@types/* or types-*": lambda r: r.get("types"),
    "no stable release in 365d (fresh by push only)": lambda r: (r.get("stable_releases") or 0) == 0,
    "no human commit in 365d": lambda r: r.get("human_commits") == 0,
    "admitted on stars only": lambda r: (r.get("downloads_month") or 0) < FLOOR,
    "0 dependents (repos and packages)": lambda r: not r.get("dep_repos") and not r.get("dep_pkgs"),
    "no release notes found": lambda r: not r.get("notes_tokens"),
}

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "deep.json"
    rows = [r for r in json.load(open(src)) if "error" not in r]
    for r in rows:
        r["w"] = r["weight"]
        r["R"] = records(r.get("notes_tokens") or 0)
        r["cost"] = cost(r.get("notes_tokens") or 0, r["R"])
        r["shared_notes"] = (r.get("multiplicity") or 1) > 1 and not r.get("per_package_tags")
        # The technology unit: packages published from one repository with one tag stream are one technology.
        r["tw"] = r["w"] / r["multiplicity"] if r["shared_notes"] else r["w"]
        r["borrowed"] = borrowed(r)
    out = {"source": src, "fit": FIT, "groups": [], "flags": {}, "tiers": []}
    for eco in ("npm", "pypi"):
        er = [r for r in rows if r["eco"] == eco]
        out["groups"].append(summarise(er, f"{eco}: all admitted (registry-wide)"))
        for band in sorted({r["band"] for r in er}):
            out["groups"].append(summarise([r for r in er if r["band"] == band], band))
    out["groups"].append(summarise(rows, "npm + pypi: all admitted (registry-wide)"))
    # Fleet tiers: a demand-driven fleet of K distinct technologies is roughly the top K by usage.
    tiers = {"~10k fleet (>=1M/wk)": ["b4"], "~50k fleet (>=100k/wk, + top of 10k-100k)": ["b4", "b3", "b2"], "~200k fleet (>=1k/wk)": ["b4", "b3", "b2", "b1"]}
    for name, bands in tiers.items():
        out["tiers"].append(summarise([r for r in rows if r["band"].split()[1] in bands], name))
    tot_w = sum(r["w"] for r in rows)
    tot_t = sum(r["tw"] for r in rows)
    tot_c = sum(r["tw"] * r["cost"] for r in rows)
    tot_r = sum(r["tw"] * r["R"] for r in rows)
    for k, f in FLAGS.items():
        hit = [r for r in rows if f(r)]
        out["flags"][k] = {"packages_share": round(sum(r["w"] for r in hit) / tot_w, 3), "technologies_share": round(sum(r["tw"] for r in hit) / tot_t, 3),
                           "records_share": round(sum(r["tw"] * r["R"] for r in hit) / tot_r, 3),
                           "cost_share": round(sum(r["tw"] * r["cost"] for r in hit) / tot_c, 3), "n_sample": len(hit)}
    out["packages_est"] = round(tot_w)
    out["technologies_est (shared tag streams deduped)"] = round(tot_t)
    out["registry-wide $/year (all admitted technologies)"] = round(tot_c, 0)
    json.dump(out, open(src.replace(".json", "-analysis.json"), "w"), indent=1)
    for g in out["groups"] + out["tiers"]:
        print(g)
    for k, v in out["flags"].items():
        print(k, v)
    print("packages", out["packages_est"], "technologies", out["technologies_est (shared tag streams deduped)"], "registry-wide $/yr", out["registry-wide $/year (all admitted technologies)"])


def bootstrap(rows, bands, B=2000, seed=1):
    """Stratified bootstrap (within band) of the technology-weighted mean and median records per quarter, and mean $/year."""
    import random
    rng = random.Random(seed)
    by = {}
    for r in rows:
        if r["band"].split()[1] in bands:
            by.setdefault(r["band"], []).append(r)
    means, meds, costs = [], [], []
    for _ in range(B):
        s = []
        for band, rs in by.items():
            tot = sum(r["tw"] for r in rs)
            pick = [rng.choice(rs) for _ in rs]
            k = tot / max(1e-9, sum(r["tw"] for r in pick))
            s += [dict(r, tw=r["tw"] * k) for r in pick]
        ws = [r["tw"] for r in s]
        means.append(sum(r["R"] / 4 * r["tw"] for r in s) / sum(ws))
        meds.append(wq([r["R"] / 4 for r in s], ws, .5))
        costs.append(sum(r["cost"] * r["tw"] for r in s) / sum(ws))
    ci = lambda v: [round(sorted(v)[int(.025 * B)], 4), round(sorted(v)[int(.975 * B)], 4)]
    return {"mean records/quarter 95% CI": ci(means), "median records/quarter 95% CI": ci(meds), "mean $/tech-year 95% CI": ci(costs)}
