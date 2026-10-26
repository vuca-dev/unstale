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
                changes.append({'attempt':at,'arm':arm,'rank':r['rank'],'from':r['item_key'],'to':ref['item_key'],'lead':key[-1]})
                c.execute('update ab_items set item_key=?,claim=? where rowid=?',(ref['item_key'],ref['claim'],r['rowid']))
    c.commit()
    return changes
