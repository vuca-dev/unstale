#!/usr/bin/env python3
"""Of a full (keyed) report's real findings, how many need no model: the share the client quotes for "no provider".

    deterministic_share.py --harness <copy of the harness> [--arm unstale_raw@0.2.5]

Data: the stored lines of the keyed report arm on the 19 repos (24 October 2026, build 0.2.5) and the frozen pool v3,
in the harness database. No model is called.

Matching rule. A real finding is a frozen pool item the harness credits to the arm (the same `scored_pool` the
published table uses, so the total is the published one). Each report line is tied to the pool items its key belongs
to, by the harness's own key and same-change links. A finding **needs no model** when at least one of the lines tied
to it sits in a section the client builds from deterministic signals alone: Deprecated by the publisher,
Unmaintained, or Lockfile advisories. It is counted once, under the first of those three it appears in, even when
the report also lists it as an upgrade line. Tiers are the frozen pool's.
"""
import argparse, collections, os, sqlite3, sys

ATTEMPTS = [27, 28, 31, 33, 34, 35, 36, 37, 38, 40, 42, 44, 45, 46, 47, 48, 49, 50, 51]
SECTIONS = ('publisher_deprecated', 'unmaintained', 'lockfile_advisories')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--harness', required=True)
    p.add_argument('--arm', default='unstale_raw@0.2.5')
    a = p.parse_args()
    root = os.path.abspath(a.harness)
    sys.path.insert(0, os.path.join(root, 'bin'))
    import ab_common as ab

    def no_model(*_a, **_k):
        raise RuntimeError('this count must not call a model')
    ab.claude_json = ab.codex = no_model
    c = sqlite3.connect(os.path.join(root, 'state', 'scout.db'), timeout=120)
    c.row_factory = sqlite3.Row
    total = collections.Counter(); part = collections.Counter(); part_a = collections.Counter(); own = collections.Counter()
    for at in ATTEMPTS:
        sp = ab.scored_pool(c, at, pool='v3')
        finds = sp['finds'].get(a.arm, set())
        key2f = {}
        for fid, f in sp['pool'].items():
            for k in f['keys']: key2f.setdefault(k, set()).add(fid)
        cluster_of = {k: cid for cid, ks in sp['live_keys'].items() for k in ks}
        cross = collections.defaultdict(set)
        for arm, k, cid, _ in sp['cross_label']:
            if arm == a.arm: cross[k].add(cid)

        def frozen(k):
            ids = set(key2f.get(k, ())) if k in key2f else set(sp['live2frozen'].get(cluster_of.get(k), ()))
            for cid in cross.get(k, ()): ids |= set(key2f.get(k, ())) if k in key2f else set(sp['live2frozen'].get(cid, ()))
            return ids & finds
        sections = collections.defaultdict(list)
        credited = sp['arm_keys'].get(a.arm, set()) | set(cross)
        for it in c.execute('select item_key, section from ab_items where attempt=? and arm=? order by rank', (at, a.arm)):
            if it['item_key'] in credited:
                for fid in frozen(it['item_key']): sections[fid].append(it['section'])
        for fid in finds:
            tier = sp['pool'][fid]['tier']
            total['all'] += 1; total[tier] += 1
            secs = sections.get(fid, [])
            if not secs: total['no line tied'] += 1
            first = next((s for s in SECTIONS if s in secs), None)
            if first:
                part[first] += 1
                if tier == 'A': part_a[first] += 1
                if secs[0] in SECTIONS: own['first line is in a deterministic section'] += 1
    n, na = sum(part.values()), sum(part_a.values())
    print(f"arm {a.arm}, pool v3, {len(ATTEMPTS)} repos")
    print(f"real findings: {total['all']} (tier A {total['A']}, B {total['B']}, C {total['C']}; with no report line tied by these links: {total['no line tied']})")
    print(f"need no model: {n} of {total['all']} = {100 * n / total['all']:.1f}%  " + ', '.join(f'{s} {part[s]}' for s in SECTIONS))
    print(f"act-now (tier A): {na} of {total['A']} = {100 * na / total['A']:.1f}%  " + ', '.join(f'{s} {part_a[s]}' for s in SECTIONS))
    print(f"of those {n}, the finding's first line in the report is itself in one of the three sections: {own['first line is in a deterministic section']}")


if __name__ == '__main__':
    main()
