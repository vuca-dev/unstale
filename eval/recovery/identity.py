"""Compare a counted upgrade across catalog deduplication without changing its frozen label.

The evidence-bearing lead must be byte-identical, at the same version move, package,
source URL and the file cited by that lead. Counts before 'leads with' are presentation, not change identity.
No record-less upgrade, changed lead, changed site or changed source is linked.
"""
import re

def lead_identity(item):
    summary=item.get('summary') or ''
    prefix,sep,lead=summary.partition('; leads with ')
    if not sep or ' picks up ' not in prefix or not item.get('evidence_url') or not re.search(r'\[[^\]\s]+:[^\]\s]+\]\s+\((?:`[^`]+` at |at )[^)]+\)',lead):
        return None
    return (item.get('package'),item.get('installed'),item.get('target'),item.get('evidence_url'),lead)

def relink(c,reference,arms,attempts):
    changes=[]
    for at in attempts:
        run=c.execute('select commit_sha from ab_runs where attempt=? and arm=?',(at,reference)).fetchone()
        if not run:continue
        refs={}
        for row in c.execute('select * from ab_items where attempt=? and arm=?',(at,reference)):
            r=dict(row);key=lead_identity(r)
            if key:refs.setdefault(key,[]).append(r)
        for arm in arms:
            other=c.execute('select commit_sha from ab_runs where attempt=? and arm=?',(at,arm)).fetchone()
            if not other or other[0]!=run[0]:continue
            for row in c.execute('select rowid,* from ab_items where attempt=? and arm=?',(at,arm)).fetchall():
                r=dict(row);key=lead_identity(r);matches=refs.get(key,[]) if key else []
                if len(matches)!=1 or matches[0]['item_key']==r['item_key']:continue
                ref=matches[0]
                changes.append({'attempt':at,'arm':arm,'rank':r['rank'],'from':r['item_key'],'to':ref['item_key'],'installed':r['installed'],'target':r['target'],'reference_installed':ref['installed'],'reference_target':ref['target'],'lead':key[-1]})
                c.execute('update ab_items set item_key=? where rowid=?',(ref['item_key'],r['rowid']))
    c.commit()
    return changes

if __name__ == '__main__':
    import argparse,json,sqlite3
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db',required=True);p.add_argument('--reference',required=True)
    p.add_argument('--arms',nargs='+',required=True);p.add_argument('--attempts',type=int,nargs='+',required=True)
    p.add_argument('--out',required=True);a=p.parse_args()
    c=sqlite3.connect(a.db);c.row_factory=sqlite3.Row
    changes=relink(c,a.reference,a.arms,a.attempts)
    with open(a.out,'w') as f:json.dump(changes,f,indent=1);f.write('\n')
    print(f'{len(changes)} item keys linked; labels and claims unchanged')
