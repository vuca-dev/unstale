// Packing (scripts/pack.ts) and serving packed files (src/assets.ts): the deployed file count stays under the limit
// whatever the catalog holds, the files clients ask for most stay as they are, and every packed file is answered as
// the asset layer answers it unpacked (bytes, ETag, headers, 304, HEAD, redirects into page directories and to the
// canonical encoding of a path). The asset layer is a stand-in here (`layer`, after Cloudflare's asset-worker); the
// real one is compared with scripts/compare-catalog.ts under wrangler dev.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { assetHash, headerRules, pack } from "../scripts/pack.ts";
import { asset, resetAssetCaches } from "../src/assets.ts";
import { handle, page, type Env } from "../src/index.ts";
import { BUCKETS, bucketOf, groupOf, packable, readPacked } from "../src/pack.ts";

beforeEach(() => resetAssetCaches());

const HEADERS = `/*
  X-Content-Type-Options: nosniff

/*.md
  Content-Type: text/markdown; charset=utf-8
`;

/** A catalog tree: `n` technologies, each with an index naming one shard, its signature, an older shard in its grace
 * period, a coverage status, and a website page with its Markdown twin (one scoped package). */
function tree(n: number, extra: Record<string, string> = {}): string {
  const site = mkdtempSync(join(tmpdir(), "pack-"));
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(site, path)), { recursive: true });
    writeFileSync(join(site, path), data);
  };
  put("_headers", HEADERS);
  put("index.html", "<html>home</html>");
  put("robots.txt", "User-agent: *\n");
  put(".well-known/security.txt", "Contact: x\n");
  put("v1/root.json", '{"schema":1}');
  put("v1/root.json.sig", "00");
  for (let i = 0; i < n; i++) {
    const t = `t${String(i).padStart(2, "0")}`;
    put(`v1/shards/${t}/1.${"a".repeat(15)}${i % 10}.jsonl.gz`, Buffer.from([0x1f, 0x8b, i, 1, 2, 3]));
    put(`v1/shards/${t}/1.${"b".repeat(15)}${i % 10}.jsonl.gz`, Buffer.from([0x1f, 0x8b, i, 9, 9]));
    put(`v1/tech/${t}.json`, JSON.stringify({ schema: 1, technology: t, shards: [{ path: `shards/${t}/1.${"a".repeat(15)}${i % 10}.jsonl.gz` }] }));
    put(`v1/tech/${t}.json.sig`, `${i}`.repeat(8));
    put(`v1/coverage/${String(i).padStart(64, "0")}.json`, JSON.stringify({ purl: `pkg:npm/${t}`, technology: t }));
    const pkg = i === 0 ? "npm/@scope/t00" : `npm/${t}`;
    put(`${pkg}/index.html`, `<html>${t}</html>`);
    put(`${pkg}/index.md`, `# ${t}`);
  }
  for (const [path, data] of Object.entries(extra)) put(path, data);
  return site;
}

function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, path) : [path];
  });
}

const TYPES: Record<string, string> = { json: "application/json", sig: "application/pgp-signature", gz: "application/gzip", html: "text/html", md: "text/markdown", txt: "text/plain", bin: "application/octet-stream" };

/** The asset layer, for the cases packing touches (Cloudflare's asset-worker, html_handling auto-trailing-slash): the
 * path decoded per segment, `dir/` as its index.html, `dir` and `dir/index.html` redirected to `dir/`, a path under a
 * non-canonical encoding redirected, ETag the asset hash, a 304 on an equal If-None-Match, HEAD without a body, and
 * the `_headers` rules for the request's path. `fetches` counts what it was asked. */
function layer(site: string) {
  const rules = existsSync(join(site, "_headers")) ? readFileSync(join(site, "_headers"), "utf8") : "";
  const rulesOf = headerRules(rules);
  const exists = (p: string) => !p.endsWith("/") && existsSync(join(site, p)) && statSync(join(site, p)).isFile();
  const fetches: string[] = [];
  const fetch = async (input: Request | URL | string): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    fetches.push(url.pathname);
    const path = url.pathname.split("/").map((s) => decodeURIComponent(s)).join("/").replace(/\/+/g, "/");
    const custom = (h: Headers) => {
      for (const [set, unset] of JSON.parse(rulesOf(url.pathname)) as [[string, string][], string[]][]) {
        for (const k of unset) h.delete(k);
        for (const [k, v] of set) h.set(k, v);
      }
      return h;
    };
    const redirect = async (to: string): Promise<Response> => {
      const location = `${to.split("/").map(encodeURIComponent).join("/")}${url.search}`;
      if (request.redirect === "follow") return fetch(new Request(new URL(location, url)));
      return new Response(null, { status: 307, headers: custom(new Headers({ Location: location })) });
    };
    let file: string | undefined;
    if (path.endsWith("/")) file = exists(`${path.slice(1)}index.html`) ? `${path.slice(1)}index.html` : undefined;
    else if (path.endsWith("/index.html") && exists(path.slice(1))) return redirect(path.slice(0, -10));
    else if (exists(path.slice(1))) file = path.slice(1);
    else if (exists(`${path.slice(1)}/index.html`)) return redirect(`${path}/`);
    if (!file) return new Response(null, { status: 404, headers: custom(new Headers()) });
    if (path.split("/").map(encodeURIComponent).join("/") !== url.pathname) return redirect(path);
    const bytes = readFileSync(join(site, file));
    const etag = `"${assetHash(file, bytes)}"`;
    const ext = file.split(".").at(-1)!;
    const h = new Headers({ ETag: etag, "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate" });
    custom(h);
    const inm = request.headers.get("If-None-Match");
    if (inm === etag || inm === `W/${etag}`) return new Response(null, { status: 304, headers: h });
    return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers: h });
  };
  return { ASSETS: { fetch } as unknown as Fetcher, fetches };
}

async function seen(res: Response) {
  return { status: res.status, headers: [...res.headers].sort(), body: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

/** Every way a client asks for the tree's files, as `GET` requests from outside (redirects not followed). */
function asks(files: string[]): Request[] {
  const out: Request[] = [];
  const req = (path: string, init: RequestInit = {}) => out.push(new Request(`https://unstale.example${path}`, { redirect: "manual", ...init }));
  for (const f of files) {
    if (f.startsWith("_pack/")) continue;
    const path = f.endsWith("/index.html") ? `/${f.slice(0, -"index.html".length)}` : `/${f}`;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    req(encoded);
    req(encoded, { method: "HEAD" });
    req(encoded, { headers: { "If-None-Match": `"${assetHash(f, readFileSync(join(SOURCE, f)))}"` } });
    req(encoded, { headers: { "If-None-Match": `W/"${assetHash(f, readFileSync(join(SOURCE, f)))}"` } });
    req(encoded, { headers: { "If-None-Match": '"0123"' } });
    if (path !== encoded) req(path);
    if (f.endsWith("/index.html")) req(`/${f}`), req(encoded.slice(0, -1));
  }
  req("/v1/tech/missing.json");
  req("/npm/missing/");
  return out;
}

let SOURCE = "";

test("the tree stays under the limit; indexes stay files first, then signatures, current shards, the rest", async () => {
  SOURCE = tree(30);
  const site = tree(30);
  const fixed = walk(site).filter((p) => !packable(p)).length;
  // Room for every bucket and a probe per extension (json, sig, gz, html, md), plus 40 files.
  const max = fixed + BUCKETS + 5 + 40;
  const r = await pack(site, max);
  const left = walk(site);
  expect(left.length).toBeLessThanOrEqual(max);
  expect(r).toMatchObject({ before: walk(SOURCE).length, after: left.length, kept: 40, packed: 2 + 30 * 7 - 40 });
  // The root and its signature, the indexes (30), then the first 8 signatures; coverage and pages always packed; root
  // files never.
  expect(left.filter((p) => /^v1\/tech\/[^/]+\.json$/.test(p))).toHaveLength(30);
  expect(left.filter((p) => p.endsWith(".json.sig") && p.startsWith("v1/tech/"))).toEqual(Array.from({ length: 8 }, (_, i) => `v1/tech/t${String(i).padStart(2, "0")}.json.sig`));
  expect(left.filter((p) => p.startsWith("v1/shards/") || p.startsWith("v1/coverage/") || p.startsWith("npm/"))).toEqual([]);
  for (const p of ["_headers", "index.html", "robots.txt", ".well-known/security.txt", "v1/root.json", "v1/root.json.sig"]) expect(left).toContain(p);
  expect(r.packed_by_tier).toEqual({ worker: 90, 2: 22, 3: 30, 4: 30 });

  // Every request answered as the unpacked tree answers it.
  const before = layer(SOURCE);
  const after = layer(site);
  for (const request of asks(walk(SOURCE))) {
    const want = await seen(await before.ASSETS.fetch(request.clone() as Request));
    // A request for a packed file finds no static file and reaches the Worker, which answers through `asset`.
    const got = await seen(await asset(after, request.clone() as Request));
    expect({ url: request.url, method: request.method, inm: request.headers.get("If-None-Match"), ...got }).toEqual({
      url: request.url,
      method: request.method,
      inm: request.headers.get("If-None-Match"),
      ...want,
    });
  }
});

test("at today's size nothing a client fetches directly is packed: only what the Worker serves anyway", async () => {
  const site = tree(30);
  const r = await pack(site, 20_000);
  expect(r.packed_by_tier).toEqual({ worker: 90 });
  expect(walk(site).filter((p) => p.startsWith("v1/") && !p.startsWith("v1/coverage/")).length).toBe(2 + 30 * 4);
});

test("the Worker's own reads follow redirects; pages and their Markdown twin are read out of their bucket", async () => {
  SOURCE = tree(3);
  const site = tree(3);
  await pack(site, 20_000);
  const env = { ...layer(site) } as unknown as Env;
  // An agent asking for Markdown on a scoped package's page (its path un-encoded, as URL leaves `@`).
  const md = await page(new Request("https://unstale.example/npm/@scope/t00/", { headers: { Accept: "text/markdown" } }), env, new URL("https://unstale.example/npm/@scope/t00/"));
  expect([md.status, md.headers.get("Content-Type"), await md.text()]).toEqual([200, "text/markdown; charset=utf-8", "# t00"]);
  const html = await page(new Request("https://unstale.example/npm/t01/"), env, new URL("https://unstale.example/npm/t01/"));
  expect([html.status, await html.text(), html.headers.get("Vary")]).toEqual([200, "<html>t01</html>", "Accept"]);
});

test("a packed catalog file is answered over http and on www as the static file was; pages still redirect", async () => {
  const site = tree(2);
  await pack(site, BUCKETS + 9);
  expect(existsSync(join(site, "v1/tech/t01.json"))).toBe(false);
  const env = layer(site) as unknown as Env;
  for (const origin of ["http://api.unstale.example", "https://www.unstale.example"]) {
    const file = await handle(new Request(`${origin}/v1/tech/t01.json`), env);
    expect([file.status, ((await file.json()) as { technology: string }).technology]).toEqual([200, "t01"]);
    expect((await handle(new Request(`${origin}/npm/t01/`), env)).status).toBe(301);
  }
});

test("a lookup of a technology the catalog lacks reads its bucket's header once, then nothing", async () => {
  const site = tree(3);
  await pack(site, 20_000);
  const env = layer(site);
  const ask = () => asset(env, new Request("https://unstale.example/v1/coverage/missing.json", { redirect: "manual" }));
  expect((await ask()).status).toBe(404);
  const first = env.fetches.length;
  expect((await ask()).status).toBe(404);
  // The second miss asks the asset layer only for the file itself (its 404), not for the bucket again.
  expect(env.fetches.slice(first)).toEqual(["/v1/coverage/missing.json"]);
});

test("a bucket is read up to its header on a miss, and up to the file on a hit", async () => {
  const header = JSON.stringify({ files: { "v1/a.json": [0, 2, "e1"], "v1/b.json": [2, 3, "e2"] } });
  let pulled = 0;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        const parts = [`${header}\n`, "{}", "[1]", "rest of the bucket"];
        if (pulled >= parts.length) return c.close();
        c.enqueue(new TextEncoder().encode(parts[pulled++]!));
      },
    }, { highWaterMark: 0 });
  pulled = 0;
  expect((await readPacked(stream(), "v1/none.json")).file).toBeUndefined();
  expect(pulled).toBe(1);
  pulled = 0;
  const hit = await readPacked(stream(), "v1/b.json");
  expect([new TextDecoder().decode(hit.file!.bytes), hit.file!.etag, pulled]).toEqual(["[1]", "e2", 3]);
});

test("a technology's index and signature share a bucket; root and reserved files are never packed", () => {
  expect(groupOf("v1/tech/next.json")).toBe(groupOf("v1/tech/next.json.sig"));
  expect(bucketOf("/v1/tech/next.json")).toBe(bucketOf("v1/tech/next.json.sig"));
  expect(groupOf("npm/@scope/x/index.html")).toBe(groupOf("npm/@scope/x/index.md"));
  expect(groupOf("v1/shards/next/1.0123456789abcdef.jsonl.gz")).toBe("v1/shards/next/1.0123456789abcdef.jsonl.gz");
  for (const p of ["robots.txt", "_headers", ".well-known/security.txt", "_pack/001.bin", "npm/x/other.html"]) expect(packable(p)).toBe(false);
  for (const p of ["v1/tech/next.json", "npm/x/index.html", "npm/x/index.md"]) expect(packable(p)).toBe(true);
});

test("a file whose _headers rules differ from its probe's stays a file; redirect rules or a packed tree are refused", async () => {
  const site = tree(2, { _headers: `${HEADERS}\n/v1/tech/t00.json\n  X-Special: 1\n` });
  // Room for the files that cannot be packed (4 root files and t00.json), the buckets, 5 probes, and v1/root.json and
  // its signature.
  await pack(site, BUCKETS + 12);
  expect(existsSync(join(site, "v1/tech/t00.json"))).toBe(true);
  expect(existsSync(join(site, "v1/tech/t01.json"))).toBe(false);
  await expect(pack(site)).rejects.toThrow(/already packed/);
  await expect(pack(tree(1, { _redirects: "/a /b 301\n" }))).rejects.toThrow(/_redirects/);
  // Without room for the buckets, the pack fails instead of deploying over the limit.
  await expect(pack(tree(1), 100)).rejects.toThrow(/no room/);
});

test("a bucket the asset layer fails to serve is not taken for an empty one", async () => {
  const site = tree(3);
  await pack(site, 20_000);
  const env = layer(site);
  let fail = true;
  const real = env.ASSETS.fetch.bind(env.ASSETS);
  const flaky = {
    fetch: (input: Request) => {
      if (fail && new URL(input.url).pathname.startsWith("/_pack/") && !new URL(input.url).pathname.startsWith("/_pack/type/")) return Promise.resolve(new Response("busy", { status: 503 }));
      return real(input);
    },
  } as unknown as Fetcher;
  const ask = () => asset({ ASSETS: flaky }, new Request("https://unstale.example/v1/coverage/" + "0".repeat(64) + ".json", { redirect: "manual" }));
  await expect(ask()).rejects.toThrow(/HTTP 503/);
  fail = false;
  expect((await ask()).status).toBe(200);
});

test("a pack that fails part way leaves the tree unpacked, so it can be packed again", async () => {
  const big = `v1/coverage/${"f".repeat(64)}.json`;
  const site = tree(3, { [big]: "x".repeat(26 * 1024 * 1024) });
  await expect(pack(site, 20_000)).rejects.toThrow(/file limit/);
  expect(existsSync(join(site, "_pack"))).toBe(false);
  expect(existsSync(join(site, "v1/tech/t00.json"))).toBe(true);
  rmSync(join(site, big));
  await pack(site, 20_000);
  expect(existsSync(join(site, "_pack"))).toBe(true);
});
