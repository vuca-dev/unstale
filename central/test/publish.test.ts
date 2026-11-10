// Publishing: deterministic shards per technology and release line, content-hash names, the index and root, stubs in
// their own line's shard, and the generated Zod rejecting an invalid record before anything is written.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { CLIENT_MANIFEST, manifestVersion, publishTechnology, rootText, writeRoot } from "../src/pipeline/publish.ts";
import { mergeInto, retract, type StoredRecord, type TechStore } from "../src/pipeline/store.ts";
import { Root, ShardLine, TechIndex } from "../src/schema/catalog.ts";

function rec(id: string, lines: string[], over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id,
    technology: "next",
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "new_option",
    breaking: false,
    surface: "configuration",
    subject: id.split(":")[1]!,
    subject_kind: "literal",
    summary: `Adds ${id}.`,
    benefit: ["none"],
    releases: lines.map((l) => ({ component: "pkg:npm/next", version: `${l}.1.0`, date: "2026-01-01", line: l })),
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: ["next.config.js"],
    replaces: [],
    evidence: [{ kind: "release_notes", url: "u", quote: "q", snapshot: `sha256:${"ab".repeat(32)}` }],
    related: [],
    classifier: { classifier: "jev", model: "jev-1.13.0", change_type: 0.9, surface: 0.8, breaking: 0.1, benefit: [{ benefit: "cost", p: 0.2 }], borderline: [] },
    sources: [],
    history: [],
    ...over,
  };
}

function fixture(): TechStore {
  const s: TechStore = { technology: "next", records: {}, ingested: {} };
  for (const r of [rec("next:a", ["16"]), rec("next:b", ["15", "16"]), rec("next:c", ["15"]), rec("next:d", ["15"]), rec("next:e", ["16"]), rec("next:f", ["14"])]) {
    s.records[r.id] = r;
  }
  mergeInto(s, "next:c", "next:a"); // stub stays in line 15 although its target lives in 16
  retract(s, "next:f"); // the only record of line 14
  return s;
}

const CHECKED = "2026-10-15T06:00:00Z";

function files(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(d, e.name));
    }
  };
  walk(dir, "");
  return out;
}

describe("publish", () => {
  test("same store, byte-identical files", () => {
    const a = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    vi.stubEnv("UNSTALE_NOTICE", join(a, "no-notice.json"));
    onTestFinished(() => void vi.unstubAllEnvs());
    const b = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    publishTechnology(fixture(), CHECKED, a);
    publishTechnology(fixture(), CHECKED, b);
    publishTechnology(fixture(), CHECKED, b); // a rerun over existing output
    expect(files(b)).toEqual(files(a));
    expect(Object.keys(files(a)).sort()).toEqual(expect.arrayContaining(["v1/root.json", "v1/tech/next.json"]));
    expect(JSON.parse(readFileSync(join(a, "v1", "root.json"), "utf8"))).toEqual({ schema: 1, min_client: "0.1.0", latest_client: manifestVersion(CLIENT_MANIFEST) });
  });

  test("the root names the client's released version and the notice file's announcement, when there is one", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-root-"));
    const manifest = join(dir, "Cargo.toml");
    writeFileSync(manifest, '[package]\nname = "unstale"\nversion = "0.3.2"\n\n[dependencies]\nclap = { version = "4" }\n');
    const none = join(dir, "absent.json");
    expect(JSON.parse(rootText({ manifest, notice: none }))).toEqual({ schema: 1, min_client: "0.1.0", latest_client: "0.3.2" });
    // No manifest (a container holds only src/): no latest_client, the root still publishes.
    expect(JSON.parse(rootText({ manifest: none, notice: none }))).toEqual({ schema: 1, min_client: "0.1.0" });
    const notice = join(dir, "notice.json");
    writeFileSync(notice, JSON.stringify({ id: "keys-2026-11", until: "2026-11-30", text: "Run `unstale setup`." }));
    const text = rootText({ manifest, notice });
    expect(Root.parse(JSON.parse(text)).notice).toEqual({ id: "keys-2026-11", until: "2026-11-30", text: "Run `unstale setup`." });
    expect(text).toBe(rootText({ manifest, notice }));
    // A malformed notice fails the publish instead of reaching clients.
    writeFileSync(notice, JSON.stringify({ id: "x", text: "no until" }));
    expect(() => rootText({ manifest, notice })).toThrow();
    for (const until of ["30 Nov", "2026-02-30", "2026-11-30T00:00:00Z"]) {
      writeFileSync(notice, JSON.stringify({ id: "x", until, text: "t" }));
      expect(() => rootText({ manifest, notice }), until).toThrow(/YYYY-MM-DD/);
    }
    // A bad notice stops a technology's publish before any of its files are written.
    const pub = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    vi.stubEnv("UNSTALE_NOTICE", notice);
    try {
      expect(() => publishTechnology(fixture(), CHECKED, pub)).toThrow(/YYYY-MM-DD/);
      expect(readdirSync(pub)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
    // UNSTALE_NOTICE names the file the writers use by default.
    writeFileSync(notice, JSON.stringify({ id: "env", until: "2026-12-01", text: "t" }));
    vi.stubEnv("UNSTALE_NOTICE", notice);
    try {
      writeRoot(dir, { manifest });
      expect(JSON.parse(readFileSync(join(dir, "v1", "root.json"), "utf8")).notice.id).toBe("env");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the index lists each shard with a hash, size and count that verify; every line passes the Zod", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    const { index } = publishTechnology(fixture(), CHECKED, dir);
    const onDisk = TechIndex.parse(JSON.parse(readFileSync(join(dir, "v1", "tech", "next.json"), "utf8")));
    expect(onDisk).toEqual(index);
    expect(onDisk).toMatchObject({ schema: 1, technology: "next", sample_n: 0, checked: CHECKED });
    expect(onDisk.shards.map((s) => s.line)).toEqual(["14", "15", "16"]);
    for (const s of onDisk.shards) {
      const bytes = readFileSync(join(dir, s.path));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(s.sha256);
      expect(s.path).toBe(`v1/shards/next/${s.line}.${digest.slice(0, 16)}.jsonl.gz`);
      expect(bytes.length).toBe(s.bytes);
      const lines = gunzipSync(bytes).toString("utf8").trimEnd().split("\n");
      expect(lines.length).toBe(s.records);
      for (const l of lines) expect(ShardLine.safeParse(JSON.parse(l)).error).toBeUndefined();
    }
  });

  test("records live in the shard of their highest line; stubs stay in their own line's shard", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    const { index } = publishTechnology(fixture(), CHECKED, dir);
    const content = Object.fromEntries(
      index.shards.map((s) => [s.line, gunzipSync(readFileSync(join(dir, s.path))).toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)]),
    );
    const ids = (line: string) => content[line]!.map((l) => `${l.id}:${l.status}`);
    expect(ids("16")).toEqual(["next:a:active", "next:b:active", "next:e:active"]);
    expect(ids("15")).toEqual(["next:c:merged", "next:d:active"]);
    expect(ids("14")).toEqual(["next:f:retracted"]);
    expect(content["15"]![0]).toEqual({ id: "next:c", merged_into: "next:a", status: "merged" });
    const a = content["16"]![0]!;
    expect((a.releases as unknown[]).length).toBe(2); // c's release on line 15 moved to a
    expect(a.terms).toEqual([["next.config.js", 0], ["c", 0]]);
  });

  test("an invalid record is rejected by the generated Zod before anything is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pub-"));
    const s = fixture();
    (s.records["next:e"] as unknown as Record<string, unknown>).change_type = "quantum_change";
    expect(() => publishTechnology(s, CHECKED, dir)).toThrow();
    expect(existsSync(join(dir, "v1"))).toBe(false);
    const t = fixture();
    t.records["next:e"]!.summary = undefined as unknown as string;
    expect(() => publishTechnology(t, CHECKED, dir)).toThrow();
  });
});
