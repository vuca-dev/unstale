"""Slice-4 encoder: ModernBERT-base with one head per step-D question, distilled from Jev's stored answers
(out/slice4/encoder/data.jsonl, built by encoder-data.mts from technologies outside every step-D set).

Loss: soft cross-entropy against Jev's probability distribution for change_type and surface; binary cross-entropy
against Jev's p(yes) for breaking and the five benefits. Validation: 10% of technologies (by sha256 of the id), used
only to pick the best epoch. Then predicts the slice's dev and held-out units (out/slice4/encoder/units.json) into
out/slice4/runs/encoder-{dev,heldout}/answers.json in run4.mts's format, and measures CPU records/second.

  eval/select/out/venv/bin/python eval/select/slice4/train_encoder.py [--minutes 45] [--epochs 3]
"""
import argparse
import hashlib
import json
import math
import os
import random
import time

import torch
import torch.nn as nn
from transformers import AutoModel, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "out", "slice4")
ENC = os.path.join(OUT, "encoder")
MODEL = "answerdotai/ModernBERT-base"
CT = ["new_api", "new_option", "behavior_change", "default_change", "fix", "deprecation", "removal", "stability_change",
      "performance", "security", "tooling", "other"]
SF = ["code_api", "configuration", "file_convention", "command_line", "schema_or_migration", "types_only",
      "runtime_internal", "build_tooling", "other"]
BIN = ["breaking", "benefit_security", "benefit_correctness", "benefit_performance", "benefit_cost", "benefit_maintainability"]


def text_of(state):
    keys = ["technology", "source", "release", "subject", "facet", "summary", "evidence", "section", "introduces", "replaces"]
    parts = []
    for k in keys:
        v = state.get(k)
        if v in (None, "", []):
            continue
        parts.append("%s: %s" % (k, ", ".join(v) if isinstance(v, list) else v))
    return "\n".join(parts)


class Heads(nn.Module):
    def __init__(self, base):
        super().__init__()
        self.base = base
        h = base.config.hidden_size
        self.drop = nn.Dropout(0.1)
        self.ct = nn.Linear(h, len(CT))
        self.sf = nn.Linear(h, len(SF))
        self.bin = nn.Linear(h, len(BIN))

    def forward(self, ids, mask):
        o = self.base(input_ids=ids, attention_mask=mask).last_hidden_state
        m = mask.unsqueeze(-1).float()
        pooled = self.drop((o * m).sum(1) / m.sum(1).clamp(min=1))  # mean pooling
        return self.ct(pooled), self.sf(pooled), self.bin(pooled)


def targets(ans):
    ct = [ans["change_type"]["probabilities"].get(c, 0.0) for c in CT]
    sf = [ans["surface"]["probabilities"].get(s, 0.0) for s in SF]
    b = [ans[k]["probabilities"].get("yes", 0.0) for k in BIN]
    norm = lambda xs: [x / sum(xs) for x in xs] if sum(xs) > 0 else [1.0 / len(xs)] * len(xs)
    return norm(ct), norm(sf), b


def batches(rows, bs, shuffle, rng):
    idx = list(range(len(rows)))
    if shuffle:
        rng.shuffle(idx)
    for i in range(0, len(idx), bs):
        yield [rows[j] for j in idx[i:i + bs]]


def encode(tok, texts, dev, max_len):
    e = tok(texts, padding=True, truncation=True, max_length=max_len, return_tensors="pt")
    return e["input_ids"].to(dev), e["attention_mask"].to(dev)


def loss_of(model, tok, rows, dev, max_len):
    ids, mask = encode(tok, [r["text"] for r in rows], dev, max_len)
    ct, sf, b = model(ids, mask)
    tct = torch.tensor([r["t"][0] for r in rows], dtype=torch.float32, device=dev)
    tsf = torch.tensor([r["t"][1] for r in rows], dtype=torch.float32, device=dev)
    tb = torch.tensor([r["t"][2] for r in rows], dtype=torch.float32, device=dev)
    l = -(tct * torch.log_softmax(ct, -1)).sum(-1).mean() - (tsf * torch.log_softmax(sf, -1)).sum(-1).mean()
    l = l + nn.functional.binary_cross_entropy_with_logits(b, tb) * len(BIN)
    return l


@torch.no_grad()
def predict(model, tok, texts, dev, max_len, bs=32):
    model.eval()
    out = []
    for i in range(0, len(texts), bs):
        ids, mask = encode(tok, texts[i:i + bs], dev, max_len)
        ct, sf, b = model(ids, mask)
        ct, sf, b = torch.softmax(ct, -1).cpu(), torch.softmax(sf, -1).cpu(), torch.sigmoid(b).cpu()
        for j in range(ct.shape[0]):
            a = {}
            pc = {c: float(ct[j, k]) for k, c in enumerate(CT)}
            ps = {s: float(sf[j, k]) for k, s in enumerate(SF)}
            a["change_type"] = {"choice": max(pc, key=pc.get), "confidence": max(pc.values()), "probabilities": pc}
            a["surface"] = {"choice": max(ps, key=ps.get), "confidence": max(ps.values()), "probabilities": ps}
            for k, q in enumerate(BIN):
                y = float(b[j, k])
                a[q] = {"choice": "yes" if y >= 0.5 else "no", "confidence": max(y, 1 - y), "probabilities": {"yes": y, "no": 1 - y}}
            out.append(a)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=45)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--max-len", type=int, default=384)
    a = ap.parse_args()
    torch.manual_seed(0)
    rng = random.Random(0)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    rows = []
    for line in open(os.path.join(ENC, "data.jsonl")):
        if line.strip():
            x = json.loads(line)
            rows.append({"tech": x["tech"], "text": text_of(x["state"]), "t": targets(x["answers"])})
    techs = sorted({r["tech"] for r in rows})
    val_techs = {t for t in techs if int(hashlib.sha256(("slice4-val:" + t).encode()).hexdigest(), 16) % 10 == 0}
    train = [r for r in rows if r["tech"] not in val_techs]
    val = [r for r in rows if r["tech"] in val_techs]
    print("rows %d: train %d (%d techs), val %d (%d techs); device %s" % (len(rows), len(train), len(techs) - len(val_techs), len(val), len(val_techs), dev), flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL)
    model = Heads(AutoModel.from_pretrained(MODEL)).to(dev)
    # Sort-ish by length inside shuffled buckets would be faster; plain shuffle keeps it simple.
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = a.epochs * math.ceil(len(train) / a.bs)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, 0.06 * steps)) * max(0.0, (steps - s) / steps))
    t0 = time.time()
    best = (float("inf"), -1)
    step = 0
    stop = False
    log = []
    for ep in range(a.epochs):
        model.train()
        for bt in batches(train, a.bs, True, rng):
            l = loss_of(model, tok, bt, dev, a.max_len)
            opt.zero_grad()
            l.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            step += 1
            if step % 50 == 0:
                print("ep %d step %d/%d loss %.3f %.1f min" % (ep, step, steps, l.item(), (time.time() - t0) / 60), flush=True)
            if (time.time() - t0) / 60 > a.minutes:
                stop = True
                break
        model.eval()
        with torch.no_grad():
            vl = sum(loss_of(model, tok, bt, dev, a.max_len).item() * len(bt) for bt in batches(val, 32, False, rng)) / max(1, len(val))
        log.append({"epoch": ep, "val_loss": vl, "minutes": (time.time() - t0) / 60, "steps": step})
        print("epoch %d val loss %.4f (%.1f min)" % (ep, vl, (time.time() - t0) / 60), flush=True)
        if vl < best[0]:
            best = (vl, ep)
            torch.save(model.state_dict(), os.path.join(ENC, "best.pt"))
        if stop:
            break
    train_min = (time.time() - t0) / 60
    model.load_state_dict(torch.load(os.path.join(ENC, "best.pt"), map_location=dev))
    # Agreement with Jev on validation technologies (hard labels).
    vp = predict(model, tok, [r["text"] for r in val], dev, a.max_len)
    agree = {"change_type": 0, "surface_runtime_internal": 0, "breaking": 0, "benefit_any": 0}
    for r, p in zip(val, vp):
        ct, sf, b = r["t"]
        agree["change_type"] += p["change_type"]["choice"] == CT[max(range(len(CT)), key=lambda k: ct[k])]
        agree["surface_runtime_internal"] += (p["surface"]["choice"] == "runtime_internal") == (SF[max(range(len(SF)), key=lambda k: sf[k])] == "runtime_internal")
        agree["breaking"] += (p["breaking"]["probabilities"]["yes"] >= 0.5) == (b[0] >= 0.5)
        agree["benefit_any"] += any(p[q]["probabilities"]["yes"] >= 0.5 for q in BIN[1:]) == any(x >= 0.5 for x in b[1:])
    agree = {k: v / max(1, len(val)) for k, v in agree.items()}
    print("agreement with Jev on validation technologies:", agree, flush=True)
    units = json.load(open(os.path.join(ENC, "units.json")))
    for split in ("dev", "heldout"):
        uids = [u for u in units if (u.startswith("heldout:") if split == "heldout" else not u.startswith("heldout:"))]
        preds = predict(model, tok, [text_of(units[u]) for u in uids], dev, a.max_len)
        d = os.path.join(OUT, "runs", "encoder-" + split)
        os.makedirs(d, exist_ok=True)
        json.dump({u: {"classifier": "encoder", "model": MODEL, "answers": p} for u, p in zip(uids, preds)}, open(os.path.join(d, "answers.json"), "w"), indent=1)
    # CPU throughput (a free runner has no GPU): held-out units, batch 16, 4 threads.
    cpu = Heads(AutoModel.from_pretrained(MODEL))
    cpu.load_state_dict(torch.load(os.path.join(ENC, "best.pt"), map_location="cpu"))
    torch.set_num_threads(4)
    texts = [text_of(units[u]) for u in units if u.startswith("heldout:")]
    t1 = time.time()
    predict(cpu, tok, texts, "cpu", a.max_len, bs=16)
    rps = len(texts) / (time.time() - t1)
    meta = {"model": MODEL, "rows": len(rows), "train": len(train), "val": len(val), "val_techs": sorted(val_techs), "epochs_run": len(log), "best_epoch": best[1],
            "train_minutes": train_min, "log": log, "val_agreement_with_jev": agree, "cpu_records_per_s_4_threads": rps, "max_len": a.max_len, "lr": a.lr, "bs": a.bs}
    json.dump(meta, open(os.path.join(ENC, "meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1), flush=True)


if __name__ == "__main__":
    main()
