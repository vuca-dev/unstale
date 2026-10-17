"""Documents for the picked technologies (PREREG.md sections 2.4 and 3): fetch (from the selection's cached reads), cut,
cap at ~60k characters per technology by whole top-level sections, save to extraction/notes/ and write
extraction/notes.json (chunks are filled by chunks.mts). Raw whole documents go to eval/select/out/holdout-majors/raw/.

    python3 -I fetch_docs.py && (cd central && npx tsx ../eval/select/holdout-majors/chunks.mts)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import select_majors as S  # noqa: E402
from majors_lib import HERE, OUT, headings, repo_head, tree  # noqa: E402

CAP, HALF = 60_000, 30_000
NOTES_DIR = os.path.join(HERE, "extraction", "notes")


def split_sections(text):
    """(preamble, [(title, text)], level) at the top level: the highest heading level that occurs at least twice."""
    hs = headings(text)
    counts = {}
    for _, lv, _ in hs:
        counts[lv] = counts.get(lv, 0) + 1
    tops = [lv for lv, c in counts.items() if c >= 2]
    if not tops:
        return text, [], None
    top = min(tops)
    lines = text.split("\n")
    starts = [(ln, t) for ln, lv, t in hs if lv == top]
    pre = "\n".join(lines[:starts[0][0]])
    secs = []
    for k, (ln, t) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(lines)
        secs.append((t, "\n".join(lines[ln:end])))
    return pre, secs, top


def cap(text, limit):
    """Keep the preamble, then whole top-level sections in order until the next would pass `limit`. If the first
    section alone passes, the rule is applied inside it one level down. Returns (text, kept titles, dropped titles)."""
    if len(text) <= limit:
        return text, None, []
    pre, secs, _ = split_sections(text)
    if not secs:
        raise SystemExit("no top-level sections to cap by; a deviation is needed")
    out, kept, dropped = pre, [], []
    for i, (t, s) in enumerate(secs):
        joined = (out + "\n" + s) if out else s
        if not dropped and len(joined) <= limit:
            out, kept = joined, kept + [t]
            continue
        if not kept and i == 0:
            inner, k2, d2 = cap(s, limit - len(out) - 1)
            out = (out + "\n" + inner) if out else inner
            kept = [t + " (partial: " + ", ".join(k2 or []) + ")"]
            dropped += [t + " > " + d for d in d2]
            continue
        dropped.append(t)
    return out.rstrip() + "\n", kept, dropped


def slug(pkg):
    return pkg.replace("@", "").replace("/", "-").lstrip("-")


def main():
    sel = json.load(open(os.path.join(OUT, "selection.json")))
    pools = {"npm": S.NPM + S.RESERVE_NPM, "pypi": S.PYPI + S.RESERVE_PYPI}
    os.makedirs(NOTES_DIR, exist_ok=True)
    os.makedirs(os.path.join(OUT, "raw"), exist_ok=True)
    notes = []
    for eco in ("npm", "pypi"):
        for pkg in sel["ecosystems"][eco]["picks"]:
            row = next(r for r in sel["ecosystems"][eco]["rows"] if r["package"] == pkg)
            _, repo, docs = next(e for e in pools[eco] if e[0] == pkg)
            dr = docs or repo
            v = row["major"]
            # Re-derive the documents from the same cached reads the selection made (same commit SHAs).
            br, sha = repo_head(repo)
            files, _ = tree(repo, sha)
            dsha = sha if dr == repo else repo_head(dr)[1]
            dfiles = files if dr == repo else tree(dr, dsha)[0]
            assert sha == row["code_sha"] and dsha == row["docs_sha"], "HEAD moved since selection"
            n = S.notes_doc(pkg, repo, eco, v, files, sha, dr, dfiles, dsha)
            label = v.split(".")[0] if not v.startswith("0.") else "0." + v.split(".")[1]
            g = S.guide_doc(label, dr, dfiles, dsha)
            docs_ = [d for d in ((g, "guide"), (n, "major_notes")) if d[0]]
            lens = {k: d["chars"] for d, k in docs_}
            if sum(lens.values()) <= CAP:
                limits = dict(lens)
            elif min(lens.values()) <= HALF:
                small = min(lens, key=lens.get)
                limits = {k: (lens[k] if k == small else CAP - lens[small]) for k in lens}
            else:
                limits = {k: HALF for k in lens}
            for d, kind in docs_:
                src_path = d["source"].get("path", "")
                ext = os.path.splitext(src_path)[1].lstrip(".").lower() if kind == "guide" or d.get("style") != "github_release" else "md"
                ext = ext if ext in ("md", "mdx", "rst", "txt", "markdown") else "md"
                fname = f"{slug(pkg)}@{v}.{kind}.{ext}"
                with open(os.path.join(OUT, "raw", fname), "w", encoding="utf8") as fh:
                    fh.write(d["text"])
                text, kept, dropped = cap(d["text"], limits[kind])
                with open(os.path.join(NOTES_DIR, fname), "w", encoding="utf8") as fh:
                    fh.write(text)
                notes.append({
                    "note_file": fname, "technology": pkg, "name": pkg, "ecosystem": eco, "kind": kind, "version": v,
                    "date": row["date"], "url": d["url"], "style": d.get("style") or ("guide_" + d["mode"]),
                    "source": d["source"], "chars": len(text), "full_chars": d["chars"], "cap": limits[kind],
                    "kept_sections": kept, "dropped_sections": dropped, "chunks": None,
                })
                print("%-45s %-11s full %7d  cap %6d  kept %6d  dropped %d sections" % (fname, kind, d["chars"], limits[kind], len(text), len(dropped)))
    with open(os.path.join(HERE, "extraction", "notes.json"), "w") as fh:
        json.dump({"seed": sel["seed"], "window": sel["window"], "cap_per_technology": CAP, "notes": notes}, fh, indent=1)


if __name__ == "__main__":
    main()
