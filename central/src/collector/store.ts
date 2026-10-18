// Content-addressed snapshot store: each distinct normalized text is stored once (Brotli),
// and each watch has a small state file pointing at its current snapshot and history.
// The interface lets object storage replace the filesystem later.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { sha256 } from "./normalize.ts";
import { WatchState } from "./schema.ts";

export interface Store {
  putBlob(text: string): Promise<string>;
  getBlob(hash: string): Promise<string>;
  getState(id: string): Promise<WatchState | undefined>;
  putState(id: string, state: WatchState): Promise<void>;
}

export class FsStore implements Store {
  readonly root: string;
  /** Awaited before every read and write: makes the store local first (a docs store restored on first use). */
  private readonly ready: () => Promise<void>;
  constructor(root: string, ready: () => Promise<void> = async () => {}) {
    this.root = root;
    this.ready = ready;
  }

  #blobPath(hash: string) {
    return join(this.root, "blobs", hash.slice(0, 2), `${hash}.br`);
  }

  #statePath(id: string) {
    return join(this.root, "state", `${encodeURIComponent(id)}.json`);
  }

  async putBlob(text: string): Promise<string> {
    await this.ready();
    const hash = sha256(text);
    const path = this.#blobPath(hash);
    try {
      await readFile(path);
      return hash; // already stored
    } catch {
      await mkdir(join(this.root, "blobs", hash.slice(0, 2)), { recursive: true });
      const data = brotliCompressSync(Buffer.from(text), {
        params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_QUALITY]: 6 },
      });
      await atomicWrite(path, data);
      return hash;
    }
  }

  async getBlob(hash: string): Promise<string> {
    await this.ready();
    return brotliDecompressSync(await readFile(this.#blobPath(hash))).toString("utf8");
  }

  /** Missing state is undefined. Unreadable state is moved aside and treated as missing, so one corrupt file cannot stop a run. */
  async getState(id: string): Promise<WatchState | undefined> {
    await this.ready();
    const path = this.#statePath(id);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      return WatchState.parse(JSON.parse(raw));
    } catch {
      await rename(path, `${path}.corrupt-${Date.now()}`);
      return undefined;
    }
  }

  async putState(id: string, state: WatchState): Promise<void> {
    await this.ready();
    await mkdir(join(this.root, "state"), { recursive: true });
    await atomicWrite(this.#statePath(id), JSON.stringify(state, null, 1));
  }
}

async function atomicWrite(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
