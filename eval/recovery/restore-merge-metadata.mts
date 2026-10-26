// Upgrade an existing measured deduplication fixture to the metadata-preserving merge rule without new model calls.
// Usage: node eval/recovery/restore-merge-metadata.mts <original-store> <deduplicated-store>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeDuplicateMetadata } from '../../central/src/pipeline/match.ts';
import { publishTechnology } from '../../central/src/pipeline/publish.ts';
import type { TechStore } from '../../central/src/pipeline/store.ts';
const [base, out] = process.argv.slice(2);
if (!base || !out || base === out) throw new Error('usage: <original-store> <deduplicated-store> (different directories)');
let technologies = 0, restored = 0;
for (const name of readdirSync(join(out, 'central/records')).filter((f) => f.endsWith('.json'))) {
  const file = join(out, 'central/records', name);
  const s = JSON.parse(readFileSync(file, 'utf8')) as TechStore;
  const original = JSON.parse(readFileSync(join(base, 'central/records', name), 'utf8')) as TechStore;
  const before = JSON.stringify(s);
  for (const r of Object.values(original.records).filter((r) => r.status === 'active' && s.records[r.id]?.status === 'merged')) {
    const stub = s.records[r.id]!;
    if (!stub.history.some((h) => h.action === 'merged' && (h.detail?.startsWith('cut from the same release-note item into ') || h.detail?.startsWith('the same change in another part of the same release notes (p=')))) continue;
    let into = stub;
    const seen = new Set<string>();
    while (into.status === 'merged') {
      if (seen.has(into.id)) throw new Error(`merge cycle ${into.id}`);
      seen.add(into.id); into = s.records[into.merged_into!]!;
    }
    const prior = JSON.stringify(into);
    mergeDuplicateMetadata(into, r);
    if (prior !== JSON.stringify(into)) restored++;
  }
  if (before === JSON.stringify(s)) continue;
  const idx = JSON.parse(readFileSync(join(out, 'catalog/v1/tech', s.technology + '.json'), 'utf8'));
  if (idx.sample_n) throw new Error(`preserve rarity sample ${s.technology}`);
  writeFileSync(file, JSON.stringify(s) + '\n');
  publishTechnology(s, idx.checked, join(out, 'catalog')); technologies++;
}
console.log({ technologies, restored });
