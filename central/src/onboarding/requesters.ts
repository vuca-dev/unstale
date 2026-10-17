// Per-requester limits held in memory only: a sliding hour of new registrations per address, and one vote per
// requester and technology (salted hashes). Nothing here is ever written or logged (vault: Source Registry and
// Coverage, "Subscriptions and the shared registry"). Shared by the coverage service and the gateway Worker, so it uses
// nothing beyond node:crypto.
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

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
  take(address: string, now = Date.now()): Refusal | undefined {
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
    return sha256(`${this.salt}\n${technology}\n${address}`);
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
