"""A loopback stand-in for a provider, for the free checks of the port parity run (PREREGISTRATION.md). No model call.

    python3 recorder.py --port 8791 --log OUT.jsonl [--replay TABLE.json]

It records the sha256 of every request body it receives (and, for a chat request, of the prompt text), so the client's
requests can be compared with central's byte for byte. For the labelling service (`POST /v1/systemone`) it answers a
request whose body's sha256 is in the replay table with central's stored answer for that same request, and refuses
any other (HTTP 400), so only byte-identical requests are answered. A chat request gets an empty answer (`[]`).
"""
import argparse, hashlib, json, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, required=True)
ap.add_argument("--log", required=True)
ap.add_argument("--replay")
a = ap.parse_args()
table = json.load(open(a.replay)) if a.replay else {}
lock = threading.Lock()
log = open(a.log, "a")
sha = lambda b: hashlib.sha256(b).hexdigest()


class H(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        h = sha(body)
        row = {"path": self.path, "body_sha256": h, "bytes": len(body)}
        status, out = 200, None
        if self.path.endswith("/systemone"):
            hit = table.get(h)
            row["replayed"] = hit is not None
            if hit is None:
                status, out = 400, {"error": "no stored answer for this request"}
            else:
                out = hit
        else:
            try:
                j = json.loads(body)
                content = j["messages"][0]["content"]
                row["prompt_sha256"] = sha(content.encode())
                row["prompt_chars"] = len(content)
                row["fields"] = {k: v for k, v in j.items() if k != "messages"}
            except Exception as e:  # noqa: BLE001
                row["unreadable"] = str(e)
            out = {"model": "recorder", "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "[]"}}],
                   "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        with lock:
            log.write(json.dumps(row) + "\n")
            log.flush()
        data = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
