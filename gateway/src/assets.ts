// Static files as the Worker reads and answers them: the deployed file when there is one, else the file packed into
// its bucket (pack.ts), answered as the asset layer would answer the file itself. Everything the Worker serves or
// reads from the static tree goes through `asset`.
//
// The asset layer's rules reproduced here, for the files that can be packed (Cloudflare's workers-shared asset-worker,
// html_handling "auto-trailing-slash"): the path is decoded segment by segment; `dir/` serves `dir/index.html`, and
// `dir`, `dir/index`, `dir/index.html` and `dir.html` redirect (307) to `dir/`; a file asked for under another
// encoding of its path redirects to the canonical one (`@` to `%40`); the query is kept on a redirect. A 304 answers
// an If-None-Match equal to the ETag or its weak form; HEAD has no body. Headers (content type, cache control, the
// `_headers` rules) are the ones the asset layer gives a probe file of the same kind, so they follow its own tables.
import { bucketFile, bucketOf, extensionOf, packable, probeUrl, readPacked, redirectProbeUrl, type BucketHeader, type RedirectKind } from "./pack.ts";

type Assets = { ASSETS: Fetcher };

// Per isolate; an isolate serves one deployed version, whose static files never change.
const headers = new Map<number, BucketHeader>();
const HEADERS_KEPT = 1024;
const probes = new Map<string, [string, string][]>();
const EMPTY: BucketHeader = { files: {} };
/** The probe's own validators and framing, never copied. */
const PROBE_ONLY = new Set(["etag", "content-length", "content-range", "content-encoding", "location"]);

/** Whether a path is packed, from its bucket's header (kept, so a miss in a known bucket reads nothing). */
async function header(env: Assets, base: string, file: string): Promise<BucketHeader> {
  const bucket = bucketOf(file);
  const known = headers.get(bucket);
  if (known) return known;
  const res = await env.ASSETS.fetch(new Request(new URL(`/${bucketFile(bucket)}`, base)));
  const h = res.ok && res.body ? (await readPacked(res.body, "")).header : (await res.body?.cancel(), EMPTY);
  if (headers.size >= HEADERS_KEPT) headers.delete(headers.keys().next().value!);
  headers.set(bucket, h);
  return h;
}

async function packed(env: Assets, base: string, file: string): Promise<boolean> {
  return packable(file) && Object.hasOwn((await header(env, base, file)).files, file);
}

async function bytesOf(env: Assets, base: string, file: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string }> {
  const bucket = bucketOf(file);
  const res = await env.ASSETS.fetch(new Request(new URL(`/${bucketFile(bucket)}`, base)));
  if (!res.ok || !res.body) throw new Error(`${bucketFile(bucket)}: HTTP ${res.status}`);
  const { file: found } = await readPacked(res.body, file, headers.get(bucket));
  if (!found) throw new Error(`${file} is not in ${bucketFile(bucket)}`);
  return found;
}

/** The headers the asset layer gives a probe (a 200 of the extension, or a redirect of that kind), without the
 * probe's own validators. */
async function probe(env: Assets, base: string, url: string): Promise<Headers> {
  let kept = probes.get(url);
  if (!kept) {
    const res = await env.ASSETS.fetch(new Request(new URL(url, base), { redirect: "manual" }));
    await res.body?.cancel();
    kept = [...res.headers].filter(([name]) => !PROBE_ONLY.has(name.toLowerCase()));
    if (res.ok || res.status === 307) probes.set(url, kept);
  }
  return new Headers(kept);
}

const decodePath = (pathname: string): string =>
  pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/")
    .replace(/\/+/g, "/");
const encodePath = (pathname: string): string => pathname.split("/").map(encodeURIComponent).join("/");

/** What the asset layer would do with a decoded path, as far as packed files go: serve one, redirect, or neither. */
async function intent(env: Assets, base: string, path: string): Promise<{ file: string } | { redirect: string; kind: RedirectKind } | undefined> {
  const has = (p: string) => packed(env, base, p.slice(1));
  if (path.endsWith("/")) return (await has(`${path}index.html`)) ? { file: `${path}index.html` } : undefined;
  if (path.endsWith("/index.html")) return (await has(path)) ? { redirect: path.slice(0, -10), kind: "index.html" } : undefined;
  if (path.endsWith("/index") && !(await has(path))) return (await has(`${path}.html`)) ? { redirect: path.slice(0, -5), kind: "index" } : undefined;
  if (path.endsWith(".html")) return (await has(`${path.slice(0, -5)}/index.html`)) ? { redirect: `${path.slice(0, -5)}/`, kind: "html" } : undefined;
  if (await has(path)) return { file: path };
  return (await has(`${path}/index.html`)) ? { redirect: `${path}/`, kind: "directory" } : undefined;
}

/** The static file at a request's path, packed or not, with the asset layer's status and headers. */
export async function asset(env: Assets, request: Request): Promise<Response> {
  return (await packedAsset(env, request)) ?? env.ASSETS.fetch(request);
}

/** The asset layer's answer for a packed file (or a redirect to one); undefined when the path names none. */
export async function packedAsset(env: Assets, request: Request): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  const path = decodePath(url.pathname);
  const found = await intent(env, url.href, path);
  if (!found) return undefined;
  // A request that follows redirects (the Worker's own reads, as ASSETS.fetch would) gets the file it ends at.
  const redirect = (to: string, h: Headers) => {
    const location = `${encodePath(to)}${url.search}`;
    if (request.redirect === "follow") return asset(env, new Request(new URL(location, url), { method: request.method, headers: request.headers }));
    h.set("Location", location);
    return new Response(null, { status: 307, headers: h });
  };
  if ("redirect" in found) return redirect(found.redirect, await probe(env, url.href, redirectProbeUrl(found.kind, "html")));
  const ext = extensionOf(found.file);
  if (encodePath(path) !== url.pathname) return redirect(path, await probe(env, url.href, redirectProbeUrl("encoding", ext)));
  const [h, { bytes, etag }] = await Promise.all([probe(env, url.href, probeUrl(ext)), bytesOf(env, url.href, found.file.slice(1))]);
  const strong = `"${etag}"`;
  h.set("ETag", strong);
  if (request.headers.has("Authorization") || request.headers.has("Range")) h.delete("Cache-Control");
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch === strong || ifNoneMatch === `W/${strong}`) return new Response(null, { status: 304, headers: h });
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers: h });
}

/** For tests: forget what this isolate has read. */
export function resetAssetCaches(): void {
  headers.clear();
  probes.clear();
}
