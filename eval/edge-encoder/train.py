"""Edge encoder, stages 3-4: train ModernBERT-base step-D heads on Jev's cached answers (build-data.mts), report
agreement with Jev on technology-disjoint validation, and write predictions for slice 4's dev, H1 and H2 units in
run4.mts's answer format, so slice 4's harness scores them. Recipe: slice 4's train_encoder.py (heads, loss, text),
plus a per-technology cap, a technology fraction for the learning curve and length-bucketed batches.

  eval/select/out/venv/bin/python eval/edge-encoder/train.py --data <data.jsonl> --out <dir> --frac 1.0 --tag f100
"""
import argparse
import hashlib
import json
import math
import os
import random
import sys
import time

import torch
from transformers import AutoModel, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "select", "slice4"))
import train_encoder as te  # noqa: E402

def _encode(tok, texts, dev, max_len):
    # Pad to a multiple of 32: MPS caches a graph and buffers per input shape, and free-length batches grew the
    # process to 15 GB on a 16 GB machine (swapping, under 0.4 steps/s).
    e = tok(texts, padding=True, truncation=True, max_length=max_len, pad_to_multiple_of=32, return_tensors="pt")
    return e["input_ids"].to(dev), e["attention_mask"].to(dev)


te.encode = _encode

S4 = os.path.join(os.environ.get("SLICE4_OUT", os.path.join(HERE, "..", "select", "out", "slice4")))


def h(s):
    return int(hashlib.sha256(s.encode()).hexdigest(), 16)


def state_of_incoming(name, inc):
    kind = inc.get("kind")
    s = {"technology": name, "source": "upgrade guide" if kind == "upgrade_guide" else "official documentation change" if kind == "docs" else "release notes",
         "release": inc["version"], "subject": inc["subject"]}
    if inc.get("facet"):
        s["facet"] = inc["facet"]
    s["summary"] = inc["summary"]
    s["evidence"] = inc.get("quote", "")
    if inc.get("section"):
        s["section"] = inc["section"]
    s["introduces"] = inc.get("introduces", [])
    s["replaces"] = inc.get("replaces", [])
    return s


def bucketed(rows, bs, rng, budget):
    """Length-sorted batches inside shuffled chunks, each under a token budget (rows x longest row): sorting puts the
    longest records together, and a full batch of 384-token records ran MPS out of memory."""
    idx = list(range(len(rows)))
    rng.shuffle(idx)
    out = []
    for i in range(0, len(idx), bs * 50):
        chunk = sorted(idx[i:i + bs * 50], key=lambda j: rows[j]["n"])
        cur = []
        for j in chunk:
            if cur and (len(cur) >= bs or (len(cur) + 1) * rows[j]["n"] > budget):
                out.append(cur)
                cur = []
            cur.append(j)
        if cur:
            out.append(cur)
    rng.shuffle(out)
    for b in out:
        yield [rows[j] for j in b]


def agreement(val, preds):
    CT, SF = te.CT, te.SF
    n = max(1, len(val))
    a = {"change_type": 0, "actionable": 0, "breaking@0.5": 0, "benefit_any@0.5": 0}
    for r, p in zip(val, preds):
        ct, sf, b = r["t"]
        a["change_type"] += p["change_type"]["choice"] == CT[max(range(len(CT)), key=lambda k: ct[k])]
        a["actionable"] += (p["surface"]["choice"] != "runtime_internal") == (SF[max(range(len(SF)), key=lambda k: sf[k])] != "runtime_internal")
        a["breaking@0.5"] += (p["breaking"]["probabilities"]["yes"] >= 0.5) == (b[0] >= 0.5)
        a["benefit_any@0.5"] += any(p[q]["probabilities"]["yes"] >= 0.5 for q in te.BIN[1:]) == any(x >= 0.5 for x in b[1:])
    return {k: v / n for k, v in a.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--frac", type=float, default=1.0)
    ap.add_argument("--cap", type=int, default=200)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--max-len", type=int, default=384)
    ap.add_argument("--minutes", type=float, default=600)
    ap.add_argument("--token-budget", type=int, default=16 * 160)
    a = ap.parse_args()
    torch.manual_seed(0)
    rng = random.Random(0)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    out = os.path.join(a.out, a.tag)
    os.makedirs(out, exist_ok=True)

    by_tech = {}
    for line in open(a.data):
        if line.strip():
            x = json.loads(line)
            by_tech.setdefault(x["tech"], []).append({"tech": x["tech"], "text": te.text_of(x["state"]), "t": te.targets(x["answers"])})
    techs = sorted(by_tech)
    val_techs = [t for t in techs if h("edge-val:" + t) % 10 == 0]
    train_techs = sorted((t for t in techs if t not in set(val_techs)), key=lambda t: h("edge-frac:" + t))
    train_techs = train_techs[:max(1, round(len(train_techs) * a.frac))]

    def capped(t):
        rs = by_tech[t]
        return rs if len(rs) <= a.cap else random.Random(h("edge-cap:" + t)).sample(rs, a.cap)

    train = [r for t in train_techs for r in capped(t)]
    val = [r for t in val_techs for r in capped(t)]
    print("train %d records / %d techs; val %d / %d techs; device %s" % (len(train), len(train_techs), len(val), len(val_techs), dev), flush=True)

    tok = AutoTokenizer.from_pretrained(te.MODEL)
    for r, n in zip(train, tok([r["text"] for r in train], truncation=True, max_length=a.max_len)["input_ids"]):
        r["n"] = len(n)
    ns = sorted(r["n"] for r in train)
    print("tokens per record: median %d, p95 %d, max %d" % (ns[len(ns) // 2], ns[int(len(ns) * .95)], ns[-1]), flush=True)
    model = te.Heads(AutoModel.from_pretrained(te.MODEL)).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = a.epochs * sum(1 for _ in bucketed(train, a.bs, random.Random(1), a.token_budget))  # budgeted batches outnumber len/bs
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, 0.06 * steps)) * max(0.0, (steps - s) / steps))
    t0, step, best, log, stop = time.time(), 0, (float("inf"), -1), [], False
    for ep in range(a.epochs):
        model.train()
        for bt in bucketed(train, a.bs, rng, a.token_budget):
            l = te.loss_of(model, tok, bt, dev, a.max_len)
            opt.zero_grad()
            l.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            if dev == "mps" and step % 100 == 0:
                torch.mps.empty_cache()
            if step % 200 == 0:
                print("ep %d step %d/%d loss %.3f %.1f min" % (ep, step, steps, l.item(), (time.time() - t0) / 60), flush=True)
            if (time.time() - t0) / 60 > a.minutes:
                stop = True
                break
        model.eval()
        with torch.no_grad():
            vl = sum(te.loss_of(model, tok, bt, dev, a.max_len).item() * len(bt) for bt in te.batches(val, 32, False, rng)) / max(1, len(val))
        log.append({"epoch": ep, "val_loss": vl, "minutes": (time.time() - t0) / 60})
        print("epoch %d val loss %.4f (%.1f min)" % (ep, vl, (time.time() - t0) / 60), flush=True)
        if vl < best[0]:
            best = (vl, ep)
            torch.save(model.state_dict(), os.path.join(out, "best.pt"))
        if stop:
            break
    train_min = (time.time() - t0) / 60
    model.load_state_dict(torch.load(os.path.join(out, "best.pt"), map_location=dev))
    agree = agreement(val, te.predict(model, tok, [r["text"] for r in val], dev, a.max_len))
    print("agreement with Jev (validation technologies):", agree, flush=True)

    # Predictions for slice 4's harness: dev + H1 (units.json), H2 (h2-units.json).
    runs = os.path.join(S4, "runs")
    units = json.load(open(os.path.join(S4, "encoder", "units.json")))
    for split in ("dev", "heldout"):
        uids = [u for u in units if (u.startswith("heldout:") if split == "heldout" else not u.startswith("heldout:"))]
        preds = te.predict(model, tok, [te.text_of(units[u]) for u in uids], dev, a.max_len)
        d = os.path.join(runs, "edge-%s-%s" % (a.tag, split))
        os.makedirs(d, exist_ok=True)
        json.dump({u: {"classifier": "encoder", "model": a.tag, "answers": p} for u, p in zip(uids, preds)}, open(os.path.join(d, "answers.json"), "w"))
    h2 = json.load(open(os.path.join(S4, "h2-units.json")))["units"]
    preds = te.predict(model, tok, [te.text_of(state_of_incoming(u["name"], u["incoming"])) for u in h2], dev, a.max_len)
    d = os.path.join(runs, "edge-%s-heldout2" % a.tag)
    os.makedirs(d, exist_ok=True)
    json.dump({u["id"]: {"classifier": "encoder", "model": a.tag, "answers": p} for u, p in zip(h2, preds)}, open(os.path.join(d, "answers.json"), "w"))

    meta = {"tag": a.tag, "frac": a.frac, "cap": a.cap, "train_records": len(train), "train_techs": len(train_techs), "val_records": len(val),
            "val_techs": len(val_techs), "epochs_run": len(log), "best_epoch": best[1], "train_minutes": train_min, "log": log, "agreement": agree}
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"), indent=1)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    main()
