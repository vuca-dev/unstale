"""Parse the upgrade-review batch the CLI renders (`.unstale/review/upgrades.md`; the upgrade-review SKILL.md before #143).

No imports beyond the standard library, so it is tested on its own: python3 -m unittest -v test_rendered (from this directory).
"""
import re

HEAD = re.compile(r"^### \[([^\]]+)\] rev (\d+)\n", re.M)
# The summary sits in a fenced block (with any conditions on the next line), so upstream text cannot pose as instructions.
# The release is one version, or a span when the exact release is not known (`review::release_version`).
# A deprecation of a part of a surviving name cites its sites as "Name match, … shape not checked (…)" (`funnel::deprecated_part`).
BODY = re.compile(r"\n`{3,}text\n(?:(?!\n### ).)*?\n(?:Conditions [^\n]*\n)?`{3,}\n\n"
                  r"- Release: (\S+) (\S+)(?: to (\S+) \(exact release not known\))? \(installed (\S+), target (\S+)\)\n"
                  r"- Change: ([^;]+); breaking: (yes|no)\n"
                  r"(?:(?!### )[^\n]*\n)*?- (?:Matched terms|Deprecated API used here|Name match[^:\n]*): (.*?)\n", re.S)


def parse(text):
    """Return ({id: fields}, [ids whose entry is rendered in a form this parser does not read])."""
    heads = list(HEAD.finditer(text))
    recs, unread = {}, []
    for n, h in enumerate(heads):
        # No part crosses into the next entry: an "In effect now" entry has another release line and must not swallow it.
        block = text[h.end():heads[n + 1].start() if n + 1 < len(heads) else len(text)]
        m = BODY.match(block)
        if not m:
            unread.append(h.group(1))
            continue
        recs[h.group(1)] = dict(rev=int(h.group(2)), pkg=m.group(1), release=m.group(2), release_hi=m.group(3), installed=m.group(4),
                                target=m.group(5), change=m.group(6), breaking=m.group(7) == "yes", matched=m.group(8) != "none")
    return recs, unread


def missing(ids, recs, unread):
    """An error naming each batch id the gate cannot score, and why; None when every id was read."""
    bad = [i for i in ids if i not in recs]
    if not bad:
        return None
    why = ["%s (%s)" % (i, "rendered in a form the gate does not parse" if i in unread else "in the batch but not rendered") for i in bad]
    return "batch records the gate cannot read: " + "; ".join(why)
