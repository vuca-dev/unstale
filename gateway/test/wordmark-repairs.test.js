import { expect, test } from "vitest";
import { planRepairs, REPAIR_CAPACITY } from "../site/wordmark-repairs.js";

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const smooth = (p) => { p = Math.min(1, Math.max(0, p)); return p * p * (3 - 2 * p); };
const letters = Array.from({ length: 48 * 16 }, (_, i) => [100 + Math.floor(i / 16), 28 + i % 16]);

test("repair traffic scales with exact stale mass within each region", () => {
  const repairs = planRepairs(letters, hash, smooth, 256, 80);
  expect(repairs.length).toBeGreaterThan(0);
  const regions = new Map();
  for (const repair of repairs) {
    const mass = repair.claims.reduce((sum, claim) => sum + claim.amount, 0);
    expect(mass).toBeGreaterThan(0);
    expect(mass).toBeLessThanOrEqual(REPAIR_CAPACITY + 1e-9);
    expect(repair.landing - repair.duration).toBeGreaterThan(repair.birth + 0.65);
    expect(letters).toContainEqual(repair.destination);
    for (const { index } of repair.claims) {
      const [x, y] = letters[index];
      expect(Math.floor(x / 6)).toBe(Math.floor(repair.destination[0] / 6));
      expect(Math.floor(y / 6)).toBe(Math.floor(repair.destination[1] / 6));
    }
    const key = `${repair.birth}:${Math.floor(repair.destination[0] / 6)}:${Math.floor(repair.destination[1] / 6)}`;
    const region = regions.get(key) ?? { mass: 0, count: 0 };
    region.mass += mass;
    region.count++;
    regions.set(key, region);
  }
  for (const { mass, count } of regions.values()) {
    expect(count).toBe(Math.ceil((mass - 1e-9) / REPAIR_CAPACITY));
  }
});

test("each stale amount is reserved once and cannot be targeted again before arrival", () => {
  const repairs = planRepairs(letters, hash, smooth, 256, 80);
  const reservations = new Map();
  for (const repair of repairs) {
    for (const { index, amount } of repair.claims) {
      const claims = reservations.get(index) ?? new Map();
      for (const [birth, reservation] of claims) {
        if (birth !== repair.birth) expect(reservation.landing).toBeLessThanOrEqual(repair.birth);
      }
      const reservation = claims.get(repair.birth) ?? { amount: 0, landing: 0 };
      reservation.amount += amount;
      reservation.landing = Math.max(reservation.landing, repair.landing);
      expect(reservation.amount).toBeLessThanOrEqual(1 + 1e-9);
      claims.set(repair.birth, reservation);
      reservations.set(index, claims);
    }
  }
  expect(planRepairs([], hash, smooth, 256, 80)).toEqual([]);
});
