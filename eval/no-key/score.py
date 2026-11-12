#!/usr/bin/env python3
"""Score the no-key arm against the reused agent-alone arm on the frozen pool, by the pre-registered rule.

    score.py --harness <copy of the harness> [--json]

Reads the harness's database (no model call): per repo, real finds (tier A or B, matched to the frozen pool v3),
tier-A finds, client tokens and top-8 precision for both arms; pooled totals; 5th to 95th percentiles over 2,000
resamples of the repos (seed 20261023, the same draw for both arms); the two gates; the reading-matter multiple from
each repo's prepare.json; and how many of the new arm's real finds name a package that the no-key report lists in a
section built from deterministic signals.
"""
import argparse, json, os, random, re, sqlite3, sys

ARM, ALONE, POOL = 'naive-plain+nokey@3x', 'naive-plain@3x', 'v3'
ATTEMPTS = [27, 28, 31, 33, 34, 35, 36, 37, 38, 40, 42, 44, 45, 46, 47, 48, 49, 50, 51]
DETERMINISTIC = ('Deprecated by the publisher', 'Unmaintained, not deprecated', 'Lockfile advisories')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--harness', required=True)
    p.add_argument('--json', action='store_true')
    a = p.parse_args()
    root = os.path.abspath(a.harness)
    sys.path.insert(0, os.path.join(root, 'bin'))
    import ab_common as ab

    def no_model(*_a, **_k):
        raise RuntimeError('scoring must not call a model')
    ab.claude_json = ab.codex = no_model
    c = sqlite3.connect(os.path.join(root, 'state', 'scout.db'), timeout=120)
    c.row_factory = sqlite3.Row
    rep = ab.report(c, arms=(ALONE, ARM), attempts=ATTEMPTS, pool=POOL)
    rows = []
    for r in rep['attempts']:
        if ARM not in r['arms'] or ALONE not in r['arms']:
            continue
        row = {'attempt': r['attempt'], 'repo': r.get('repo'), 'pool': r['pool'], 'pool_A': r['pool_A']}
        for label, arm in (('alone', ALONE), ('nokey', ARM)):
            s = r['arms'][arm]
            row[label] = {'finds': s['consequential_finds'], 'tierA': s['tierA_finds'], 'tokens': s['client_tokens'] or 0, 'lines': s['items'],
                          'top8_ab': s['top8_ab'], 'top8': s['top8'], 'pending': s.get('pending_finds'), 'unlabelled': s.get('unlabelled')}
        prep = os.path.join(root, 'nokey', str(r['attempt']), 'prepare.json')
        row['prepare'] = json.load(open(prep)) if os.path.exists(prep) else None
        row['deterministic'] = deterministic(c, root, r['attempt'])
        rows.append(row)

    def pooled(sample):
        t = {k: {f: sum(x[k][f] for x in sample) for f in ('finds', 'tierA', 'tokens', 'lines', 'top8_ab', 'top8')} for k in ('alone', 'nokey')}
        for v in t.values():
            v['tokens_per_tierA'] = v['tokens'] / v['tierA'] if v['tierA'] else float('inf')
            v['p8'] = v['top8_ab'] / v['top8'] if v['top8'] else None
        diff = t['nokey']['finds'] - t['alone']['finds']
        x, y = t['alone']['tokens_per_tierA'], t['nokey']['tokens_per_tierA']
        ratio = 0.0 if y == float('inf') else (float('inf') if x == float('inf') else x / y)
        return t, diff, ratio
    t, diff, ratio = pooled(rows)
    rng = random.Random(20261023)
    boots = [pooled([rows[rng.randrange(len(rows))] for _ in rows])[1:] for _ in range(2000)] if rows else []

    def pct(i, q):
        v = sorted(b[i] for b in boots)
        return v[min(len(v) - 1, int(q * len(v)))] if v else None
    prep = [r['prepare'] for r in rows if r['prepare']]
    keyed = sum(x['keyed_report_bytes'] for x in prep)
    nokey = sum(x['nokey_report_bytes'] + x['events_file_bytes'] for x in prep)
    det = [sum(r['deterministic'][i] for r in rows) for i in (0, 1)]
    out = {'repos': len(rows), 'of': len(ATTEMPTS), 'pooled': t,
           'finds_diff': diff, 'finds_diff_ci': [pct(0, 0.05), pct(0, 0.95)],
           'tokens_per_tierA_ratio': ratio, 'tokens_per_tierA_ratio_ci': [pct(1, 0.05), pct(1, 0.95)],
           'gate_finds': bool(rows) and diff >= 0 and pct(0, 0.05) >= 0,
           'gate_tokens': bool(rows) and t['nokey']['tierA'] > 0 and ratio > 1 and pct(1, 0.05) >= 1,
           'reading_multiple': nokey / keyed if keyed else None, 'reading_bytes': {'keyed': keyed, 'nokey': nokey, 'repos': len(prep)},
           'nokey_finds_in_deterministic_sections': {'of_key_matched_finds': det[1], 'in_sections': det[0]},
           'rows': rows}
    out['pass'] = out['gate_finds'] and out['gate_tokens'] and len(rows) == len(ATTEMPTS)
    if a.json:
        print(json.dumps(out, indent=1, default=str)); return
    print('| Repo | Pool A+B | Alone finds | No-key finds | Alone act-now | No-key act-now | Alone tokens | No-key tokens | No-key lines | Pending |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    for r in rows:
        print(f"| {r['repo']} | {r['pool']} | {r['alone']['finds']} | {r['nokey']['finds']} | {r['alone']['tierA']} | {r['nokey']['tierA']} | "
              f"{r['alone']['tokens'] / 1e3:.0f}K | {r['nokey']['tokens'] / 1e3:.0f}K | {r['nokey']['lines']} | {r['nokey']['pending']} |")
    print(json.dumps({k: v for k, v in out.items() if k != 'rows'}, indent=1, default=str))


def deterministic(c, root, attempt):
    """(real finds whose package a deterministic section of the no-key report names, real finds matched by key)."""
    path = os.path.join(root, 'nokey', str(attempt), 'out', '.unstale', 'onboarding-report.md')
    text = open(path).read() if os.path.exists(path) else ''
    named = ''
    for title in DETERMINISTIC:
        m = re.search(r'\n## ' + re.escape(title) + r'\n(.*?)(?=\n## |\Z)', text, re.S)
        named += m.group(1) if m else ''
    pool = {}
    for p in c.execute('select item_id, tier, keys from ab_pool where version=? and attempt=?', (POOL, attempt)):
        if p['tier'] in ('A', 'B'):
            for k in json.loads(p['keys'] or '[]') + [p['item_id']]:
                pool[k] = p['item_id']
    hit, seen = set(), set()
    for it in c.execute('select item_key, package from ab_items where attempt=? and arm=?', (attempt, ARM)):
        pid = pool.get(it['item_key'])
        if pid:
            seen.add(pid)
            if it['package'] and re.search(r'(?<![\w@/.-])' + re.escape(it['package']) + r'(?![\w/-])', named):
                hit.add(pid)
    return len(hit), len(seen)


if __name__ == '__main__':
    main()
