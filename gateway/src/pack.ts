// Packed static files: what keeps the deployed file count bounded whatever the number of technologies. Workers static
// assets allow 20,000 files a version on the free plan, and the deploy tree holds about 14.5 a technology (12,205 at
// 840 technologies, most of them shards kept for their 7-day grace). So the deploy step (scripts/pack.ts) keeps the
// files clients ask for most as they are, up to that limit, and moves the rest into at most BUCKETS bucket files under
// `_pack/`. A request for a packed file finds no static file and reaches the Worker, which reads it out of its bucket
// and answers as the asset layer answers the file itself (assets.ts): the same bytes, the same ETag (Workers' own asset
// hash, computed at pack time), the same headers (copied from an empty probe file of the same kind), 304, HEAD and the
// same redirects. URLs do not change, so clients need no release.
//
// A bucket file is one header line of JSON, `{"files": {"<path>": [offset, length, "<etag>"]}}` (offsets after the
// header line), then the files' bytes. The bucket of a path is a hash of its group (`groupOf`), so a deploy uploads
// only the buckets whose files changed. Shared by the packer (Node) and the Worker.

/** The directory of bucket and probe files in the deployed tree. */
export const PACK_DIR = "_pack";
/** Fixed, so the Worker finds a path's bucket without reading anything; at most this many bucket files. */
export const BUCKETS = 4096;

/** What files that change together have in common, so they share a bucket: a technology's index and its signature, a
 * page and its Markdown twin. Anything else (a shard, a status) is its own group: a technology's shards together
 * would make one bucket of a technology with hundreds of shard generations, read whole for each of them. */
export function groupOf(path: string): string {
  const p = path.replace(/^\/+/, "");
  const tech = /^v1\/tech\/([^/]+?)\.json(?:\.sig)?$/.exec(p);
  if (tech) return `tech:${tech[1]}`;
  const slash = p.lastIndexOf("/");
  if (slash > 0 && p.slice(slash + 1).startsWith("index.")) return p.slice(0, slash + 1);
  return p;
}

/** Whether a file may be packed: inside a directory that is neither hidden nor reserved (`_pack`, `.well-known`), and
 * HTML only as a directory's `index.html` (the one redirect the Worker reproduces). Root files (`_headers`, the home
 * page, robots.txt, ownership files) always stay as they are. */
export function packable(path: string): boolean {
  const parts = path.split("/");
  if (parts.length < 2 || parts.some((s) => !s || s.startsWith(".") || s.startsWith("_"))) return false;
  return extensionOf(path) !== "html" || parts.at(-1) === "index.html";
}

/** FNV-1a (32-bit) of the group, modulo BUCKETS. */
export function bucketOf(path: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(groupOf(path))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % BUCKETS;
}

export const bucketFile = (bucket: number): string => `${PACK_DIR}/${bucket.toString(16).padStart(3, "0")}.bin`;

/** The extension as Workers assets read it (`path.extname` without the dot): `gz` for `x.jsonl.gz`, `` for none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/** An empty file of the extension, which the asset layer serves with the headers a file of that extension gets. HTML
 * sits as a directory's index (asked for as the directory), so its redirects can be probed too. */
export function probeFile(ext: string): string {
  if (ext === "html") return `${PACK_DIR}/type/html/index.html`;
  return ext ? `${PACK_DIR}/type/${ext}/index.${ext}` : `${PACK_DIR}/type/none/index`;
}
export const probeUrl = (ext: string): string => (ext === "html" ? `/${PACK_DIR}/type/html/` : `/${probeFile(ext)}`);

/** The redirects the asset layer makes to a packed file: another encoding of its path (`encoding`), and for a page,
 * `dir`, `dir/index`, `dir/index.html` and `dir.html` to `dir/`. */
export type RedirectKind = "encoding" | "directory" | "index" | "index.html" | "html";

/** A probe URL the asset layer answers with a redirect of that kind: its headers are a redirect's. */
export function redirectProbeUrl(kind: RedirectKind, ext: string): string {
  const html = `/${PACK_DIR}/type/html`;
  switch (kind) {
    case "encoding":
      // `%74` is `t`: the same file under a non-canonical encoding.
      return probeUrl(ext).replace(`/${PACK_DIR}/type/`, `/${PACK_DIR}/%74ype/`);
    case "directory":
      return html;
    case "index":
      return `${html}/index`;
    case "index.html":
      return `${html}/index.html`;
    case "html":
      return `${html}.html`;
  }
}

/** A bucket's header: each packed path's offset and length in the data after the header line, and its ETag. */
export interface BucketHeader {
  files: Record<string, [offset: number, length: number, etag: string]>;
}

const NEWLINE = 0x0a;

/** Reads a bucket body up to its header line, and on a hit up to the end of that file: never the rest of the bucket. */
export async function readPacked(
  body: ReadableStream<Uint8Array>,
  path: string,
  known?: BucketHeader,
): Promise<{ header: BucketHeader; file?: { bytes: Uint8Array<ArrayBuffer>; etag: string } }> {
  const reader = body.getReader();
  // The chunks read so far, copied once into what is returned (a buffer regrown per chunk would copy the bucket
  // over and over).
  const chunks: Uint8Array[] = [];
  let read = 0;
  let done = false;
  const more = async (): Promise<boolean> => {
    if (done) return false;
    const r = await reader.read();
    if (r.done) {
      done = true;
      return false;
    }
    chunks.push(r.value);
    read += r.value.length;
    return true;
  };
  const copy = (from: number, to: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(to - from);
    let at = 0;
    for (const c of chunks) {
      const lo = Math.max(from - at, 0);
      const hi = Math.min(to - at, c.length);
      if (lo < hi) out.set(c.subarray(lo, hi), at + lo - from);
      at += c.length;
      if (at >= to) break;
    }
    return out;
  };
  try {
    let end = -1;
    while (end < 0) {
      const scanned = read;
      if (!(await more())) throw new Error("bucket file has no header line");
      const at = chunks.at(-1)!.indexOf(NEWLINE);
      if (at >= 0) end = scanned + at;
    }
    const header = known ?? (JSON.parse(new TextDecoder().decode(copy(0, end))) as BucketHeader);
    const entry = Object.hasOwn(header.files, path) ? header.files[path] : undefined;
    if (!entry) return { header };
    const [offset, length, etag] = entry;
    const start = end + 1 + offset;
    while (read < start + length) if (!(await more())) throw new Error(`bucket file ends inside ${path}`);
    return { header, file: { bytes: copy(start, start + length), etag } };
  } finally {
    if (!done) await reader.cancel().catch(() => {});
  }
}
