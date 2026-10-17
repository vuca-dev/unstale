// Per-requester limits held in memory only: a sliding hour of new registrations per address, and one vote per
// requester and technology (salted hashes). Nothing here is ever written or logged. Shared by the coverage service and
// the gateway Worker, so it uses nothing beyond node:crypto.
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Who a request counts as: an IPv4 address, or an IPv6 address's /64 (one allocation usually holds a whole /64, so
 * counting its addresses one by one would make the limits per request, not per requester).
 */
export function requesterKey(address: string): string {
  const a = address.trim().toLowerCase().replace(/%.*$/, "");
  if (!a.includes(":")) return a;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = a.split("::", 2);
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => Number.parseInt(g || "0", 16).toString(16)).join(":")}::/64`;
}

/** `kind`: which budget refused (new technologies, job runs, or release-note tokens). */
export type Refusal = { limit: "address" | "budget"; retryAfter: number; kind?: "new" | "runs" | "tokens" };

/** A sliding one-hour window per address, bounded in size; oldest addresses are dropped first. */
export class AddressLimiter {
  private readonly seen = new Map<string, number[]>();
  readonly perHour: number;
  private readonly maxAddresses: number;
  constructor(perHour: number, maxAddresses = 10_000) {
    this.perHour = perHour;
    this.maxAddresses = maxAddresses;
  }
  take(requester: string, now = Date.now()): Refusal | undefined {
    const address = requesterKey(requester);
    const recent = (this.seen.get(address) ?? []).filter((t) => t > now - 3600_000);
    if (recent.length >= this.perHour) {
      this.seen.set(address, recent);
      return { limit: "address", retryAfter: Math.ceil((recent[0]! + 3600_000 - now) / 1000) };
    }
    recent.push(now);
    this.seen.delete(address);
    this.seen.set(address, recent);
    if (this.seen.size > this.maxAddresses) this.seen.delete(this.seen.keys().next().value!);
    return undefined;
  }
}

/**
 * Demand: distinct requesters per technology, deduplicated in memory only. A requester is a salted hash of the client
 * address with a salt drawn once per process and never written, so not even the dedupe table holds an address; only
 * the counts are persisted (in the jobs). After a restart the same requester can vote once more for a technology it
 * voted for before; that is bounded by the address limit and can only reorder the queue, never raise spend. A salted
 * hash persisted across restarts (even rotated daily) would keep a per-requester pseudonym and allow correlation,
 * which the registry's privacy rule excludes ("avoid retention/correlation", no stable client ids).
 */
export class Voters {
  private readonly salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  private readonly seen = new Map<string, true>();
  private readonly max: number;
  constructor(max = 200_000) {
    this.max = max;
  }
  private key(technology: string, address: string): string {
    return sha256(`${this.salt}\n${technology}\n${requesterKey(address)}`);
  }
  /** Whether this address already asked for this technology (in this process). */
  has(technology: string, address: string): boolean {
    return this.seen.has(this.key(technology, address));
  }
  add(technology: string, address: string): void {
    this.seen.set(this.key(technology, address), true);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }
}
