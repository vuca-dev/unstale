// Deprecations a type-stub package states in its declarations (known bugs 2.7, QA 2026-10-19 mui attempt 33).
//
// DefinitelyTyped (`@types/react`) publishes no release notes and no changelog: its deprecations live only as
// `@deprecated` JSDoc tags in the published `.d.ts` files, where editors strike them through and `no-deprecated` lint
// rules fail on them (`FormEvent` and `FormEventHandler` in @types/react 19.3.0). Type stubs are not technologies of
// their own (admission.ts parks them with the package they type), so this runs for the typed technology: for each of
// its npm packages with a stub on the registry, every stable stub release in the catalog window is read from its
// tarball, and a declaration whose JSDoc gains `@deprecated` on a release line becomes a deprecation record of the
// technology, released in the stub package (the edge places a stub's version apart from its runtime package's,
// funnel.rs). Deterministic: registry and tarball reads only, no model call, each tarball read once (its deprecations
// are cached by version).
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { npmName, npmPurl } from "./ecosystems.ts";
import { centralDir } from "./paths.ts";
import { mintId, type StoredRecord, type TechStore } from "./store.ts";
import { SINCE, type Technology } from "./technologies.ts";
import { compareVersions, readJson, releaseLine, sha256, writeAtomic } from "./util.ts";
import { techLocal } from "../state/client.ts";

const FRESH_MS = 12 * 3600 * 1000;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

/** The npm type-stub package of a package URL (`pkg:npm/react` → `@types/react`, `pkg:npm/%40babel/core` →
 * `@types/babel__core`); undefined for a stub itself or another ecosystem. */
export function stubOf(component: string): string | undefined {
  if (!component.startsWith("pkg:npm/")) return undefined;
  const name = npmName(component);
  if (name.startsWith("@types/")) return undefined;
  return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
}

/** The `.d.ts` files of an npm tarball (ustar, gzip), by path inside the package (`index.d.ts`, `ts5.0/index.d.ts`). */
export function declarationFiles(tgz: Uint8Array): Map<string, string> {
  const tar = gunzipSync(tgz);
  const out = new Map<string, string>();
  const text = (from: number, len: number) => tar.subarray(from, from + len).toString("utf8").replace(/\0[\s\S]*$/, "");
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const name = text(at, 100);
    if (!name) break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(tar[at + 156] ?? 48);
    const prefix = text(at + 345, 155);
    const body = at + 512;
    let path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;
    if (type === "L") longName = text(body, size);
    else if ((type === "0" || type === "\0") && path.endsWith(".d.ts")) {
      path = path.replace(/^[^/]+\//, ""); // npm packs everything under one top directory (`package/`, `react/`)
      out.set(path, tar.subarray(body, body + size).toString("utf8"));
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return out;
}

const MODIFIERS = new Set(
  "export declare default function const let var interface type class namespace module enum abstract readonly static public protected private get set async new".split(" "),
);

/**
 * The declarations a set of `.d.ts` files marks `@deprecated`: name → the tag's text (the first file's, in path order;
 * `{@link X}` written as X). The name is the identifier the JSDoc block documents: a top-level declaration or a member.
 */
export function deprecatedDeclarations(files: ReadonlyMap<string, string>): Map<string, { message: string; file: string }> {
  const out = new Map<string, { message: string; file: string }>();
  const partial = new Set<string>();
  for (const [file, src] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const marked = new Map<string, number>();
    for (const m of src.matchAll(/\/\*\*([\s\S]*?)\*\/\s*/g)) {
      const doc = m[1]!.split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n");
      const tag = /@deprecated\b([\s\S]*?)(?=\n\s*@\w|$)/.exec(doc);
      if (!tag) continue;
      const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 300);
      let name: string | undefined;
      for (const w of after.split(/[^A-Za-z0-9_$]+/)) {
        if (!w) continue;
        if (MODIFIERS.has(w)) continue;
        name = /^[A-Za-z_$][\w$]*$/.test(w) ? w : undefined;
        break;
      }
      if (!name) continue;
      marked.set(name, (marked.get(name) ?? 0) + 1);
      if (out.has(name)) continue;
      const message = tag[1]!.replace(/\{@link(?:code|plain)?\s+([^}|\s]+)[^}]*\}/g, "$1").replace(/\s+/g, " ").trim();
      out.set(name, { message, file });
    }
    // One deprecated overload of a function or method with others that are not: the name itself stays (`render(a)`
    // deprecated beside `render(a, options)`), so its uses are no deprecated use.
    for (const [name, n] of marked) {
      const decl = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:function\\s+)?${name.replace(/\$/g, "\\$")}\\s*[<(]`, "gm");
      if ((src.match(decl) ?? []).length > n) partial.add(name);
    }
  }
  for (const name of partial) out.delete(name);
  return out;
}

interface Packument {
  versions: Record<string, { dist?: { tarball?: string }; deprecated?: string }>;
  time?: Record<string, string>;
}

type Get = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;
const httpGet: Get = (url) => fetch(url, { headers: { "User-Agent": "unstale-central" }, signal: AbortSignal.timeout(60_000) });

const dir = (t: Pick<Technology, "id">) => join(centralDir(), "type-stubs", techLocal(t.id));

/** A stub's stable versions and their dates and tarballs (cached FRESH_MS); undefined when the registry has no such
 * package or the stub is itself deprecated (a stub kept only to say the package ships its own types). */
async function stubVersions(t: Pick<Technology, "id">, stub: string, opts: { refresh?: boolean; offline?: boolean; get?: Get }): Promise<Array<{ version: string; date: string; tarball: string }> | undefined> {
  const file = join(dir(t), `${stub.replace("/", "__")}.json`);
  const cached = readJson<{ checked: string; versions: Array<{ version: string; date: string; tarball: string }> | null }>(file);
  if (cached && (opts.offline || (!opts.refresh && Date.now() - Date.parse(cached.checked) < FRESH_MS))) return cached.versions ?? undefined;
  if (opts.offline) return undefined;
  const res = await (opts.get ?? httpGet)(`https://registry.npmjs.org/${stub.replace("/", "%2f")}`);
  if (!res.ok && res.status !== 404) throw new Error(`registry ${stub}: ${res.status}`);
  const doc = res.ok ? ((await res.json()) as Packument) : undefined;
  const latest = doc && Object.keys(doc.versions).sort(compareVersions).at(-1);
  const versions =
    !doc || (latest && doc.versions[latest]?.deprecated)
      ? null
      : Object.entries(doc.versions)
          .filter(([v, m]) => /^\d+\.\d+\.\d+$/.test(v) && m.dist?.tarball && doc.time?.[v])
          .map(([v, m]) => ({ version: v, date: doc.time![v]!.slice(0, 10), tarball: m.dist!.tarball! }))
          .sort((a, b) => compareVersions(a.version, b.version));
  writeAtomic(file, JSON.stringify({ checked: stamp(), versions }) + "\n");
  return versions ?? undefined;
}

/** One stub version's deprecated declarations (cached for good: a published tarball does not change). */
async function versionDeprecations(t: Pick<Technology, "id">, stub: string, v: { version: string; tarball: string }, opts: { offline?: boolean; get?: Get }) {
  const file = join(dir(t), "versions", `${stub.replace("/", "__")}@${v.version}.json`);
  const cached = readJson<{ snapshot: string; deprecated: Record<string, { message: string; file: string }> }>(file);
  if (cached) return cached;
  if (opts.offline) return undefined;
  const res = await (opts.get ?? httpGet)(v.tarball);
  if (!res.ok) throw new Error(`${v.tarball}: ${res.status}`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const out = { snapshot: `sha256:${sha256(tgz)}`, deprecated: Object.fromEntries(deprecatedDeclarations(declarationFiles(tgz))) };
  writeAtomic(file, JSON.stringify(out) + "\n");
  return out;
}

const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");

/**
 * Adds the technology's type-stub deprecations to the store: per stub and release line, each declaration that a stable
 * release in the window marks `@deprecated` and the line's previous release did not (the last one before the window
 * is the baseline; a line that begins in the window has none, so nothing is new in its first release). One record per
 * declaration and message, with a release on each line where it became deprecated; a rerun adds nothing (`ingested`).
 * Fails open: a registry or tarball that cannot be read leaves the store as it is. Returns the records added.
 */
export async function typeStubDeprecations(t: Pick<Technology, "id" | "components">, s: TechStore, opts: { refresh?: boolean; offline?: boolean; get?: Get } = {}): Promise<string[]> {
  const added: string[] = [];
  for (const stub of [...new Set(t.components.map(stubOf).filter((x): x is string => !!x))].sort()) {
    let versions: Awaited<ReturnType<typeof stubVersions>>;
    try {
      versions = await stubVersions(t, stub, opts);
    } catch (e) {
      console.error(`type stubs: ${t.id}: ${stub} unavailable (${e instanceof Error ? e.message : e})`);
      continue;
    }
    if (!versions?.length) continue;
    // Per line: the in-window releases, each against the line's release before it.
    const found = new Map<string, { name: string; message: string; file: string; snapshot: string; releases: Map<string, { version: string; date: string }> }>();
    for (const line of [...new Set(versions.map((v) => releaseLine(v.version)))]) {
      const ofLine = versions.filter((v) => releaseLine(v.version) === line);
      const first = ofLine.findIndex((v) => v.date >= SINCE);
      if (first < 1) continue; // no release in the window, or the line begins in it (no baseline)
      let prev: Awaited<ReturnType<typeof versionDeprecations>>;
      try {
        prev = await versionDeprecations(t, stub, ofLine[first - 1]!, opts);
        for (const v of ofLine.slice(first)) {
          const cur = await versionDeprecations(t, stub, v, opts);
          if (!cur || !prev) break;
          for (const [name, d] of Object.entries(cur.deprecated)) {
            if (prev.deprecated[name]) continue;
            const key = `${name}\u0000${d.message}`;
            const f = found.get(key) ?? { name, message: d.message, file: d.file, snapshot: cur.snapshot, releases: new Map() };
            if (!f.releases.has(line)) f.releases.set(line, { version: v.version, date: v.date });
            found.set(key, f);
          }
          prev = cur;
        }
      } catch (e) {
        console.error(`type stubs: ${t.id}: ${stub} line ${line} unreadable (${e instanceof Error ? e.message : e})`);
      }
    }
    const component = npmPurl(stub);
    for (const f of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const rels = [...f.releases.entries()].sort(([a], [b]) => compareVersions(a, b));
      const key = `${t.id}@${stub}+types.${f.name}#${sha256(f.message).slice(0, 8)}`;
      if (s.ingested[key]) continue;
      const [, firstRel] = rels[0]!;
      const id = mintId(t.id, f.name, undefined, (x) => x in s.records);
      const quote = `@deprecated ${f.message}`.trim();
      const r: StoredRecord = {
        id,
        technology: t.id,
        status: "active",
        revision: 1,
        label_version: 1,
        change_type: "deprecation",
        breaking: false,
        surface: "code_api",
        subject: f.name,
        subject_kind: "literal",
        summary: words(`${f.name} is deprecated in the ${stub} declarations${f.message ? `: ${f.message}` : "."}`, 40),
        benefit: ["none"],
        releases: rels.map(([line, rel]) => ({ component, version: rel.version, date: rel.date, line })),
        prerequisites: [],
        conditions: [],
        requires: [],
        introduces: [],
        terms: [f.name],
        replaces: [f.name],
        evidence: [{ kind: "other", url: `https://unpkg.com/${stub}@${firstRel.version}/${f.file}`, quote, snapshot: f.snapshot }],
        related: [],
        sources: [key],
        history: [{ action: "created", detail: `${key}: @deprecated in ${stub} ${rels.map(([, x]) => x.version).join(", ")}`, revision: 1, label_version: 1 }],
      };
      s.records[id] = r;
      s.ingested[key] = id;
      added.push(id);
    }
  }
  return added;
}
