// Type-stub deprecations (type-stubs.ts; known bugs 2.7): `@deprecated` tags read from a stub's published
// declarations, diffed per release line against the line's previous release, into deprecation records of the typed
// technology released in the stub package. No model call; registry and tarball reads are injected here.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TechStore } from "../src/pipeline/store.ts";
import { declarationFiles, deprecatedDeclarations, stubOf, typeStubDeprecations } from "../src/pipeline/type-stubs.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-type-stubs-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

/** A gzipped ustar archive of `files` under `react/`, as DefinitelyTyped packs them. */
function tgz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    const h = Buffer.alloc(512);
    h.write(`react/${name}`, 0, "utf8");
    h.write(body.length.toString(8).padStart(11, "0"), 124, "utf8");
    h.write("0", 156, "utf8");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const OLD = `export = React;
declare namespace React {
    interface MutableRefObject<T> { current: T }
    /** A form event. */
    interface FormEvent<T = Element> extends SyntheticEvent<T> {}
}`;
const NEW = `export = React;
declare namespace React {
    interface MutableRefObject<T> { current: T }
    /**
     * @deprecated FormEvent doesn't actually exist.
     * You probably meant to use {@link ChangeEvent}, {@link InputEvent}, {@link SubmitEvent}, or just {@link SyntheticEvent} instead
     * depending on the event type.
     * @see https://example.org
     */
    interface FormEvent<T = Element> extends SyntheticEvent<T> {}
    /** @deprecated Use \`RefObject\` instead. */
    type LegacyRef<T> = string | Ref<T>;
    /** @deprecated Pass options instead. */
    function render(a: string): void;
    function render(a: string, options: object): void;
    /** @deprecated Gone. */
    function legacyOnly(a: string): void;
}`;

describe("type-stub deprecations", () => {
  test("stub names, tar entries and deprecated declarations", () => {
    expect([stubOf("pkg:npm/react"), stubOf("pkg:npm/%40babel/core"), stubOf("pkg:npm/%40types/node"), stubOf("pkg:pypi/requests")]).toEqual(["@types/react", "@types/babel__core", undefined, undefined]);
    const files = declarationFiles(tgz({ "index.d.ts": NEW, "ts5.0/index.d.ts": NEW, "package.json": "{}" }));
    expect([...files.keys()]).toEqual(["index.d.ts", "ts5.0/index.d.ts"]);
    const d = deprecatedDeclarations(files);
    // `render` has an overload that is not deprecated: the name is not.
    expect([...d.keys()]).toEqual(["FormEvent", "LegacyRef", "legacyOnly"]);
    expect(d.get("FormEvent")).toEqual({
      file: "index.d.ts",
      message: "FormEvent doesn't actually exist. You probably meant to use ChangeEvent, InputEvent, SubmitEvent, or just SyntheticEvent instead depending on the event type.",
    });
    expect(d.get("LegacyRef")!.message).toBe("Use `RefObject` instead.");
  });

  test("a declaration a release in the window deprecates, against the line's previous release, is one record of the typed technology released in the stub", async () => {
    const packument = {
      versions: Object.fromEntries(["18.3.20", "18.3.21", "19.2.2", "19.2.10", "19.3.0", "20.0.0"].map((v) => [v, { dist: { tarball: `https://t/${v}.tgz` } }])),
      time: { "18.3.20": "2025-01-01T00:00:00Z", "18.3.21": "2026-01-02T00:00:00Z", "19.2.2": "2025-09-01T00:00:00Z", "19.2.10": "2026-08-01T00:00:00Z", "19.3.0": "2026-10-01T00:00:00Z", "20.0.0": "2026-10-10T00:00:00Z" },
    };
    const body: Record<string, string> = { "18.3.20": OLD, "18.3.21": NEW, "19.2.2": OLD, "19.2.10": NEW, "19.3.0": NEW, "20.0.0": NEW };
    const got: string[] = [];
    const get = async (url: string) => {
      got.push(url);
      const v = /\/([\d.]+)\.tgz$/.exec(url)?.[1];
      const bytes = v ? tgz({ "index.d.ts": body[v]! }) : undefined;
      return { ok: true, status: 200, json: async () => packument, arrayBuffer: async () => bytes!.buffer.slice(bytes!.byteOffset, bytes!.byteOffset + bytes!.byteLength) as ArrayBuffer };
    };
    const s: TechStore = { technology: "react", records: {}, ingested: {} };
    const added = await typeStubDeprecations({ id: "react", components: ["pkg:npm/react", "pkg:npm/%40types/react"] }, s, { get });
    expect(added).toEqual(["react:formevent", "react:legacyonly", "react:legacyref"]);
    const r = s.records["react:formevent"]!;
    // Lines 18 and 19 each deprecate it in the window; line 20 begins in the window (no baseline): nothing new there.
    expect(r.releases).toEqual([
      { component: "pkg:npm/%40types/react", version: "18.3.21", date: "2026-01-02", line: "18" },
      { component: "pkg:npm/%40types/react", version: "19.2.10", date: "2026-08-01", line: "19" },
    ]);
    expect(r).toMatchObject({ change_type: "deprecation", breaking: false, subject: "FormEvent", replaces: ["FormEvent"], terms: ["FormEvent"] });
    expect(r.evidence).toEqual([{ kind: "other", url: "https://unpkg.com/@types/react@18.3.21/index.d.ts", quote: expect.stringMatching(/^@deprecated FormEvent doesn't actually exist\./), snapshot: expect.stringMatching(/^sha256:/) }]);
    expect(r.classifier).toBeUndefined();
    // A rerun reads the caches and adds nothing.
    const n = got.length;
    expect(await typeStubDeprecations({ id: "react", components: ["pkg:npm/react"] }, s, { get })).toEqual([]);
    expect(got.length).toBe(n);
  });

  test("a partial tarball failure is retried without losing releases or prototype-named declarations", async () => {
    const versions = ["19.0.0", "19.1.0", "19.2.0"];
    const packument = { versions: Object.fromEntries(versions.map((v) => [v, { dist: { tarball: `https://retry/${v}.tgz` } }])), time: { "19.0.0": "2025-01-01", "19.1.0": "2026-01-01", "19.2.0": "2026-02-01" } };
    let failed = true;
    const get = async (url: string) => {
      const v = /\/([\d.]+)\.tgz$/.exec(url)?.[1];
      if (v === "19.2.0" && failed) throw new Error("temporary tarball failure");
      const body = v === "19.0.0" ? "export function toString(): string;" : "/** @deprecated Use format instead. */\nexport function toString(): string;";
      const bytes = tgz({ "index.d.ts": body });
      return { ok: true, status: 200, json: async () => packument, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    };
    const s: TechStore = { technology: "retry", records: {}, ingested: {} };
    const t = { id: "retry", components: ["pkg:npm/react"] };
    expect(await typeStubDeprecations(t, s, { get })).toEqual([]);
    expect(s.ingested).toEqual({});
    failed = false;
    expect(await typeStubDeprecations(t, s, { get })).toEqual(["retry:tostring"]);
    expect(s.records["retry:tostring"]?.releases[0]?.version).toBe("19.1.0");
  });

  test("no stub, a stub its publisher deprecated, or an unreadable registry adds nothing", async () => {
    const s: TechStore = { technology: "uuid", records: {}, ingested: {} };
    const missing = async () => ({ ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await typeStubDeprecations({ id: "uuid", components: ["pkg:npm/uuid"] }, s, { get: missing })).toEqual([]);
    const stubbed = async () => ({ ok: true, status: 200, json: async () => ({ versions: { "11.0.0": { dist: { tarball: "x" }, deprecated: "This is a stub types definition." } }, time: { "11.0.0": "2026-01-01" } }), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await typeStubDeprecations({ id: "uuid2", components: ["pkg:npm/uuid2"] }, s, { get: stubbed })).toEqual([]);
    const down = async () => ({ ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await typeStubDeprecations({ id: "uuid3", components: ["pkg:npm/uuid3"] }, s, { get: down })).toEqual([]);
    expect(s.records).toEqual({});
  });
});
