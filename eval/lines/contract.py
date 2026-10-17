"""The edge's availability contract on a published catalog, as a reference for eval scripts. The Rust implementation is local/cli/src/lines.rs; their tests share the cases.

has_change(record_releases, v, index) -> bool | None
  index: the tech index's `releases` (ascending by version; version, date, line, line_start).
  v in the index: line L = its line. Available iff
    (a) a release of the record on L at or before v (index position), or
    (b) L's first release is marked line_start and was published after a release of the record on an older line.
  v not in the index, numeric dotted: L = v's first d components (d = the index lines' depth); (a) by numeric order.
  otherwise (no index, or a version the index cannot place): None (the caller uses the old rule).
"""
import re

NUM = re.compile(r"^\d+(\.\d+)*$")


def key(v):
    return tuple(int(x) for x in v.split("."))


def prefix(v, d):
    p = v.split(".")
    return ".".join(str(int(p[i])) if i < len(p) else "0" for i in range(d))


class Index:
    def __init__(self, releases):
        self.rel = releases
        self.pos = {r["version"]: i for i, r in enumerate(releases)}
        self.depth = len(releases[0]["line"].split(".")) if releases else 0
        self.first = {}
        for i, r in enumerate(releases):
            self.first.setdefault(r["line"], i)

    def line(self, v):
        if v in self.pos:
            return self.rel[self.pos[v]]["line"]
        if self.depth and NUM.match(v):
            return prefix(v, self.depth)
        return None

    def le(self, a, b):
        if a in self.pos and b in self.pos:
            return self.pos[a] <= self.pos[b]
        if NUM.match(a) and NUM.match(b):
            return key(a) <= key(b)
        return None

    def line_before(self, la, lb):
        return key(la) < key(lb)


def has_change(versions, v, idx):
    if not idx.rel:
        return None
    L = idx.line(v)
    if L is None:
        return None
    for r in versions:
        if idx.line(r) == L and idx.le(r, v):
            return True
    f = idx.first.get(L)
    if f is not None and idx.rel[f].get("line_start"):
        start = idx.rel[f]["date"]
        for r in versions:
            lr = idx.line(r)
            if lr and lr != L and idx.line_before(lr, L) and r in idx.pos and idx.rel[idx.pos[r]]["date"] < start:
                return True
    return False


def old_rule(versions, v):
    """Today's edge (funnel.rs pick_release): the earliest release on v's major line (0.minor), else the newest older one."""
    ln = lambda x: (key(x)[0],) if key(x)[0] > 0 else (0, key(x)[1])
    vs = sorted([x for x in versions if NUM.match(x)], key=key)
    if not NUM.match(v):
        return None
    on = [x for x in vs if ln(x) == ln(v)]
    if on:
        return key(on[0]) <= key(v)
    older = [x for x in vs if key(x) <= key(v)]
    return bool(older)
