"""Population frame: how many registry packages clear a monthly-download floor (ecosyste.ms ranking by downloads).
Binary search over the downloads-sorted listing (per_page=1) for the last rank at or above each floor."""
import json, sys
import eco

REGS = {"npm": "npmjs.org", "pypi": "pypi.org"}
WEEK_TO_MONTH = 30.44 / 7


def at(reg, rank):
    d = eco.get(f"https://packages.ecosyste.ms/api/v1/registries/{reg}/packages?sort=downloads&order=desc&per_page=1&page={rank}")
    return d[0] if d else None


def count_at_least(reg, floor, hi=2_000_000):
    lo = 1
    while lo < hi:  # first rank with downloads < floor
        mid = (lo + hi) // 2
        x = at(reg, mid)
        if x is None or (x.get("downloads") or 0) < floor:
            hi = mid
        else:
            lo = mid + 1
    return lo - 1


if __name__ == "__main__":
    out = {}
    for eco_name, reg in REGS.items():
        for weekly in [100, 1_000, 10_000, 100_000, 1_000_000]:
            n = count_at_least(reg, weekly * WEEK_TO_MONTH)
            out[f"{eco_name}>={weekly}/wk"] = n
            print(eco_name, weekly, n, flush=True)
    json.dump(out, open("frame.json", "w"), indent=1)
