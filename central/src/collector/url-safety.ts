// Refuse targets that resolve to private, loopback, link-local or otherwise reserved addresses.
// Matters on cloud runners (the metadata endpoint is link-local) and once sources come from outside requests.
// This check fails fast before a request; the HTTP client checks again on the address its socket connects to
// (http.ts, guardedLookup), so a name cannot rebind between the two.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class BlockedUrlError extends Error {}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function v6Blocked(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === "::" || a === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped?.[1]) return v4Blocked(mapped[1]);
  const first = Number.parseInt(a.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 || // ff00::/8 multicast
    a.startsWith("2001:db8:") || // documentation
    a.startsWith("64:ff9b:") // NAT64, can reach v4 private space
  );
}

export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v === 6) return v6Blocked(ip);
  return true;
}

/**
 * `allowPrivate: true` disables the address check; `allowHosts` permits only the listed
 * hostnames (e.g. a local replay server) while every other target is still checked.
 */
export async function assertFetchable(url: URL, allowPrivate: boolean, allowHosts: readonly string[] = []): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`scheme ${url.protocol} not allowed`);
  }
  if (url.username || url.password) throw new BlockedUrlError("credentials in URL not allowed");
  if (allowPrivate || allowHosts.includes(url.hostname)) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new BlockedUrlError(`${url.hostname} resolves to blocked address ${address}`);
  }
}
