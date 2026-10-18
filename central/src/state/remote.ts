// Where state generations live: the assets of the `catalog-state` draft release (GitHub), or a directory (tests and a
// local rehearsal). `UNSTALE_STATE_REMOTE` is `github:<owner>/<repo>#<release id>` (token: GH_TOKEN) or `dir:<path>`.
//
// GitHub: a download asks the API once for the asset's signed URL (valid an hour; kept for 30 minutes) and reads byte
// ranges from it, so restoring a member costs one ranged read and no API request when its segment was read recently.
// Uploads go through curl as the tarball saves did; a failed upload's leftover asset is deleted before the retry.
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sleep } from "../pipeline/util.ts";

export interface Asset {
  id: string;
  name: string;
  size: number;
}

export interface Remote {
  list(): Promise<Asset[]>;
  /** Bytes [start, end) of an asset, or all of it. */
  read(asset: Asset, start?: number, end?: number): Promise<Buffer>;
  /** Bytes [start, end) of an asset, or all of it, into a file. */
  download(asset: Asset, file: string, start?: number, end?: number): Promise<void>;
  upload(file: string, name: string): Promise<void>;
  remove(asset: Asset): Promise<void>;
}

export class DirRemote implements Remote {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  async list(): Promise<Asset[]> {
    return readdirSync(this.dir)
      .filter((n) => !n.startsWith("."))
      .map((name) => ({ id: name, name, size: statSync(join(this.dir, name)).size }));
  }
  async read(asset: Asset, start = 0, end = asset.size): Promise<Buffer> {
    const b = Buffer.alloc(end - start);
    const fd = openSync(join(this.dir, asset.id), "r");
    try {
      let n = 0;
      while (n < b.length) {
        const r = readSync(fd, b, n, b.length - n, start + n);
        if (r === 0) throw new Error(`${asset.name}: short read`);
        n += r;
      }
    } finally {
      closeSync(fd);
    }
    return b;
  }
  async download(asset: Asset, file: string, start = 0, end = asset.size): Promise<void> {
    if (end <= start) return void (await pipeline(Readable.from([]), createWriteStream(file)));
    await pipeline(createReadStream(join(this.dir, asset.id), { start, end: end - 1 }), createWriteStream(file));
  }
  async upload(file: string, name: string): Promise<void> {
    copyFileSync(file, join(this.dir, `.${name}.part`));
    copyFileSync(join(this.dir, `.${name}.part`), join(this.dir, name));
    unlinkSync(join(this.dir, `.${name}.part`));
  }
  async remove(asset: Asset): Promise<void> {
    if (existsSync(join(this.dir, asset.id))) unlinkSync(join(this.dir, asset.id));
  }
}

export class GithubRemote implements Remote {
  readonly repo: string;
  readonly release: string;
  private readonly token: string;
  private readonly api: string;
  private readonly signed = new Map<string, { url: string; at: number }>();
  constructor(repo: string, release: string, token: string, api = process.env.GITHUB_API_URL ?? "https://api.github.com") {
    this.repo = repo;
    this.release = release;
    this.token = token;
    this.api = api.replace(/\/$/, "");
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.api}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(init.headers as Record<string, string>) },
      }).catch((e: unknown) => ({ ok: false, status: 0, statusText: String(e) }) as Response);
      if (res.status !== 0 && res.status < 500) return res;
      if (attempt >= 3) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${res.statusText}`);
      await sleep(2000 * 2 ** attempt);
    }
  }

  async list(): Promise<Asset[]> {
    const out: Asset[] = [];
    for (let page = 1; ; page++) {
      const res = await this.call(`/repos/${this.repo}/releases/${this.release}/assets?per_page=100&page=${page}`);
      if (!res.ok) throw new Error(`listing release assets: ${res.status} ${await res.text()}`);
      const batch = (await res.json()) as Array<{ id: number; name: string; size: number; state?: string }>;
      for (const a of batch) if (a.state === undefined || a.state === "uploaded") out.push({ id: String(a.id), name: a.name, size: a.size });
      if (batch.length < 100) return out;
    }
  }

  private async url(asset: Asset, fresh = false): Promise<string> {
    const kept = this.signed.get(asset.id);
    if (kept && !fresh && Date.now() - kept.at < 30 * 60 * 1000) return kept.url;
    const res = await this.call(`/repos/${this.repo}/releases/assets/${asset.id}`, { headers: { accept: "application/octet-stream" }, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) throw new Error(`${asset.name}: no download location (${res.status})`);
    this.signed.set(asset.id, { url: location, at: Date.now() });
    return location;
  }

  private async ranged(asset: Asset, start: number, end: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(await this.url(asset, attempt > 0), { headers: { range: `bytes=${start}-${end - 1}` } }).catch(
        (e: unknown) => ({ ok: false, status: 0, statusText: String(e) }) as Response,
      );
      const whole = start === 0 && end === asset.size;
      if (res.status === 206 || (res.status === 200 && whole)) return res;
      if (attempt >= 3) throw new Error(`${asset.name} bytes ${start}-${end}: ${res.status} ${res.statusText}`);
      await sleep(2000 * 2 ** attempt);
    }
  }

  async read(asset: Asset, start = 0, end = asset.size): Promise<Buffer> {
    if (end <= start) return Buffer.alloc(0);
    const b = Buffer.from(await (await this.ranged(asset, start, end)).arrayBuffer());
    if (b.length !== end - start) throw new Error(`${asset.name}: read ${b.length} bytes, expected ${end - start}`);
    return b;
  }

  async download(asset: Asset, file: string, start = 0, end = asset.size): Promise<void> {
    if (end <= start) return void (await pipeline(Readable.from([]), createWriteStream(file)));
    const res = await this.ranged(asset, start, end);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(file));
    if (statSync(file).size !== end - start) throw new Error(`${asset.name}: downloaded ${statSync(file).size} bytes, expected ${end - start}`);
  }

  /** As the tarball saves did: curl, the token on stdin (never in the process list). */
  async upload(file: string, name: string): Promise<void> {
    const url = `https://uploads.github.com/repos/${this.repo}/releases/${this.release}/assets?name=${encodeURIComponent(name)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn("curl", ["-fsS", "-X", "POST", "-H", "@-", "-H", "Content-Type: application/octet-stream", "-T", file, "-o", "/dev/null", url], { stdio: ["pipe", "inherit", "inherit"] });
          p.on("error", reject);
          p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`upload ${name}: curl exit ${code}`))));
          p.stdin.end(`Authorization: Bearer ${this.token}\n`);
        });
        return;
      } catch (e) {
        if (attempt >= 3) throw e;
        await sleep(2000 * 2 ** attempt);
        // A failed upload can leave an asset of that name behind, which would refuse the retry.
        const res = await this.call(`/repos/${this.repo}/releases/${this.release}/assets?per_page=100`);
        const left = res.ok ? ((await res.json()) as Array<{ id: number; name: string }>).find((a) => a.name === name) : undefined;
        if (left) await this.call(`/repos/${this.repo}/releases/assets/${left.id}`, { method: "DELETE" });
      }
    }
  }

  async remove(asset: Asset): Promise<void> {
    const res = await this.call(`/repos/${this.repo}/releases/assets/${asset.id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`deleting ${asset.name}: ${res.status}`);
  }
}

export function remoteFromEnv(env: NodeJS.ProcessEnv = process.env): Remote {
  const spec = env.UNSTALE_STATE_REMOTE;
  if (!spec) throw new Error("UNSTALE_STATE_REMOTE is not set (github:<owner>/<repo>#<release id> or dir:<path>)");
  if (spec.startsWith("dir:")) return new DirRemote(spec.slice(4));
  const m = /^github:([^#]+)#(\d+)$/.exec(spec);
  if (!m) throw new Error(`UNSTALE_STATE_REMOTE: ${spec} is neither github:<owner>/<repo>#<release id> nor dir:<path>`);
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN is not set: the state release needs the workflow's token");
  return new GithubRemote(m[1]!, m[2]!, env.GH_TOKEN);
}
