"""Sum run_replay.py `metrics` output per split for several catalog conditions -> markdown tables.
    python3 aggregate.py NAME=metrics.json [NAME=metrics.json ...]"""
import json, sys
conds = [a.split("=", 1) for a in sys.argv[1:]]
data = {n: json.load(open(p)) for n, p in conds}
evs = list(next(iter(data.values())))
def tot(rows, evs, cls, f):
    return sum(f(rows[e]["classes"][cls]) for e in evs)
print("## Per split\n")
print("| Split | Catalog | Key (req) | Covered: all / req | In queue: all / req | First 16, tier: all / req | First 16, usage: all / req | First 16, random: all / req | Tier-0 size (sum) | Queue size (sum) |")
print("|---|---|---|---|---|---|---|---|---|---|")
for sp in ("DEV", "HELD-OUT", "ALL"):
    for n, rows in data.items():
        es = [e for e in evs if sp == "ALL" or rows[e]["split"] == sp]
        a = lambda f, c="all": tot(rows, es, c, f)
        print("| %s (%d) | %s | %d (%d) | %d / %d | %d / %d | %d / %d | %d / %d | %d / %d | %d | %d |" % (
            sp, len(es), n, a(lambda r: r["key"]), a(lambda r: r["key"], "required"),
            a(lambda r: r["covered"]), a(lambda r: r["covered"], "required"),
            a(lambda r: r["queued"]), a(lambda r: r["queued"], "required"),
            a(lambda r: r["first16"]["tier"]), a(lambda r: r["first16"]["tier"], "required"),
            a(lambda r: r["first16"]["usage"]), a(lambda r: r["first16"]["usage"], "required"),
            a(lambda r: r["first16"]["random"]), a(lambda r: r["first16"]["random"], "required"),
            sum(rows[e]["tier0"] for e in es), sum(rows[e]["queue_size"] for e in es)))
print("\n## Per event\n")
print("| Event | Split | Catalog | Key (req) | Covered (req) | Either run | In queue (req) | Tier 16 (req) | Usage 16 (req) | Random 16 (req) | Tier 0 | Queue |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|")
for e in evs:
    for n, rows in data.items():
        r = rows[e]; A, R = r["classes"]["all"], r["classes"]["required"]
        print("| %s | %s | %s | %d (%d) | %d (%d) | %d | %d (%d) | %d (%d) | %d (%d) | %d (%d) | %d | %d |" % (
            e, r["split"], n, A["key"], R["key"], A["covered"], R["covered"], A["covered_either"], A["queued"], R["queued"],
            A["first16"]["tier"], R["first16"]["tier"], A["first16"]["usage"], R["first16"]["usage"], A["first16"]["random"], R["first16"]["random"],
            r["tier0"], r["queue_size"]))
