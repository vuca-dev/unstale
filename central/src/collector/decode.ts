// Decode a response body to text, following the WHATWG order instead of assuming UTF-8:
// byte-order mark, then the Content-Type charset, then an in-document declaration
// (<meta charset>, http-equiv, or the XML declaration), then UTF-8.

const BOMS: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

function label(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    return new TextDecoder(name.trim().toLowerCase()).encoding;
  } catch {
    return undefined; // unknown label
  }
}

export function sniffEncoding(body: Uint8Array, contentType: string | null): string {
  for (const [bom, enc] of BOMS) {
    if (bom.every((b, i) => body[i] === b)) return enc;
  }
  const fromHeader = label(/charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1]);
  if (fromHeader) return fromHeader;
  const head = new TextDecoder("latin1").decode(body.subarray(0, 2048));
  const declared =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1];
  // A document declaring UTF-16 in ASCII-compatible bytes is lying (WHATWG maps it to UTF-8).
  const fromDoc = label(declared);
  if (fromDoc && !fromDoc.startsWith("utf-16")) return fromDoc;
  return "utf-8";
}

export function decode(body: Uint8Array, contentType: string | null): string {
  const enc = sniffEncoding(body, contentType);
  return new TextDecoder(enc, { ignoreBOM: false }).decode(body);
}
