"""Edge encoder, stage 1: CPU and footprint of a trained step-D encoder, as the client would run it.

Exports the checkpoint to ONNX (fp32, then dynamic int8), and for each variant measures, in a fresh process each:
file size, cold start (session load), peak RSS, records/s and p95 batch latency at 1, 2 and 4 threads on real record
states, plus the int8-vs-fp32 disagreement on the same states. No model calls.

  eval/select/out/venv/bin/python eval/edge-encoder/footprint.py --ckpt <best.pt> --data <data.jsonl> --out <dir>
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "select", "slice4"))
import train_encoder as te  # noqa: E402  (Heads, text_of, MODEL)

MAX_LEN = 384  # what training truncates to


def texts_of(data, n):
    out = []
    for line in open(data):
        if line.strip():
            out.append(te.text_of(json.loads(line)["state"]))
            if len(out) >= n:
                break
    return out


def export(ckpt, out):
    import torch
    from transformers import AutoModel, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(te.MODEL)
    m = te.Heads(AutoModel.from_pretrained(te.MODEL, attn_implementation="eager"))
    m.load_state_dict(torch.load(ckpt, map_location="cpu"))
    m.eval()
    e = tok(["technology: x\nsummary: y"] * 2, padding="max_length", max_length=32, return_tensors="pt")
    fp32 = os.path.join(out, "encoder.fp32.onnx")
    torch.onnx.export(m, (e["input_ids"], e["attention_mask"]), fp32, input_names=["ids", "mask"],
                      output_names=["ct", "sf", "bin"], dynamic_axes={"ids": {0: "b", 1: "t"}, "mask": {0: "b", 1: "t"}},
                      opset_version=17, dynamo=False)
    from onnxruntime.quantization import QuantType, quantize_dynamic
    int8 = os.path.join(out, "encoder.int8.onnx")
    quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8)
    tok.save_pretrained(os.path.join(out, "tokenizer"))
    return fp32, int8


def measure(variant, path, threads, data, out, n):
    """Runs in its own process: cold start, throughput, latency, peak RSS."""
    import numpy as np
    import onnxruntime as ort
    import psutil
    from transformers import AutoTokenizer
    proc = psutil.Process()
    rss0 = proc.memory_info().rss
    t0 = time.time()
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    tok = AutoTokenizer.from_pretrained(os.path.join(out, "tokenizer"))
    cold = time.time() - t0
    texts = texts_of(data, n)
    lens = [len(tok(t, truncation=True, max_length=MAX_LEN)["input_ids"]) for t in texts]
    # Length-sorted batches, as the client would do (padding waste is the main cost otherwise).
    order = sorted(range(len(texts)), key=lambda i: lens[i])
    bs = 16
    lat = []
    peak = proc.memory_info().rss
    t1 = time.time()
    outs = {}
    for i in range(0, len(order), bs):
        idx = order[i:i + bs]
        e = tok([texts[j] for j in idx], padding=True, truncation=True, max_length=MAX_LEN, return_tensors="np")
        b0 = time.time()
        ct, sf, b = s.run(None, {"ids": e["input_ids"].astype(np.int64), "mask": e["attention_mask"].astype(np.int64)})
        lat.append(time.time() - b0)
        peak = max(peak, proc.memory_info().rss)
        for k, j in enumerate(idx):
            outs[j] = (int(ct[k].argmax()), int(sf[k].argmax()), (1 / (1 + np.exp(-b[k]))).tolist())
    total = time.time() - t1
    lat.sort()
    res = {"variant": variant, "threads": threads, "file_mb": os.path.getsize(path) / 1e6, "cold_start_s": cold,
           "records": len(texts), "records_per_s": len(texts) / total,
           "p50_batch_s": lat[len(lat) // 2], "p95_batch_s": lat[int(len(lat) * 0.95)],
           "peak_rss_mb": peak / 1e6, "rss_before_load_mb": rss0 / 1e6,
           "tokens_mean": sum(lens) / len(lens), "tokens_p95": sorted(lens)[int(len(lens) * 0.95)],
           "truncated_share": sum(1 for x in lens if x >= MAX_LEN) / len(lens)}
    json.dump({"res": res, "outs": {str(k): v for k, v in outs.items()}}, open(os.path.join(out, f"m-{variant}-{threads}.json"), "w"))
    print(json.dumps(res), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=800)
    ap.add_argument("--measure", nargs=2)  # internal: variant path
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.measure:
        return measure(a.measure[0], a.measure[1], a.threads, a.data, a.out, a.n)
    fp32, int8 = export(a.ckpt, a.out)
    rows = []
    for variant, path in (("fp32", fp32), ("int8", int8)):
        for th in (1, 2, 4):
            r = subprocess.run([sys.executable, __file__, "--data", a.data, "--out", a.out, "--n", str(a.n),
                                "--measure", variant, path, "--threads", str(th)], capture_output=True, text=True)
            if r.returncode:
                print(r.stderr[-3000:])
                raise SystemExit(1)
            rows.append(json.loads(r.stdout.strip().splitlines()[-1]))
    # int8 against fp32 on the same states (4-thread runs).
    f = json.load(open(os.path.join(a.out, "m-fp32-4.json")))["outs"]
    q = json.load(open(os.path.join(a.out, "m-int8-4.json")))["outs"]
    n = len(f)
    flips = {"change_type": sum(f[k][0] != q[k][0] for k in f) / n, "surface": sum(f[k][1] != q[k][1] for k in f) / n,
             "breaking@0.5": sum((f[k][2][0] >= .5) != (q[k][2][0] >= .5) for k in f) / n,
             "max_abs_dp_binary": max(abs(x - y) for k in f for x, y in zip(f[k][2], q[k][2]))}
    json.dump({"runs": rows, "int8_vs_fp32": flips}, open(os.path.join(a.out, "footprint.json"), "w"), indent=1)
    print(json.dumps({"int8_vs_fp32": flips}, indent=1))


if __name__ == "__main__":
    main()
