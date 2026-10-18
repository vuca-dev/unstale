// Steps 10 and 11 of the advisories stage (backports.ts, section-packages.ts), on React's release notes as stored on
// 17 October 2026 (19.3.0 trimmed to one item per section). DavidHDev/react-bits (react 19.1.1, a client-only Vite
// app) was told "bumping react 19.1.1 → 19.3.1 picks up 7 security": the same Server Actions hardening (#35632) once
// per release line (19.0.4, 19.1.5, 19.2.4), all of it under "## React Server Components", which changes
// react-server-dom-webpack and its siblings, not `react`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { findBackportTwins, mergeBackports } from "../src/pipeline/backports.ts";
import { changeRefs, itemOf } from "../src/pipeline/items.ts";
import { attributeSections, headingNames, headingPackages, headingWords, namesInCode, OTHER_SECTION } from "../src/pipeline/section-packages.ts";
import type { StoredRecord, TechStore } from "../src/pipeline/store.ts";
import type { Technology } from "../src/pipeline/technologies.ts";

const body = (v: string): string | undefined => {
  try {
    return readFileSync(join(import.meta.dirname, "fixtures", "react", `${v}.md`), "utf8");
  } catch {
    return undefined;
  }
};
const REACT: Technology = { id: "react-87506014", name: "react", repo: "react/react", components: ["pkg:npm/react"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
const url = (v: string) => `https://github.com/react/react/releases/tag/v${v}`;
const VERSIONS = ["19.0.4", "19.0.6", "19.1.5", "19.1.7", "19.2.4", "19.3.0"];
const releases = VERSIONS.map((version) => ({ version, date: "2026-01-26", url: url(version) }));

function record(id: string, version: string, quote: string, over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    id: `${REACT.id}:${id}`,
    technology: REACT.id,
    status: "active",
    revision: 1,
    label_version: 1,
    change_type: "security",
    breaking: false,
    surface: "runtime_internal",
    subject: "Server Actions",
    subject_kind: "literal",
    summary: "Added more DoS mitigations to Server Actions.",
    benefit: ["security"],
    releases: [{ component: "pkg:npm/react", version, date: "2026-01-26", line: "19" }],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    evidence: [{ kind: "release_notes", url: url(version), quote, snapshot: `sha256:${version}` }],
    related: [],
    sources: [`${REACT.id}@${version}#0.0`],
    history: [{ action: "created", revision: 1, label_version: 1 }],
    ...over,
  };
}

function store(recs: StoredRecord[]): TechStore {
  // Lines at depth 2, as central derives them for react.
  const idx = VERSIONS.map((version) => ({ version, date: "2026-01-26", line: version.split(".").slice(0, 2).join(".") }));
  return {
    technology: REACT.id,
    records: Object.fromEntries(recs.map((r) => [r.id, r])),
    ingested: {},
    releaseIndex: { depth: 2, releases: idx },
  } as unknown as TechStore;
}

const DOS = "Add more DoS mitigations to Server Actions";
const HARDEN = "harden Server Components";

describe("items", () => {
  test("the whole list item, its headings and the change it cites; CRLF bodies read like LF", () => {
    const it = itemOf(body("19.0.6")!, "Type hardening")!;
    expect(it.headings).toEqual(["React Server Components"]);
    expect(it.text).toContain("#36425");
    expect([...changeRefs(it.text)]).toEqual(["pr:36425"]);
    expect(itemOf(body("19.1.5")!, DOS)!.headings).toEqual(["React Server Components"]);
    expect(itemOf(body("19.3.0")!, "Add `nonce` to rendered import maps")!.headings).toEqual(["All Changes", "React Server"]);
    expect(itemOf(body("19.1.5")!, "not in the notes")).toBeUndefined();
  });

  test("pull requests and commits are refs; issues are not", () => {
    const refs = changeRefs("Fix x ([#12](https://github.com/o/r/pull/12)), see https://github.com/o/r/issues/99 and [`abc1234`](https://github.com/o/r/commit/abc1234def)");
    expect([...refs].sort()).toEqual(["commit:abc1234", "pr:12"]);
  });
});

describe("step 10: backport twins", () => {
  test("one upstream change on three release lines is one record; a different item of the same PR stays its own", () => {
    const s = store([
      record("server-actions", "19.2.4", DOS),
      record("server-actions~2", "19.1.5", DOS),
      record("server-actions~3", "19.0.4", DOS),
      record("server-components~2", "19.2.4", HARDEN, { subject: "Server Components" }),
      record("server-components~3", "19.1.5", HARDEN, { subject: "Server Components" }),
    ]);
    expect(findBackportTwins(s, releases, body)).toEqual([
      { records: [`${REACT.id}:server-actions`, `${REACT.id}:server-actions~2`, `${REACT.id}:server-actions~3`], refs: ["pr:35632"] },
      { records: [`${REACT.id}:server-components~2`, `${REACT.id}:server-components~3`], refs: ["pr:35632"] },
    ]);
    const merged = mergeBackports(s, releases, body);
    expect(merged.map((m) => [m.from, m.into])).toEqual([
      [`${REACT.id}:server-actions~2`, `${REACT.id}:server-actions`],
      [`${REACT.id}:server-actions~3`, `${REACT.id}:server-actions`],
      [`${REACT.id}:server-components~3`, `${REACT.id}:server-components~2`],
    ]);
    const into = s.records[`${REACT.id}:server-actions`]!;
    expect(into.releases.map((r) => r.version).sort()).toEqual(["19.0.4", "19.1.5", "19.2.4"]);
    expect(s.records[`${REACT.id}:server-actions~3`]!.status).toBe("merged");
    expect(mergeBackports(s, releases, body)).toEqual([]);
  });

  test("no merge on one line, across breaking, or without a ref on the item", () => {
    const noRef = (v: string) => (v === "19.2.4" ? `## React Server Components\n\n- ${DOS}\n` : body(v));
    expect(findBackportTwins(store([record("a", "19.2.4", DOS), record("b", "19.1.5", DOS)]), releases, noRef)).toEqual([]);
    expect(findBackportTwins(store([record("a", "19.2.4", DOS), record("b", "19.1.5", DOS, { breaking: true })]), releases, body)).toEqual([]);
    const sameLine = store([
      record("a", "19.1.5", DOS),
      record("b", "19.1.7", DOS, { evidence: [{ kind: "release_notes", url: url("19.1.5"), quote: DOS, snapshot: "sha256:x" }] }),
    ]);
    expect(findBackportTwins(sameLine, releases, body)).toEqual([]);
  });
});

const RSC = (name: string) => ({ purl: `pkg:npm/${name}`, name, description: `React Server Components bindings for DOM using ${name.split("-").at(-1)}. This is intended to be integrated into meta-frameworks.` });
const PACKAGES = [
  { purl: "pkg:npm/react", name: "react", description: "React is a JavaScript library for building user interfaces." },
  { purl: "pkg:npm/react-dom", name: "react-dom", description: "React package for working with the DOM." },
  RSC("react-server-dom-webpack"),
  RSC("react-server-dom-parcel"),
];
const RSD = ["pkg:npm/react-server-dom-parcel", "pkg:npm/react-server-dom-webpack"];

describe("step 11: sections naming other packages", () => {
  test("a heading names a package by its name, or by the start of its description up to the end of a name", () => {
    expect(headingPackages("React Server Components", PACKAGES)).toEqual(RSD);
    expect(headingPackages("React DOM", PACKAGES)).toEqual(["pkg:npm/react-dom"]);
    expect(headingPackages("React", PACKAGES)).toEqual(["pkg:npm/react"]);
    expect(headingPackages("React Server", PACKAGES), "the name goes on: Components").toEqual([]);
    expect(headingPackages("Bug Fixes", PACKAGES)).toEqual([]);
    expect(headingNames("Hijri Calendar", { name: "@daypicker/hijri", description: "Hijri calendar support for react-day-picker" })).toBe(true);
    expect(headingWords("## [@scope/pkg@1.2.3](https://x)")).toBe("@scope/pkg");
    expect(headingWords("🚀 Features:")).toBe("Features");
    expect(namesInCode("import `DayPicker` from `react-day-picker/hijri`", "react-day-picker")).toBe(true);
    expect(namesInCode("React Server Components fixes", "react")).toBe(false);
  });

  const none = async () => new Set<string>();
  test("records under React Server Components name its packages; React's own sections stay; restored when it stops", async () => {
    const s = store([
      record("server-actions", "19.2.4", DOS),
      record("import-maps-nonce", "19.3.0", "Add `nonce` to rendered import maps", { subject: "nonce" }),
      record("fast-refresh", "19.3.0", "Fast Refresh Fixes", { change_type: "fix", subject: "Fast Refresh" }),
      record("toggle", "19.3.0", "Copy `source` onto the synthetic `toggle` event", { change_type: "fix", subject: "toggle" }),
    ]);
    const r = await attributeSections(REACT, s, releases, body, PACKAGES, none);
    expect(r.moved).toEqual([
      { record: `${REACT.id}:server-actions`, packages: RSD, heading: "React Server Components" },
      { record: `${REACT.id}:toggle`, packages: ["pkg:npm/react-dom"], heading: "React DOM" },
    ]);
    const sa = s.records[`${REACT.id}:server-actions`]!;
    expect(sa.releases.map((x) => [x.component, x.version])).toEqual([[RSD[0], "19.2.4"], [RSD[1], "19.2.4"]]);
    expect(sa.history.at(-1)!.action).toBe(OTHER_SECTION);
    expect(s.records[`${REACT.id}:fast-refresh`]!.releases[0]!.component, "### React names react").toBe("pkg:npm/react");
    expect(s.records[`${REACT.id}:import-maps-nonce`]!.releases[0]!.component, "React Server names no package").toBe("pkg:npm/react");
    expect((await attributeSections(REACT, s, releases, body, PACKAGES, none)).moved).toEqual([]);
    // The registry no longer lists the packages: the components come back.
    const back = await attributeSections(REACT, s, releases, body, PACKAGES.slice(0, 1), none);
    expect(back.restored).toEqual([`${REACT.id}:server-actions`, `${REACT.id}:toggle`]);
    expect(sa.releases.map((x) => x.component)).toEqual(["pkg:npm/react"]);
  });

  test("a package the release installs, an advisory of the technology, or an unknown leave the record", async () => {
    const s = store([record("server-actions", "19.2.4", DOS)]);
    expect((await attributeSections(REACT, s, releases, body, PACKAGES, async () => new Set([RSD[1]!]))).moved).toEqual([]);
    expect((await attributeSections(REACT, s, releases, body, PACKAGES, async () => undefined)).moved).toEqual([]);
    expect((await attributeSections(REACT, s, releases, () => undefined, PACKAGES, none)).moved).toEqual([]);
    const adv = store([record("server-actions", "19.2.4", DOS, { advisories: [{ id: "GHSA-xxxx-xxxx-xxxx", aliases: [], summary: "", url: "", affected: [] }] })]);
    expect((await attributeSections(REACT, adv, releases, body, PACKAGES, none)).moved).toEqual([]);
  });
});
