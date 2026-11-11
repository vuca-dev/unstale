#!/usr/bin/env python3
"""The catalog a no-key user would have had on a given day, built from a client cache. No network, no model.

    freeze_catalog.py --cache <client cache dir> --out <catalog dir> --until YYYY-MM-DD

For every technology in the cache (`v1/tech/<technology>.json`, with its change events under `v1/events/<technology>/`,
as a sync with UNSTALE_EDGE_INFERENCE=1 leaves them) it writes a catalog directory the client can read with
`--catalog <catalog dir>`:

- change events dated on or before --until, one shard per release line, re-hashed;
- the release index cut at the same day;
- no records and no advisory APIs: both are written by central's model steps, which a no-key user is without.

So every release newer than a repository's installed versions is one the client has events for and no records, and
nothing published after the day is shown. Prints one JSON line of counts.
"""
import argparse, gzip, hashlib, json, os, sys


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--cache', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--until', required=True)
    a = p.parse_args()
    tech_dir = os.path.join(a.cache, 'v1', 'tech')
    counts = {'technologies': 0, 'with_events': 0, 'events_kept': 0, 'events_after': 0, 'records_dropped': 0, 'events_unreadable': 0}
    os.makedirs(os.path.join(a.out, 'v1', 'tech'), exist_ok=True)
    with open(os.path.join(a.out, 'v1', 'root.json'), 'w') as f:
        json.dump({'schema': 1, 'min_client': '0.1.0'}, f)
    for name in sorted(os.listdir(tech_dir)):
        if not name.endswith('.json') or name.startswith('.'):
            continue
        tech = name[:-5]
        index = json.load(open(os.path.join(tech_dir, name)))
        counts['technologies'] += 1
        counts['records_dropped'] += sum(s.get('records', 0) for s in index.get('shards', []))
        by_line = {}
        for ref in index.get('events', []):
            path = os.path.join(a.cache, 'v1', 'events', tech, ref['path'].rsplit('/', 1)[-1])
            try:
                raw = open(path, 'rb').read()
                if hashlib.sha256(raw).hexdigest() != ref['sha256'].removeprefix('sha256:'):
                    raise ValueError('sha256')
                lines = [json.loads(l) for l in gzip.decompress(raw).decode().splitlines() if l.strip()]
            except (OSError, ValueError):
                counts['events_unreadable'] += 1
                continue
            for e in lines:
                if e['date'] <= a.until:
                    by_line.setdefault(e['line'], []).append(e)
                    counts['events_kept'] += 1
                else:
                    counts['events_after'] += 1
        refs = []
        for line, events in sorted(by_line.items()):
            text = ''.join(json.dumps(e, ensure_ascii=False, separators=(',', ':')) + '\n' for e in events)
            gz = gzip.compress(text.encode(), mtime=0)
            sha = hashlib.sha256(gz).hexdigest()
            rel = f'v1/shards/{tech}/{line}.events.{sha[:16]}.jsonl.gz'
            os.makedirs(os.path.dirname(os.path.join(a.out, rel)), exist_ok=True)
            open(os.path.join(a.out, rel), 'wb').write(gz)
            refs.append({'line': line, 'path': rel, 'sha256': sha, 'bytes': len(gz), 'records': len(events)})
        counts['with_events'] += bool(refs)
        out = {k: v for k, v in index.items() if k not in ('shards', 'events', 'advisory_apis', 'sample', 'releases')}
        out.update(shards=[], sample_n=0, releases=[r for r in index.get('releases', []) if r.get('date', '') <= a.until])
        if refs:
            out['events'] = refs
        if not out['releases']:
            del out['releases']
        json.dump(out, open(os.path.join(a.out, 'v1', 'tech', name), 'w'))
    print(json.dumps({'until': a.until, **counts}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
