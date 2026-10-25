// A particle carries one fully stale dot's worth of repair. Fractional amber
// counts proportionally; a region's final particle may carry a partial load.
export const REPAIR_CAPACITY = 1;

export function planRepairs(letters, hash, smooth, width, height) {
  const reservedUntil = new Float64Array(letters.length);
  const repairs = [];
  if (!letters.length) return repairs;
  for (let event = 0; event < 9; event++) {
    const birth = 6.2 + event * 2.2 + hash(event + 701) * 0.5;
    const target = letters[Math.floor(hash(event + 101) * letters.length)];
    const regions = new Map();
    letters.forEach(([x, y], index) => {
      if (reservedUntil[index] > birth) return;
      if (hash(index + event * 911) > 0.78 + hash(event + 401) * 0.22) return;
      const radius = ((x - target[0]) / (width * (0.05 + hash(event + 201) * 0.1))) ** 2
        + ((y - target[1]) / (height * (0.11 + hash(event + 301) * 0.22))) ** 2;
      const amount = 1 - smooth((radius - 0.3) / 1.1);
      if (amount <= 0) return;
      const key = Math.floor(x / 6) + Math.floor(y / 6) * Math.ceil(width / 6);
      if (!regions.has(key)) regions.set(key, []);
      regions.get(key).push({ index, amount });
    });
    for (const members of regions.values()) {
      const total = members.reduce((sum, member) => sum + member.amount, 0);
      const count = Math.ceil(total / REPAIR_CAPACITY);
      const loads = Array.from({ length: count }, () => []);
      let mass = 0;
      // Split exact amounts, so every particle carries at most capacity and all
      // staleness is reserved once, including partial dots at region edges.
      for (const member of members) {
        let remaining = member.amount;
        while (remaining > 1e-10) {
          const slot = Math.min(count - 1, Math.floor(mass / REPAIR_CAPACITY));
          const amount = Math.min(remaining, (slot + 1) * REPAIR_CAPACITY - mass);
          if (amount <= 1e-10) { mass = (slot + 1) * REPAIR_CAPACITY; continue; }
          loads[slot].push({ index: member.index, amount });
          mass += amount;
          remaining -= amount;
        }
      }
      for (const claims of loads) {
        if (!claims.length) continue;
        const seed = repairs.length + event * 1999;
        const duration = 1.2 + hash(seed + 3101) * 0.8;
        const landing = birth + 0.7 + duration + hash(seed + 3001) * 2;
        const destination = letters[claims[Math.floor(claims.length / 2)].index];
        for (const { index } of claims) reservedUntil[index] = Math.max(reservedUntil[index], landing);
        repairs.push({ birth, landing, duration, seed, destination, claims });
      }
    }
  }
  return repairs;
}
