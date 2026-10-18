// A deterministic tar for state members: POSIX ustar, with a pax header for a path over 100 bytes. Regular files only,
// sorted by path, mode 0644, owner 0, mtime 0: the same files always give the same bytes, so a member's digest says
// whether it changed, and any tar reads it (`zstd -d < member | tar -t`).
const BLOCK = 512;

export interface Entry {
  /** Relative path, `/`-separated. */
  path: string;
  data: Uint8Array;
}

function field(h: Buffer, offset: number, length: number, value: string): void {
  h.write(value, offset, length, "utf8");
}
const octal = (n: number, length: number): string => n.toString(8).padStart(length - 1, "0") + "\0";

function header(name: string, size: number, type: "0" | "x"): Buffer {
  const h = Buffer.alloc(BLOCK);
  field(h, 0, 100, name);
  field(h, 100, 8, octal(0o644, 8));
  field(h, 108, 8, octal(0, 8));
  field(h, 116, 8, octal(0, 8));
  field(h, 124, 12, octal(size, 12));
  field(h, 136, 12, octal(0, 12));
  field(h, 148, 8, "        ");
  field(h, 156, 1, type);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  field(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

const pad = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** A pax record `<len> path=<path>\n`, whose length counts its own digits. */
function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  const bytes = Buffer.byteLength(body);
  let len = bytes + 1;
  while (String(len).length + bytes !== len) len = String(len).length + bytes;
  return Buffer.from(`${len}${body}`);
}

export function pack(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (Buffer.byteLength(e.path) > 100) {
      const pax = paxPath(e.path);
      parts.push(header("PaxHeader", pax.length, "x"), pax, pad(pax.length));
    }
    parts.push(header(Buffer.from(e.path).subarray(0, 100).toString("utf8").replace(/�+$/, ""), e.data.byteLength, "0"));
    parts.push(Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength), pad(e.data.byteLength));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const text = (b: Buffer, offset: number, length: number): string => {
  const s = b.subarray(offset, offset + length);
  const end = s.indexOf(0);
  return s.subarray(0, end < 0 ? length : end).toString("utf8");
};

/** A path a member may hold: relative, no `.` or `..` segment, no backslash. */
export function safePath(p: string): boolean {
  return !!p && !p.startsWith("/") && !p.includes("\\") && p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export function unpack(buf: Uint8Array): Entry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Entry[] = [];
  let at = 0;
  let longPath: string | undefined;
  while (at + BLOCK <= b.length) {
    const h = b.subarray(at, at + BLOCK);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(text(h, 124, 12).trim() || "0", 8);
    const type = text(h, 156, 1) || "0";
    const prefix = text(h, 345, 155);
    const data = b.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "x") {
      for (const rec of data.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/s.exec(rec);
        if (m) longPath = m[1];
      }
      continue;
    }
    if (type === "g" || type === "5") continue;
    if (type !== "0") throw new Error(`tar: entry type ${JSON.stringify(type)} is not a regular file`);
    const path = longPath ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
    longPath = undefined;
    if (!safePath(path)) throw new Error(`tar: unsafe path ${JSON.stringify(path)}`);
    out.push({ path, data: new Uint8Array(data) });
  }
  return out;
}
