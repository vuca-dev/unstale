# Strict (quote-overlap, score.py) against lenient H2 recall: a group also counts when a record of its note names all
# of the anchor's backticked identifiers, or (no identifiers) shares at least 60% of its content words. Lenient is an
# upper bound (it can credit a record about a different change); strict a lower bound. Run from eval/select:
#   python3 -I slice3/lenient_h2.py
import json, re, sys, os
sys.path.insert(0, "holdout")
import score as S
M = os.path.join("holdout-majors", "extraction")
manifest = S.load_manifest(os.path.join(M, "notes.json"))
labels = S.rj(os.path.join(M, "labels", "adjudicated.json"))
STOP = set("the a an to of in and or for is are be with on by as it this that from now no not can will use using when if at your you its into".split())
def idents(s): return {x.lower() for x in re.findall(r"`([^`]{2,60})`", s or "")}
def words(s): return {w for w in re.findall(r"[a-z0-9_$.@/-]{3,}", (s or "").lower()) if w not in STOP}
def recs_by_note(path):
    data = json.load(open(path)); by = {f: [] for f in manifest}
    by_tv = {}
    for f, n in manifest.items():
        for t in {n["technology"], n.get("name") or n["technology"]}:
            by_tv.setdefault((S.tech_key(t), n["version"]), []).append(f)
    for r in data:
        f = S.note_for(by_tv, manifest, r.get("technology"), r.get("version"), S.record_kind(r))
        if f: by[f].append(r)
    return by
def lenient_hit(group, recs):
    for a in group["anchors"]:
        ia = idents(a); wa = words(a)
        for r in recs:
            blob = " ".join(str(r.get(k, "")) for k in ("subject", "facet", "summary", "quote", "introduces", "replaces", "terms"))
            if ia and all(i in blob.lower() for i in ia): return True
            if not ia and wa and len(wa & words(blob)) / len(wa) >= 0.6: return True
    return False
runs = {"Luna 5.6 r1": "luna-fresh-two-call-heldout2-r1", "Luna 5.6 r2": "luna-fresh-two-call-heldout2-r2", "gpt-6-luna": "vercel_openai_gpt-6-luna-two-call-heldout2",
        "qwen3.8-flash": "vercel_alibaba_qwen3.8-flash-two-call-heldout2", "qwen3.7-flash": "vercel_alibaba_qwen3.7-flash-two-call-heldout2",
        "nemotron-3.5": "vercel_nvidia_nemotron-3.5-lightning-two-call-heldout2", "glm-4.7-flash": "vercel_zai_glm-4.7-flash-two-call-heldout2", "gpt-5-nano": "vercel_openai_gpt-5-nano-two-call-heldout2"}
print("model\trecords\tgrounded%\tstrict_req\tlenient_req\tstrict_all\tlenient_all")
for name, d in runs.items():
    p = os.path.join("out/slice3b/runs", d, "incoming.json")
    if not os.path.exists(p): continue
    by = recs_by_note(p)
    allr = [r for v in by.values() for r in v]
    g = sum(1 for r in allr if str(r.get("grounded")) in ("True", "true"))
    sr = lr = n = sa = la = na = 0
    for f in manifest:
        gs = S.note_groups(labels.get(f, [])); recs = by[f]
        rec, _ = S.match_note([r.get("quote") or "" for r in recs], gs); hit = set(rec.values())
        for k, grp in enumerate(gs):
            if grp["unsure"]: continue
            s = k in hit; l = s or lenient_hit(grp, recs)
            na += 1; sa += s; la += l
            if grp["required_sure"]: n += 1; sr += s; lr += l
    print(f"{name}\t{len(allr)}\t{100*g/max(1,len(allr)):.1f}\t{100*sr/n:.1f}\t{100*lr/n:.1f}\t{100*sa/na:.1f}\t{100*la/na:.1f}\t(n_req={n}, n_all={na})")
