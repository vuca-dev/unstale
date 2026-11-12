#!/usr/bin/env python3
"""The no-key arm, one repo at a time, on a copy of the beat-naive harness (which lives outside this repository).

    arm.py --harness <copy of the harness> --build <unstale binary> prepare <attempt>...
    arm.py --harness <copy of the harness> run <attempt>... [--no-judge]

prepare (deterministic, no model): at the attempt's pinned commit, (1) the build syncs the live catalog with the
edge-inference switch on, (2) freeze_catalog.py cuts that cache to the day the agent-alone arm ran, records removed,
(3) the build runs again on the frozen catalog with no provider chosen. The second run's .unstale is kept under
<harness>/nokey/<attempt>/out, with the counts the data gate and the token multiple need in prepare.json.

run: the plain ask plus one line naming unstale's files (prompt.md), through the harness's own agent runner with the
agent-alone arm's settings, then the harness's judge on the new items. A finished attempt is skipped.
"""
import argparse, json, os, re, shutil, sqlite3, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ARM = 'naive-plain+nokey@3x'
ALONE = 'naive-plain@3x'
GATE = '2026-11-11T00:48'
SECTION = re.compile(r'\n## Unparsed release notes\n.*?(?=\n## |\Z)', re.S)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--harness', required=True)
    p.add_argument('--build')
    p.add_argument('--no-judge', action='store_true')
    p.add_argument('action', choices=('prepare', 'run'))
    p.add_argument('attempts', type=int, nargs='+')
    a = p.parse_args()
    root = os.path.abspath(a.harness)
    os.environ.setdefault('AB_BLIND_ROOT', os.path.expanduser('~/.scout-ab/nokey'))
    sys.path.insert(0, os.path.join(root, 'bin'))
    import ab_common as ab
    c = sqlite3.connect(os.path.join(root, 'state', 'scout.db'), timeout=120)
    c.row_factory = sqlite3.Row
    for at in a.attempts:
        r = c.execute('select repo, commit_sha, created_at, budget from ab_runs where attempt=? and arm=?', (at, ALONE)).fetchone()
        if not r:
            sys.exit(f'attempt {at} has no {ALONE} run')
        clone = os.path.join(root, 'work', r['repo'].replace('/', '__'))
        base = os.path.join(root, 'nokey', str(at))
        if a.action == 'prepare':
            prepare(ab, a.build, at, r, clone, base)
        else:
            run(ab, c, root, at, r, clone, base, a.no_judge)


def unstale(build, d, cache, config, extra, state=None):
    """One `unstale init` in `d`. Returns the report and the coverage state it left. `state` seeds that state first, so
    a second run on the same repository does not ask the public registry about every package again."""
    env = {**os.environ, 'UNSTALE_EDGE_INFERENCE': '1', 'UNSTALE_CACHE_DIR': cache, 'UNSTALE_CONFIG_DIR': config, 'UNSTALE_INTERNAL_TRAFFIC': '1'}
    env.pop('UNSTALE_CATALOG', None)
    spath = os.path.join(d, '.unstale', 'state', 'coverage.json')
    path = os.path.join(d, '.unstale', 'onboarding-report.md')
    # The public registry limits bursts of package checks: a limited run is no basis for a report, so wait and retry.
    for wait in (0, 300, 600, 900):
        time.sleep(wait)
        shutil.rmtree(os.path.join(d, '.unstale'), ignore_errors=True)
        if state is not None:
            os.makedirs(os.path.dirname(spath)); open(spath, 'wb').write(state)
        subprocess.run([build, '-C', d, 'init', '--yes', '--mode', 'local', '--no-animation', '--wait', '60', '--service', 'https://api.unstale.sh', *extra],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
        text = open(path).read() if os.path.exists(path) else None
        if text and 'Registry unavailable' not in text and 'registry identities went unanswered' not in text:
            return text, open(spath, 'rb').read() if os.path.exists(spath) else None
    sys.exit('the public registry kept limiting this run; run prepare again later')


def prepare(ab, build, at, r, clone, base):
    if not build:
        sys.exit('prepare needs --build')
    done = os.path.join(base, 'prepare.json')
    if os.path.exists(done):
        print(open(done).read().strip()); return
    shutil.rmtree(base, ignore_errors=True); os.makedirs(base)
    cache1, cache2, cat, config = (os.path.join(base, x) for x in ('cache-live', 'cache-frozen', 'catalog', 'config'))
    os.makedirs(config)
    day = r['created_at'][:10]
    d = ab.blind_copy(clone, f'prep-{at}-live', commit=r['commit_sha'])
    try:
        live, state = unstale(build, d, cache1, config, [])
    finally:
        shutil.rmtree(d, ignore_errors=True)
    if live is None:
        sys.exit(f'attempt {at}: no report on the live catalog')
    open(os.path.join(base, 'live-report.md'), 'w').write(live)
    techs = with_records = stale = no_events = 0
    stale_names = []
    for name in sorted(os.listdir(os.path.join(cache1, 'v1', 'tech'))):
        if not name.endswith('.json') or name.startswith('.'): continue
        idx = json.load(open(os.path.join(cache1, 'v1', 'tech', name)))
        techs += 1
        if not sum(s.get('records', 0) for s in idx.get('shards', [])): continue
        with_records += 1
        if idx.get('checked', '') < GATE:
            stale += 1; stale_names.append(name[:-5])
        elif not idx.get('events'):
            no_events += 1
    frozen = json.loads(subprocess.run([sys.executable, os.path.join(HERE, 'freeze_catalog.py'), '--cache', cache1, '--out', cat, '--until', day],
                                       capture_output=True, text=True, check=True).stdout)
    d = ab.blind_copy(clone, f'prep-{at}-frozen', commit=r['commit_sha'])
    try:
        report, _ = unstale(build, d, cache2, config, ['--catalog', cat], state)
        if report is None:
            sys.exit(f'attempt {at}: no report on the frozen catalog')
        out = os.path.join(base, 'out')
        shutil.copytree(os.path.join(d, '.unstale'), os.path.join(out, '.unstale'), symlinks=True)
        for sub in ('.claude/skills', '.agents/skills', '.cursor/skills'):
            src = os.path.join(d, sub)
            for x in (os.listdir(src) if os.path.isdir(src) else []):
                if x.startswith('unstale-'):
                    shutil.copytree(os.path.join(src, x), os.path.join(out, sub, x), symlinks=True)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    ev = os.path.join(out, '.unstale', 'change-events.md')
    res = {'attempt': at, 'repo': r['repo'], 'commit': r['commit_sha'][:10], 'until': day, 'technologies': techs, 'with_records': with_records,
           'not_yet_on_events_code': stale, 'not_yet': stale_names, 'no_source_text': no_events, 'frozen': frozen,
           'keyed_report_bytes': len(SECTION.sub('', live).encode()), 'nokey_report_bytes': len(report.encode()),
           'events_file_bytes': os.path.getsize(ev) if os.path.exists(ev) else 0}
    json.dump(res, open(done, 'w'))
    print(json.dumps(res))


def run(ab, c, root, at, r, clone, base, no_judge):
    row = c.execute('select status, tokens from ab_runs where attempt=? and arm=?', (at, ARM)).fetchone()
    if row and row['status'] == 'ok':
        print(json.dumps({'attempt': at, 'skipped': 'done', 'tokens': row['tokens']})); return
    out = os.path.join(base, 'out')
    if not os.path.exists(os.path.join(out, '.unstale', 'onboarding-report.md')):
        sys.exit(f'attempt {at}: run prepare first')
    d = ab.blind_copy(clone, f'run-{at}', commit=r['commit_sha'])
    shutil.copytree(out, d, symlinks=True, dirs_exist_ok=True)
    usd = re.search(r'\$([\d.]+)', r['budget'] or '')
    env = {**os.environ, 'AB_ARM': ARM, 'AB_BLIND': d, 'AB_PROMPT': os.path.join(HERE, 'prompt.md'), 'AB_KEEP_UNSTALE': '1', 'AB_NO_RESUME': '1',
           'AB_BUDGET_USD': usd.group(1) if usd else '3.25', 'AB_MAX_ITEMS': '200', 'AB_NAIVE_TIMEOUT': '1800',
           'AB_BUDGET_LABEL': (r['budget'] or '3x') + '; unstale: no-key, frozen catalog'}
    res = subprocess.run([os.path.join(root, 'bin', 'ab-naive.sh'), str(at)], env=env, capture_output=True, text=True)
    print(res.stdout.strip() or res.stderr[-500:])
    row = c.execute('select status from ab_runs where attempt=? and arm=?', (at, ARM)).fetchone()
    if not row or row['status'] != 'ok':
        sys.exit(f'attempt {at}: the session gave no list (usage limit, timeout or error); stopping')
    if not no_judge:
        j = subprocess.run([sys.executable, os.path.join(root, 'bin', 'ab-judge.py'), str(at), '--arms', *ab.ARMS, ARM], capture_output=True, text=True)
        print(f'judge {at}: ' + (j.stdout.strip()[-300:] or j.stderr[-300:]))


if __name__ == '__main__':
    main()
