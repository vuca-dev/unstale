// State snapshots (src/state/): the deterministic tar, the member layout, save and restore against a directory remote
// (incremental saves, docs stores restored on first use through the state server, the refusal to save a docs store
// that was never restored, log rotation, compaction, retention) and the legacy tarball generation.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { brotliCompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureLocal } from "../src/state/client.ts";
import { bucketCount, excluded, memberOf, TARGET_MEMBER } from "../src/state/layout.ts";
import { DirRemote } from "../src/state/remote.ts";
import { serve } from "../src/state/server.ts";
import { hydrate, localManifest, restore, retain, save, walk, type Manifest } from "../src/state/snapshot.ts";
import { pack, unpack } from "../src/state/tar.ts";
import { docsStore } from "../src/docs/monitor.ts";

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `unstale-state-${p}-`));
const put = (root: string, rel: string, body: string | Buffer): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
/** Every snapshot file of a store, path -> content. */
const contents = (root: string): Record<string, string> => Object.fromEntries(walk(root).map((f) => [f.rel, readFileSync(join(root, f.rel), "utf8")]));
const assets = (dir: string): string[] => readdirSync(dir).filter((n) => !n.startsWith(".")).sort();

function seed(root: string): void {
  put(root, "central/records/next.json", JSON.stringify({ records: { a: 1 } }));
  put(root, "central/records/vite.json", JSON.stringify({ records: { b: 2 } }));
  put(root, "central/cache/llm/ab/ab12.json", "{\"text\":\"x\"}");
  put(root, "central/docs/next/state.json", "{\"pages\":{}}");
  put(root, "central/docs/next/store/blobs/aa/aa11.br", brotliCompressSync("page one"));
  put(root, "central/docs/next/store/state/https%3A%2F%2Fnextjs.org%2Fdocs%20html.json", "{\"configHash\":\"c\",\"snapshot\":\"aa11\"}");
  put(root, "central/docs/vite/store/blobs/bb/bb22.br", "page two");
  put(root, "catalog/v1/root.json", "{}");
  put(root, "catalog/v1/shards/next/16.abc.jsonl.gz", "shard");
  put(root, "central/usage.jsonl", "");
  // Left out: a live lock, the dead codex cache, the day's page cache, an interrupted write, macOS metadata.
  put(root, "central/records/next.lock", "123");
  put(root, "central/cache/codex/00/x.json", "{}");
  put(root, "central/cache/pages/00/x.br", "x");
  put(root, "central/records/next.json.4242.tmp", "partial");
  put(root, "central/records/._next.json", "meta");
}

const previousEnv = { store: process.env.UNSTALE_STORE, central: process.env.UNSTALE_CENTRAL_DIR, socket: process.env.UNSTALE_STATE_SOCKET };
afterEach(() => {
  for (const [k, v] of [["UNSTALE_STORE", previousEnv.store], ["UNSTALE_CENTRAL_DIR", previousEnv.central], ["UNSTALE_STATE_SOCKET", previousEnv.socket]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("tar", () => {
  test("the same files give the same bytes in any order, long paths included", () => {
    const long = `central/docs/x/store/state/${"https%3A%2F%2Fexample.com%2F".repeat(8)}page.json`;
    const a = pack([{ path: "b/two", data: Buffer.from("2") }, { path: long, data: Buffer.from("long") }, { path: "a/one", data: Buffer.alloc(0) }]);
    const b = pack([{ path: "a/one", data: Buffer.alloc(0) }, { path: "b/two", data: Buffer.from("2") }, { path: long, data: Buffer.from("long") }]);
    expect(a.equals(b)).toBe(true);
    expect(unpack(a).map((e) => [e.path, Buffer.from(e.data).toString()])).toEqual([["a/one", ""], ["b/two", "2"], [long, "long"]]);
  });

  test("system tar reads it", () => {
    const dir = tmp("tar");
    const long = `d/${"x".repeat(150)}/f.json`;
    writeFileSync(join(dir, "m.tar"), pack([{ path: long, data: Buffer.from("{}") }, { path: "a.txt", data: Buffer.from("a") }]));
    expect(execFileSync("tar", ["-tf", join(dir, "m.tar")], { encoding: "utf8" }).trim().split("\n")).toEqual(["a.txt", long]);
  });

  test("a path out of the store is refused", () => {
    expect(() => unpack(pack([{ path: "../escape", data: Buffer.from("x") }]))).toThrow(/unsafe path/);
  });
});

describe("layout", () => {
  test("docs stores are lazy members, archives whole, everything else eager buckets", () => {
    const one = (): number => 1;
    expect(memberOf("central/docs/next/store/blobs/aa/aa11.br", one)).toBe("docs:next");
    expect(memberOf("central/docs/next/state.json", one)).toBe("central/docs@1/0");
    expect(memberOf("central/archive/usage-2026-09.jsonl", one)).toBe("archive:usage-2026-09.jsonl");
    expect(memberOf("catalog/v1/shards/next/16.abc.jsonl.gz", () => 4)).toMatch(/^catalog\/v1@4\/[0-3]$/);
    for (const p of ["central/cache/codex/00/x.json", "central/cache/pages/00/x.br", "central/records/next.lock", "central/sample/x/y", "central/onboarding/documents/a", ".state/manifest.json", "a/b.123.tmp", "a/._b"])
      expect(excluded(p), p).toBe(true);
    expect(excluded("central/records/next.json")).toBe(false);
  });

  test("bucket counts follow the area's size with hysteresis", () => {
    expect(bucketCount(0, undefined)).toBe(1);
    expect(bucketCount(100 * TARGET_MEMBER, undefined)).toBe(128);
    expect(bucketCount(150 * TARGET_MEMBER, 128)).toBe(128); // within a factor of 2: kept
    expect(bucketCount(300 * TARGET_MEMBER, 128)).toBe(512);
    expect(bucketCount(20 * TARGET_MEMBER, 128)).toBe(32);
  });
});

describe("save and restore", () => {
  let remoteDir: string;
  let remote: DirRemote;
  beforeEach(() => {
    remoteDir = tmp("remote");
    remote = new DirRemote(remoteDir);
  });

  test("a full restore gives back every file but the excluded ones; a second save uploads only the manifest", async () => {
    const a = tmp("a");
    seed(a);
    const first = await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    expect(first.written).toBe(first.members);
    const b = join(tmp("b"), "store");
    const r = await restore(b, remote, { all: true });
    expect(r).toMatchObject({ kind: "v2", deferred: 0 });
    expect(contents(b)).toEqual(contents(a));
    expect(existsSync(join(b, "central/cache/codex"))).toBe(false);
    expect(existsSync(join(b, "central/records/next.lock"))).toBe(false);

    const second = await save(a, remote, { generation: "state-20261018T001500Z-1-1" });
    expect(second).toMatchObject({ written: 0, segments: 1 });
    expect(assets(remoteDir).filter((n) => n.includes(".seg"))).toEqual(["state-20261018T000000Z-1-1.seg00"]);
    // The same run's earlier generation is replaced; its segment stays while referenced.
    expect(assets(remoteDir)).toEqual(["state-20261018T000000Z-1-1.seg00", "state-20261018T001500Z-1-1.json"]);
  });

  test("a run restores eager members, a docs store on first use, and saves only what changed", async () => {
    const a = tmp("a");
    seed(a);
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    const b = join(tmp("b"), "store");
    const r = await restore(b, remote);
    expect(r.deferred).toBe(2);
    expect(existsSync(join(b, "central/records/next.json"))).toBe(true);
    expect(existsSync(join(b, "central/docs/next/store"))).toBe(false);

    // The docs code reads through the state server, as the drain does.
    process.env.UNSTALE_STORE = b;
    delete process.env.UNSTALE_CENTRAL_DIR;
    const socket = join(mkdtempSync("/tmp/us-"), "s");
    const server = await serve(b, remote, socket);
    process.env.UNSTALE_STATE_SOCKET = socket;
    try {
      expect((await docsStore("next").getState("https://nextjs.org/docs html"))?.snapshot).toBe("aa11");
      expect(await docsStore("next").getBlob("aa11")).toBe("page one");
      // A technology the saved state never had starts empty.
      expect(await docsStore("brand-new").getState("x")).toBeUndefined();
    } finally {
      server.close();
    }
    expect(existsSync(join(b, "central/docs/vite/store"))).toBe(false);

    put(b, "central/records/next.json", JSON.stringify({ records: { a: 1, c: 3 } }));
    put(b, "central/docs/next/store/blobs/cc/cc33.br", "page one, changed");
    const s = await save(b, remote, { generation: "state-20261018T030000Z-2-1" });
    expect(s).toMatchObject({ written: 2, cold: 1 });

    const c = join(tmp("c"), "store");
    await restore(c, remote, { all: true });
    expect(contents(c)).toEqual({ ...contents(a), "central/records/next.json": JSON.stringify({ records: { a: 1, c: 3 } }), "central/docs/next/store/blobs/cc/cc33.br": "page one, changed" });
  });

  test("a docs store written without being restored is never saved over the saved one", async () => {
    const a = tmp("a");
    seed(a);
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    const b = join(tmp("b"), "store");
    await restore(b, remote);
    put(b, "central/docs/vite/store/blobs/dd/dd44.br", "a partial store");
    await expect(save(b, remote, { generation: "state-20261018T030000Z-2-1" })).rejects.toThrow(/was not restored/);
    expect(assets(remoteDir).filter((n) => n.endsWith(".json"))).toEqual(["state-20261018T000000Z-1-1.json"]);
  });

  test("without the state server a docs store that is in the saved state fails loudly; an operator store needs none", async () => {
    const a = tmp("a");
    seed(a);
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    const b = join(tmp("b"), "store");
    await restore(b, remote);
    process.env.UNSTALE_STORE = b;
    delete process.env.UNSTALE_CENTRAL_DIR;
    delete process.env.UNSTALE_STATE_SOCKET;
    await expect(ensureLocal("docs:vite")).rejects.toThrow(/not restored here/);
    expect(await hydrate(b, remote, "docs:vite")).toBe("restored");
    await expect(ensureLocal("docs:vite")).resolves.toBeUndefined();
    expect(readFileSync(join(b, "central/docs/vite/store/blobs/bb/bb22.br"), "utf8")).toBe("page two");

    const operator = tmp("operator");
    seed(operator);
    process.env.UNSTALE_STORE = operator;
    await expect(ensureLocal("docs:next")).resolves.toBeUndefined();
  });

  test("months of append-only logs move to archive members, which a run does not restore", async () => {
    const a = tmp("a");
    seed(a);
    const line = (at: string): string => JSON.stringify({ api: "jev", input_tokens: 1, at });
    put(a, "central/usage.jsonl", [line("2026-09-30T23:59:00Z"), line("2026-10-01T00:00:01Z"), "not json"].join("\n") + "\n");
    const s = await save(a, remote, { generation: "state-20261018T000000Z-1-1", now: new Date("2026-10-18T00:00:00Z") });
    expect(s.rotated).toEqual(["usage-2026-09.jsonl"]);
    expect(readFileSync(join(a, "central/usage.jsonl"), "utf8")).toBe(`${line("2026-10-01T00:00:01Z")}\nnot json\n`);
    const b = join(tmp("b"), "store");
    await restore(b, remote);
    expect(existsSync(join(b, "central/archive"))).toBe(false);
    const again = await save(b, remote, { generation: "state-20261018T030000Z-2-1", now: new Date("2026-10-18T03:00:00Z") });
    expect(again).toMatchObject({ written: 0, cold: 3 });
    expect(await hydrate(b, remote, "archive:usage-2026-09.jsonl")).toBe("restored");
    expect(readFileSync(join(b, "central/archive/usage-2026-09.jsonl"), "utf8")).toBe(`${line("2026-09-30T23:59:00Z")}\n`);
  });

  test("a segment less than half live is compacted into the new one, and deleted once no kept manifest needs it", async () => {
    const a = tmp("a");
    seed(a);
    put(a, "central/records/big.json", randomBytes(150_000).toString("base64"));
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    put(a, "central/records/big.json", randomBytes(150_000).toString("base64"));
    // The rewritten member lands in a new segment and the rest of the first one is copied after it.
    const s = await save(a, remote, { generation: "state-20261018T030000Z-2-1", keep: 1 });
    expect(s.compacted).toBeGreaterThan(0);
    expect(s.segments).toBe(1);
    expect(assets(remoteDir)).toEqual(["state-20261018T030000Z-2-1.json", "state-20261018T030000Z-2-1.seg00"]);
    const b = join(tmp("b"), "store");
    await restore(b, remote, { all: true });
    expect(contents(b)).toEqual(contents(a));
  });

  test("retention keeps the newest generation of the newest runs and the segments they reference", async () => {
    const a = tmp("a");
    seed(a);
    for (const [i, g] of ["state-20261018T000000Z-1-1", "state-20261018T030000Z-2-1", "state-20261018T060000Z-3-1", "state-20261018T061500Z-3-1"].entries()) {
      put(a, "central/records/next.json", `{"v":${i}}`);
      await save(a, remote, { generation: g, keep: 2 });
    }
    writeFileSync(join(remoteDir, "unrelated.bin"), "kept");
    writeFileSync(join(remoteDir, "state-20261018T090000Z-4-1.seg00"), "an interrupted save's segment");
    const m = JSON.parse(readFileSync(join(remoteDir, "state-20261018T061500Z-3-1.json"), "utf8")) as Manifest;
    await retain(remote, "state-20261018T061500Z-3-1", 2);
    const left = assets(remoteDir);
    expect(left.filter((n) => n.endsWith(".json"))).toEqual(["state-20261018T030000Z-2-1.json", "state-20261018T061500Z-3-1.json"]);
    for (const seg of Object.keys(m.segments)) expect(left).toContain(seg);
    expect(left).toContain("unrelated.bin");
    expect(left).not.toContain("state-20261018T090000Z-4-1.seg00");
  });

  test("a legacy tarball generation restores whole, and the next save starts the manifest", async () => {
    const a = tmp("a");
    seed(a);
    const gen = "state-20261017T000000Z-0-1";
    execFileSync("sh", ["-c", `tar -C "$0" -cf - central catalog | zstd -q -3 | split -b 200 -a 2 - "$1/${gen}.tar.zst."`, a, remoteDir]);
    execFileSync("sh", ["-c", `cd "$0" && for f in ${gen}.tar.zst.*; do printf '%s  %s\\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done > ${gen}.sha256`, remoteDir]);
    const b = join(tmp("b"), "store");
    const r = await restore(b, remote);
    expect(r.kind).toBe("legacy");
    expect(existsSync(join(b, "central/records/._next.json"))).toBe(false);
    const s = await save(b, remote, { generation: "state-20261018T000000Z-1-1" });
    expect(s.written).toBe(s.members);
    expect(localManifest(b)?.generation).toBe("state-20261018T000000Z-1-1");
    const c = join(tmp("c"), "store");
    await restore(c, remote, { all: true });
    expect(contents(c)).toEqual(contents(a));
  });

  test("tarball-format assets survive migration, retention and compaction, so a revert restores from them", async () => {
    const a = tmp("a");
    seed(a);
    const legacy = ["state-20261017T000000Z-0-1", "state-20261017T030000Z-9-1", "state-20261017T060000Z-8-1"];
    for (const gen of legacy) {
      execFileSync("sh", ["-c", `tar -C "$0" -cf - central catalog | zstd -q -3 | split -b 200 -a 2 - "$1/${gen}.tar.zst."`, a, remoteDir]);
      execFileSync("sh", ["-c", `cd "$0" && for f in ${gen}.tar.zst.*; do printf '%s  %s\\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; done > ${gen}.sha256`, remoteDir]);
    }
    const before = assets(remoteDir);
    const b = join(tmp("b"), "store");
    expect((await restore(b, remote)).kind).toBe("legacy");
    // Migration, then more runs than `keep`, each rewriting a large member so compaction runs too.
    for (const [i, g] of ["state-20261018T000000Z-1-1", "state-20261018T030000Z-2-1", "state-20261018T060000Z-3-1", "state-20261018T090000Z-4-1"].entries()) {
      put(b, "central/records/big.json", randomBytes(100_000 + i).toString("base64"));
      await save(b, remote, { generation: g, keep: 1 });
    }
    for (const n of before) expect(assets(remoteDir)).toContain(n);
    expect(readFileSync(join(remoteDir, `${legacy[2]}.sha256`), "utf8")).toContain(`${legacy[2]}.tar.zst.aa`);
    await expect(remote.upload(join(remoteDir, `${legacy[0]}.sha256`), `${legacy[0]}.sha256`)).rejects.toThrow(/never replaced/);
  });

  test("a save that fails partway leaves the previous generation complete and restorable", async () => {
    const a = tmp("a");
    seed(a);
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    const want = contents(a);
    // Uploads fail after the first: the new segment lands, its manifest never does.
    let uploads = 0;
    const flaky = Object.assign(Object.create(remote) as DirRemote, {
      upload: async (file: string, name: string): Promise<void> => {
        if (uploads++ >= 1) throw new Error("connection reset");
        return remote.upload(file, name);
      },
    });
    put(a, "central/records/next.json", JSON.stringify({ records: { a: 1, changed: true } }));
    put(a, "central/docs/next/store/blobs/ee/ee55.br", "a new page");
    await expect(save(a, flaky, { generation: "state-20261018T001500Z-1-1" })).rejects.toThrow(/connection reset/);
    expect(assets(remoteDir)).toContain("state-20261018T001500Z-1-1.seg00");
    expect(assets(remoteDir)).not.toContain("state-20261018T001500Z-1-1.json");
    // A killed upload leaves a half-written asset, which no listing counts as uploaded.
    writeFileSync(join(remoteDir, ".state-20261018T001500Z-1-1.json.part"), "{\"half");
    expect(localManifest(a)?.generation).toBe("state-20261018T000000Z-1-1");
    const b = join(tmp("b"), "store");
    expect(await restore(b, remote, { all: true })).toMatchObject({ generation: "state-20261018T000000Z-1-1" });
    expect(contents(b)).toEqual(want);

    // The next save succeeds, carries the change, and drops the interrupted save's segment.
    const s = await save(a, remote, { generation: "state-20261018T003000Z-1-1" });
    expect(s.deleted).toEqual(expect.arrayContaining(["state-20261018T001500Z-1-1.seg00", "state-20261018T001500Z-1-1.json"]));
    expect(readdirSync(remoteDir).filter((n) => n.endsWith(".part"))).toEqual([]);
    const c = join(tmp("c"), "store");
    await restore(c, remote, { all: true });
    expect(contents(c)).toEqual(contents(a));
  });

  test("a store whose files only changed their times is not rewritten", async () => {
    const a = tmp("a");
    seed(a);
    await save(a, remote, { generation: "state-20261018T000000Z-1-1" });
    const p = join(a, "central/records/next.json");
    utimesSync(p, new Date(), new Date(statSync(p).mtimeMs + 60_000));
    expect((await save(a, remote, { generation: "state-20261018T001500Z-1-1" })).written).toBe(0);
    rmSync(join(a, "central/records/vite.json"));
    const s = await save(a, remote, { generation: "state-20261018T003000Z-1-1" });
    expect(s.written).toBe(1);
  });
});
