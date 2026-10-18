// What one drain took from the gateway's queue. The gateway answers every held request with its whole demand until a
// deployed run acknowledges it, so a drain that pulls again while it works adds only the demand that grew since its
// last pull, and acknowledges the whole of what it took once.

export interface Request {
  purl: string;
  demand: number;
}

export class Taken {
  private readonly demand = new Map<string, number>();
  /** The part of `requests` this drain has not taken yet: new packages whole, and the votes added since. */
  add(requests: Iterable<Request>): Request[] {
    const out: Request[] = [];
    for (const { purl, demand } of requests) {
      const had = this.demand.get(purl);
      const now = Math.max(0, Math.floor(demand));
      if (had !== undefined && now <= had) continue;
      out.push({ purl, demand: now - (had ?? 0) });
      this.demand.set(purl, now);
    }
    return out;
  }
  get size(): number {
    return this.demand.size;
  }
  /** What to acknowledge: each package with the demand taken from it in all. */
  requests(): Request[] {
    return [...this.demand].map(([purl, demand]) => ({ purl, demand }));
  }
}
