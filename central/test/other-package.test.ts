// Another package's release (advisories.ts step 9): a record whose subject is a package the release notes list as a
// registry link, not one of the technology's packages and not installed by the release, describes a change users of
// that package get. Case: lodash 4.18.0's "`lodash.*` modular packages" section (nine separate npm packages, each a
// list item linking its npm page) became nine `security` records, so the bump digest said "lodash: 10 security".
// Release body as fetched on 17 October 2026.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { attachAdvisories, listedPackages, relabelOtherPackage, type ForeignCheck } from "../src/pipeline/advisories.ts";
import type { Classification } from "../src/pipeline/classify/adapter.ts";
import { ecosystemOf } from "../src/pipeline/ecosystems.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { writeAtomic } from "../src/pipeline/util.ts";

const BODY = readFileSync(join(import.meta.dirname, "fixtures", "other-package", "lodash-4.18.0.md"), "utf8");

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-other-package-"));
  writeAtomic(join(process.env.UNSTALE_CENTRAL_DIR, "releases", LODASH.id, "4.18.0.md"), BODY);
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const LODASH: Technology = {
  id: "lodash-69289569",
  name: "lodash",
  repo: "lodash/lodash",
  components: ["pkg:npm/lodash"],
  tag: /^(\d+\.\d+\.\d+)$/,
  clean: (b) => b,
};
const URL = "https://github.com/lodash/lodash/releases/tag/4.18.0";
const releases = [{ version: "4.18.0", date: "2026-03-31", url: URL }];
const MODULAR = "we have brought the following packages up to parity w/ the latest lodash release because they have had CVEs on them in the past";

function record(id: string, quote: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: `${LODASH.id}:${id}`,
    technology: LODASH.id,
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "security",
    breaking: false,
    surface: "code_api",
    subject: id,
    subject_kind: "literal",
    summary: "The modular package was regenerated and published to parity with the latest lodash release because it previously had CVEs.",
    benefit: ["security"],
    releases: [{ component: "pkg:npm/lodash", version: "4.18.0", date: "2026-03-31", line: "4" }],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    evidence: [{ kind: "release_notes", url: URL, quote, snapshot: "sha256:b8ae" }],
    related: [],
    sources: [`${LODASH.id}@4.18.0#0.${id.length}`],
    history: [{ action: "created", revision: 1, label_version: 1 }],
    ...over,
  };
}

function store(): TechStore {
  const recs = [
    // As stored by the scout run: one record per listed package.
    record("lodash.omit", MODULAR),
    record("lodash.template", MODULAR),
    record("lodash.zipobjectdeep", MODULAR, { benefit: ["security", "correctness"] }),
    // lodash's own fixes, in the same release: kept.
    record("omit", "Fixed prototype pollution via constructor/prototype path traversal", { subject: "_.omit", summary: "Blocks constructor and prototype path traversal." }),
    record("template-imports", "Fixed code injection via `imports` keys", { subject: "_.template", facet: "imports" }),
    // A concept subject naming no package: kept.
    record("modular-packages", MODULAR, { subject: "modular packages", subject_kind: "concept" }),
    // A listed package, but the record is an obligation (breaking) or opt-in (new_api): not this step's claim; kept.
    record("lodash.trim", MODULAR, { change_type: "removal", breaking: true, benefit: ["none"] }),
    record("lodash.trimend", MODULAR, { change_type: "new_api", benefit: ["none"] }),
  ];
  return { technology: LODASH.id, ingested: {}, records: Object.fromEntries(recs.map((r) => [r.id, r])) };
}

const noJudge = async (): Promise<Classification> => {
  throw new Error("no model call expected");
};
const check = (over: Partial<ForeignCheck> = {}): ForeignCheck => ({
  packages: LODASH.components,
  lookup: async () => {
    throw new Error("no OSV lookup expected");
  },
  // lodash 4.18.0 on npm has no dependencies.
  dependencies: async () => [],
  ...over,
});
const id = (x: string) => `${LODASH.id}:${x}`;

describe("another package's release", () => {
  test("registry pages and listed packages: a line that is only a registry link lists it; a mention in a sentence does not", () => {
    const npm = ecosystemOf("pkg:npm/lodash").registryPage!;
    expect(npm("https://www.npmjs.com/package/lodash.omit")).toBe("pkg:npm/lodash.omit");
    expect(npm("https://npmjs.com/package/@scope/name/v/1.2.3")).toBe("pkg:npm/%40scope/name");
    expect(npm("https://www.npmjs.com/package/%40scope%2Fname")).toBe("pkg:npm/%40scope/name");
    expect(npm("https://github.com/lodash/lodash")).toBeUndefined();
    expect(ecosystemOf("pkg:pypi/x").registryPage!("https://pypi.org/project/Requests_Toolbelt/1.0/")).toBe("pkg:pypi/requests-toolbelt");
    const listed = listedPackages(BODY, [npm]);
    expect([...listed].sort()).toEqual(
      ["omit", "orderby", "sortedindexby", "template", "tonumber", "trim", "trimend", "unset", "zipobjectdeep"].map((x) => `pkg:npm/lodash.${x}`),
    );
    expect([...listedPackages("- Fixed compatibility with [qs](https://www.npmjs.com/package/qs)\n* <https://www.npmjs.com/package/a>\n1. https://www.npmjs.com/package/b.\n", [npm])].sort()).toEqual(["pkg:npm/a", "pkg:npm/b"]);
  });

  test("relabelled as another package's release; the technology's own changes kept; no model or OSV call; idempotent", async () => {
    const s = store();
    const report = await attachAdvisories(LODASH, s, [], releases, noJudge, check());
    expect(report.otherPackage).toEqual([
      { record: id("lodash.omit"), package: "pkg:npm/lodash.omit" },
      { record: id("lodash.template"), package: "pkg:npm/lodash.template" },
      { record: id("lodash.zipobjectdeep"), package: "pkg:npm/lodash.zipobjectdeep" },
    ]);
    expect(report.recordsChanged).toBe(3);
    const zip = s.records[id("lodash.zipobjectdeep")]!;
    expect(zip).toMatchObject({ change_type: "other", benefit: ["none"], revision: 2, label_version: 2 });
    expect(zip.history.at(-1)).toMatchObject({ action: "other-package" });
    expect(zip.history.at(-1)!.detail).toMatch(/pkg:npm\/lodash\.zipobjectdeep.*\(was security; security, correctness\)$/);
    for (const x of ["omit", "template-imports", "modular-packages"]) expect(s.records[id(x)]).toMatchObject({ change_type: "security", benefit: ["security"], revision: 1 });
    expect(s.records[id("lodash.trim")]).toMatchObject({ change_type: "removal", revision: 1 });
    expect(s.records[id("lodash.trimend")]).toMatchObject({ change_type: "new_api", revision: 1 });

    const before = JSON.stringify(s);
    const again = await attachAdvisories(LODASH, s, [], releases, noJudge, check());
    expect(again.otherPackage).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("kept when the package is the technology's, the release installs it, or nothing can be known; restored when it stops qualifying", async () => {
    const run = (s: TechStore, over: Partial<ForeignCheck>, body = (v: string) => (v === "4.18.0" ? BODY : undefined)) =>
      relabelOtherPackage(s, releases, body, { ...check(), ...over });
    // One of the technology's packages (a sibling the hook found).
    expect((await run(store(), { packages: [...LODASH.components, "pkg:npm/lodash.omit"] })).relabelled.map((x) => x.record)).not.toContain(id("lodash.omit"));
    // A runtime dependency of the release: a bump installs it, so users get its fix.
    expect((await run(store(), { dependencies: async () => ["pkg:npm/lodash.template"] })).relabelled.map((x) => x.record)).toEqual([id("lodash.omit"), id("lodash.zipobjectdeep")]);
    // No dependencies known (no hook), the release not published at the version, the body not stored: as it is.
    expect((await run(store(), { dependencies: async () => undefined })).relabelled).toEqual([]);
    expect((await run(store(), { dependencies: async () => null })).relabelled).toEqual([]);
    expect((await run(store(), {}, () => undefined)).relabelled).toEqual([]);
    // An ecosystem without the registryPage hook: unknown, as it is.
    expect((await run(store(), { packages: ["pkg:golang/github.com/lodash/lodash"] })).relabelled).toEqual([]);

    // Relabelled, then the package becomes one of the technology's: labels back.
    const s = store();
    await run(s, {});
    const back = await run(s, { packages: [...LODASH.components, "pkg:npm/lodash.omit"] });
    expect(back.restored).toEqual([id("lodash.omit")]);
    expect(s.records[id("lodash.omit")]).toMatchObject({ change_type: "security", benefit: ["security"], revision: 3 });
    expect(s.records[id("lodash.omit")]!.history.at(-1)).toMatchObject({ action: "other-package-restored" });
    // A registry that cannot be read leaves the relabelled records as they are.
    const before = JSON.stringify(s.records[id("lodash.template")]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = await run(s, { dependencies: async () => Promise.reject(new Error("registry down")) });
    err.mockRestore();
    expect(down.restored).toEqual([]);
    expect(JSON.stringify(s.records[id("lodash.template")])).toBe(before);
  });
});
