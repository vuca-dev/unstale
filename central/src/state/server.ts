// The state server: restores docs stores on first use (client.ts) for the processes of an ingest run, which do not
// hold the state release's token. It listens on a Unix socket and answers one request, `POST /hydrate?key=docs:<tech>`:
// 200 once the member is local (restored now, already here, or not in the saved state), 500 with the reason otherwise.
// It reads the store's current manifest on every request, so it follows the saves of the run's cycles.
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { kindOf } from "./layout.ts";
import type { Asset, Remote } from "./remote.ts";
import { hydrate } from "./snapshot.ts";

export function serve(root: string, remote: Remote, socket: string, log: (s: string) => void = () => {}): Promise<Server> {
  const pending = new Map<string, Promise<string>>();
  let assets: { at: number; map: Map<string, Asset> } | undefined;
  const listing = async (fresh: boolean): Promise<Map<string, Asset>> => {
    if (fresh || !assets || Date.now() - assets.at > 60_000) assets = { at: Date.now(), map: new Map((await remote.list()).map((a) => [a.name, a])) };
    return assets.map;
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://state");
    const key = url.searchParams.get("key") ?? "";
    if (req.method !== "POST" || url.pathname !== "/hydrate" || kindOf(key) !== "lazy") {
      res.writeHead(404).end("POST /hydrate?key=docs:<tech>");
      return;
    }
    let p = pending.get(key);
    if (!p) {
      const t0 = Date.now();
      p = hydrate(root, remote, key, listing).then((r) => {
        if (r === "restored") log(`restored ${key} in ${Date.now() - t0} ms`);
        return r;
      });
      p.finally(() => pending.delete(key)).catch(() => {});
      pending.set(key, p);
    }
    p.then(
      (r) => res.writeHead(200).end(r),
      (e: unknown) => {
        log(`restoring ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
        assets = undefined;
        res.writeHead(500).end(e instanceof Error ? e.message : String(e));
      },
    );
  });
  if (existsSync(socket)) unlinkSync(socket);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve(server));
  });
}
