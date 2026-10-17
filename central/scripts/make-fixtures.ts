// One-off: builds the schema contract fixture from real extracted records (the Slice 0 replay catalog,
// read only) mapped to the published shape, validated by the generated Zod before it is written.
// Output: schema/fixtures/ts-shard.v1.jsonl, read by the Rust contract tests.
//
//   npx tsx scripts/make-fixtures.ts [~/ati-slice0/replay]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ShardLine } from "../src/schema/catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPLAY = process.argv[2] ?? join(homedir(), "ati-slice0", "replay");
const EVENTS = ["krayin-laravel12", "workout-next16", "invoicerr-prisma7", "invoicerr-nest12"];
const PER_TECH_AND_KIND = 8;

interface ReplayRecord {
  rid: string;
  key: string;
  change_type: string;
  surface: string;
  breaking: boolean;
  summary: string;
  introduces?: string[];
  uses?: string[];
  replaces?: string[];
  prerequisites?: Array<{ name: string; min?: string }>;
  evidence?: string;
  tech: string;
  release: string;
  date: string;
  url: string;
}

const COMPONENT: Record<string, string> = {
  laravel: "pkg:composer/laravel/framework",
  next: "pkg:npm/next",
  prisma: "pkg:npm/prisma",
  nestjs: "pkg:npm/%40nestjs/core",
};

function published(r: ReplayRecord): ShardLine {
  const slug = r.key.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  const guide = r.rid.startsWith("guide__");
  return ShardLine.parse({
    status: "active",
    id: `${r.tech}:${slug}`,
    technology: r.tech,
    revision: 1,
    label_version: 1,
    change_type: r.change_type,
    breaking: r.breaking,
    surface: r.surface,
    subject: r.key,
    subject_kind: /[._:/()`]|[a-z][A-Z]/.test(r.key) ? "literal" : "concept",
    summary: r.summary,
    benefit: ["none"],
    releases: [{ component: COMPONENT[r.tech], version: r.release, date: r.date, line: r.release.split(".")[0] }],
    // The replay's names are display names ("Node.js"); the fixture keeps them, under the record's ecosystem.
    prerequisites: (r.prerequisites ?? []).map((p) => ({
      ecosystem: COMPONENT[r.tech]!.split(":")[1]!.split("/")[0]!,
      name: p.name,
      ...(p.min ? { min: String(p.min) } : {}),
    })),
    introduces: r.introduces ?? [],
    terms: (r.uses ?? []).map((t, i) => [t, i % 4]),
    replaces: r.replaces ?? [],
    evidence: [
      {
        kind: guide ? "upgrade_guide" : "release_notes",
        url: r.url,
        quote: r.evidence ?? "",
        snapshot: "sha256:" + "ab".repeat(32),
      },
    ],
  });
}

const all = new Map<string, ReplayRecord>();
for (const ev of EVENTS) {
  for (const cond of ["guides", "notes"]) {
    const q = JSON.parse(readFileSync(join(REPLAY, ev, cond, "queue.json"), "utf8")) as { records: ReplayRecord[] };
    for (const r of q.records) all.set(r.rid, r);
  }
}
const picked = new Map<string, number>();
const lines: ShardLine[] = [];
for (const r of [...all.values()].sort((a, b) => a.rid.localeCompare(b.rid))) {
  const k = `${r.tech}/${r.rid.startsWith("guide__")}`;
  if ((picked.get(k) ?? 0) >= PER_TECH_AND_KIND) continue;
  picked.set(k, (picked.get(k) ?? 0) + 1);
  lines.push(published(r));
}
// One record carries classifier output, so the Rust side reads it as the TypeScript publisher writes it.
lines[0] = ShardLine.parse({
  ...lines[0],
  classifier: {
    classifier: "jev",
    model: "jev-1.13.0",
    change_type: 0.93,
    surface: 0.58,
    breaking: 0.62,
    benefit: [
      { benefit: "security", p: 0.02 },
      { benefit: "correctness", p: 0.77 },
      { benefit: "performance", p: 0.05 },
      { benefit: "cost", p: 0.01 },
      { benefit: "maintainability", p: 0.36 },
    ],
    borderline: ["surface", "breaking", "benefit:maintainability"],
  },
});
// One record carries a security advisory (central advisories.ts), with its advisory evidence.
const second = lines[1] as unknown as { evidence: unknown[] };
lines[1] = ShardLine.parse({
  ...lines[1],
  evidence: [
    ...second.evidence,
    { kind: "advisory", url: "https://github.com/advisories/GHSA-9g9p-9gw9-jx7f", quote: "GHSA-9G9P-9GW9-JX7F (CVE-2025-59471): Next.js self-hosted applications vulnerable to DoS via Image Optimizer", snapshot: "sha256:" + "cd".repeat(32) },
  ],
  advisories: [
    {
      id: "GHSA-9G9P-9GW9-JX7F",
      aliases: ["CVE-2025-59471"],
      severity: "medium",
      summary: "Next.js self-hosted applications vulnerable to DoS via Image Optimizer",
      url: "https://github.com/advisories/GHSA-9g9p-9gw9-jx7f",
      affected: [
        { component: "pkg:npm/next", range: ">= 10.0.0, < 15.5.10", patched: "15.5.10" },
        { component: "pkg:npm/next", range: ">= 15.6.0-canary.0, < 16.1.5", patched: "16.1.5" },
      ],
    },
  ],
});
const first = lines[0] as { id: string };
lines.push(ShardLine.parse({ status: "merged", id: "next:old-duplicate", merged_into: first.id }));
lines.push(ShardLine.parse({ status: "retracted", id: "prisma:wrong-record" }));

mkdirSync(join(ROOT, "schema", "fixtures"), { recursive: true });
writeFileSync(join(ROOT, "schema", "fixtures", "ts-shard.v1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(`${lines.length} lines`);
