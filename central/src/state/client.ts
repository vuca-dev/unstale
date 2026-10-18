// Restores a lazy member on first use. The ingest run restores only eager members (snapshot.ts); a technology's docs
// store, and the rest of its files, are restored when first read or written, by the state server (server.ts) the
// workflow starts with the state release's token, which the drain never holds. `UNSTALE_STATE_SOCKET` names the
// server's socket.
//
//   ensureLocal(`docs:<tech>`)   before a docs store is read or written (FsStore's `ready`; asynchronous)
//   techLocal(<tech>)            in the path functions of a technology's records, docs metadata, release notes,
//                                advisories, guides and extractions; synchronous (most of their readers are), so it
//                                asks the server through `curl` and waits
//
// A store without `.state/manifest.json` (an operator's store, a test) holds everything locally: nothing to do. A
// store restored from a manifest with no server reachable fails loudly instead of treating the member as new, which
// would rebaseline its pages or re-ingest its releases and then replace the saved member on the next save (the save
// refuses that too).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { centralDir } from "../pipeline/paths.ts";
import { STATE_DIR } from "./layout.ts";
import { hydratedPrints, localManifest, localPrints } from "./snapshot.ts";

const done = new Map<string, Promise<void>>();

/** The store root the state bookkeeping lives in: the parent of the central directory. */
export const stateRoot = (): string => join(centralDir(), "..");

function ask(socket: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: "POST", path: `/hydrate?key=${encodeURIComponent(key)}` }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`restoring ${key}: ${Buffer.concat(chunks).toString() || res.statusCode}`))));
    });
    req.on("error", (e) => reject(new Error(`restoring ${key}: state server unreachable at ${socket} (${e.message})`)));
    req.end();
  });
}

/** Makes the member `key` (`docs:<tech>`) local before its files are read or written. Once per key per process. */
export function ensureLocal(key: string): Promise<void> {
  let p = done.get(key);
  if (!p) {
    p = (async () => {
      const root = stateRoot();
      if (!existsSync(join(root, STATE_DIR, "manifest.json"))) return;
      const socket = process.env.UNSTALE_STATE_SOCKET;
      if (socket) return ask(socket, key);
      const saved = localManifest(root)?.members[key];
      if (saved && localPrints(root)[key] === undefined && hydratedPrints(root)[key] === undefined)
        throw new Error(`${key} is in the saved state but not restored here: run the state server (UNSTALE_STATE_SOCKET) or \`npm run state -- hydrate ${key}\``);
    })();
    p.catch(() => done.delete(key));
    done.set(key, p);
  }
  return p;
}

const techDone = new Set<string>();

/**
 * Makes the files of technology `tech` local (`tech:<tech>`) before they are read or written: once per technology per
 * process and store. Returns `tech`, so a path function can wrap its argument.
 */
export function techLocal(tech: string): string {
  const root = stateRoot();
  const memo = `${root}\0${tech}`;
  if (techDone.has(memo)) return tech;
  const key = `tech:${tech}`;
  if (existsSync(join(root, STATE_DIR, "manifest.json"))) {
    const socket = process.env.UNSTALE_STATE_SOCKET;
    if (socket) {
      const r = spawnSync("curl", ["-sS", "--fail-with-body", "--max-time", "600", "--unix-socket", socket, "-X", "POST", `http://state/hydrate?key=${encodeURIComponent(key)}`], { encoding: "utf8" });
      if (r.error) throw new Error(`restoring ${key}: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`restoring ${key}: ${(r.stdout || r.stderr || `curl exit ${r.status}`).trim()}`);
    } else {
      const saved = localManifest(root)?.members[key];
      if (saved && localPrints(root)[key] === undefined && hydratedPrints(root)[key] === undefined)
        throw new Error(`${key} is in the saved state but not restored here: run the state server (UNSTALE_STATE_SOCKET) or \`npm run state -- hydrate ${key}\``);
    }
  }
  techDone.add(memo);
  return tech;
}
