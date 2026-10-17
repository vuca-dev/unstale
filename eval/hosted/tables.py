"""Generic retirement-table extraction: no per-provider rules. A table qualifies when a header names an identifier
(model, endpoint, name, id, version) and another a date (shutdown, retire, deprecat, date, sunset, end). Identifiers are
code-shaped tokens in the identifier column; dates are ISO or 'Month D, YYYY'."""
import html.parser, json, re, sys
class T(html.parser.HTMLParser):
    def __init__(s): super().__init__(); s.tables=[]; s.cell=None; s.row=None; s.depth=0
    def handle_starttag(s,t,a):
        if t=="table": s.tables.append([]); s.depth+=1
        elif t=="tr" and s.depth: s.row=[]
        elif t in("td","th") and s.row is not None: s.cell=[]
        elif t in ("br","p","li") and s.cell is not None: s.cell.append(" ")
    def handle_endtag(s,t):
        if t=="table": s.depth-=1
        elif t in("td","th") and s.cell is not None and s.row is not None: s.row.append(" ".join("".join(s.cell).split())); s.cell=None
        elif t=="tr" and s.row is not None and s.tables: s.tables[-1].append(s.row); s.row=None
    def handle_data(s,d):
        if s.cell is not None: s.cell.append(d)
ID=re.compile(r"(?<![\w.-])([a-z][a-z0-9]*(?:[-_.:/][a-z0-9]+)+)(?![\w-])")
MON="January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec"
DATE=re.compile(rf"\b(\d{{4}}-\d{{2}}-\d{{2}}|(?:{MON})\.? \d{{1,2}},? \d{{4}})\b")
def run(path):
    p=T(); p.feed(open(path,encoding="utf8",errors="replace").read())
    out=[]
    for tb in p.tables:
        if len(tb)<2: continue
        head=[h.lower() for h in tb[0]]
        rep=[i for i,h in enumerate(head) if re.search(r"replac|recommend|successor|alternative|upgrade",h)]
        idc=[i for i,h in enumerate(head) if i not in rep and re.search(r"model|endpoint|name|\bid\b|deprecated|legacy",h) and not re.search(r"price|date|state|status",h)]
        # Retirement dates: headers naming shutdown/retirement/sunset beat a plain "date" or a release/deprecation date.
        dc=[i for i,h in enumerate(head) if re.search(r"shut|retire|sunset|end of|removal",h)] or [i for i,h in enumerate(head) if re.search(r"deprecat.*date|\bdate\b",h) and not re.search(r"release|launch|announce",h)]
        if not idc or not dc: continue
        for r in tb[1:]:
            ids=sorted({m for i in idc if i<len(r) for m in ID.findall(r[i].lower()) if re.search(r"\d",m)})
            repl=sorted({m for i in rep if i<len(r) for m in ID.findall(r[i].lower()) if re.search(r"\d",m)})
            dates=[d for i in dc if i<len(r) for d in DATE.findall(r[i])]
            if ids: out.append(dict(ids=ids,replaced_by=repl,dates=dates,head=tb[0]))
    return out
res={n:run(f"{n}.html") for n in sys.argv[1:]}
for n,rows in res.items():
    ids={i for r in rows for i in r["ids"]}; dated=sum(1 for r in rows if r["dates"])
    print(f"{n:10s} rows {len(rows):4d}  identifiers {len(ids):4d}  rows with a date {dated:4d}")
json.dump(res,open("rows.json","w"),indent=1)
