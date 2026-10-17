// A programmable local HTTP server and a collector wired to it.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector } from "../src/collector/collector.ts";
import { DEFAULT_HTTP, HttpClient, type HttpOptions } from "../src/collector/http.ts";
import { WatchSpec, type WatchSpecInput } from "../src/collector/schema.ts";
import { FsStore } from "../src/collector/store.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface TestEnv {
  base: string;
  route(path: string, h: Handler): void;
  collector: Collector;
  store: FsStore;
  spec(path: string, extra?: Partial<WatchSpecInput>): WatchSpec;
  requests: Array<{ path: string; headers: IncomingMessage["headers"] }>;
  inFlight: { now: number; max: number };
  close(): Promise<void>;
}

export async function env(http: Partial<HttpOptions> = {}): Promise<TestEnv> {
  const routes = new Map<string, Handler>();
  const requests: TestEnv["requests"] = [];
  const inFlight = { now: 0, max: 0 };
  const server = createServer(async (req, res) => {
    inFlight.now++;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    res.on("close", () => inFlight.now--);
    const path = (req.url ?? "/").split("?")[0] as string;
    requests.push({ path, headers: req.headers });
    const h = routes.get(path);
    if (!h) {
      res.writeHead(404).end("no route");
      return;
    }
    await h(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = await mkdtemp(join(tmpdir(), "unstale-test-"));
  const store = new FsStore(dir);
  const client = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000, ...http });
  let n = 0;
  return {
    base,
    route: (path, h) => void routes.set(path, h),
    collector: new Collector(client, store),
    store,
    spec: (path, extra = {}) => WatchSpec.parse({ id: `w${n++}`, url: base + path, format: "html", ...extra }),
    requests,
    inFlight,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Serve a mutable body with an ETag, answering If-None-Match with 304. */
export function versioned(type: string, initial: string) {
  const state = { body: initial, etag: true };
  const handler: Handler = (req, res) => {
    const tag = `"${createHash("sha1").update(state.body).digest("hex")}"`;
    if (state.etag && req.headers["if-none-match"] === tag) {
      res.writeHead(304, { etag: tag }).end();
      return;
    }
    res.writeHead(200, { "content-type": type, ...(state.etag ? { etag: tag } : {}) }).end(state.body);
  };
  return { state, handler };
}

export const page = (main: string, chrome = "") =>
  `<!doctype html><html><head><title>t</title><script>var x=1</script></head><body><nav>Menu ${chrome}</nav><main>${main}</main><footer>© ${chrome}</footer></body></html>`;
