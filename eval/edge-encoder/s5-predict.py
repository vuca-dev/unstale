"""Edge encoder, stage 5: the 100% checkpoint's answers for s5-units.py's units (te.text_of of each state), in
run4.mts's answer format. No model calls.

  eval/select/out/venv/bin/python eval/edge-encoder/s5-predict.py --ckpt <f100/best.pt> --dir <s5 dir>
"""
import argparse
import json
import os
import sys

import torch
from transformers import AutoModel, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "select", "slice4"))
import train_encoder as te  # noqa: E402


def _encode(tok, texts, dev, max_len):  # as train.py, which wrote stage 4's predictions
    e = tok(texts, padding=True, truncation=True, max_length=max_len, pad_to_multiple_of=32, return_tensors="pt")
    return e["input_ids"].to(dev), e["attention_mask"].to(dev)


te.encode = _encode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--max-len", type=int, default=384)  # train.py's default
    a = ap.parse_args()
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    units = json.load(open(os.path.join(a.dir, "units.json")))
    ids = sorted(units)
    tok = AutoTokenizer.from_pretrained(te.MODEL)
    model = te.Heads(AutoModel.from_pretrained(te.MODEL)).to(dev)
    model.load_state_dict(torch.load(a.ckpt, map_location=dev))
    preds = te.predict(model, tok, [te.text_of(units[i]["state"]) for i in ids], dev, a.max_len)
    json.dump({i: {"classifier": "encoder", "model": "f100", "answers": p} for i, p in zip(ids, preds)}, open(os.path.join(a.dir, "encoder-answers.json"), "w"))
    print("wrote %d answers (%s)" % (len(ids), dev))


if __name__ == "__main__":
    main()
