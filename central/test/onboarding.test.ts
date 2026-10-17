import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoverageService,
  createCoverageServer,
  docsCoverage,
} from "../src/onboarding/service.ts";
import {
  npmIdentity,
  packageIdentity,
  releasePattern,
  technologyId,
  discoverTechnology,
} from "../src/onboarding/discovery.ts";
import { HttpClient } from "../src/collector/http.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
let dir: string;
const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-onboarding-"));
  process.env.UNSTALE_STORE = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("identity vocabulary rejects private URLs, versions, traversal and arbitrary ecosystems", () => {
  expect(npmIdentity("pkg:npm/%40astrojs/mdx")).toBe("@astrojs/mdx");
  for (const value of [
    "pkg:npm/../secret",
    "pkg:npm/astro@7.0",
    "pkg:npm/astro?repo=private",
    "https://private.local/pkg",
    "pkg:pypi/astro",
  ])
    expect(() => npmIdentity(value)).toThrow();
  expect(technologyId("pkg:npm/astro")).toBe(technologyId("pkg:npm/astro"));
});
test("PyPI identities are PEP 503 names; anything else is still refused", () => {
  expect(packageIdentity("pkg:pypi/typing-extensions")).toBe("typing-extensions");
  expect(packageIdentity("pkg:npm/next")).toBe("next");
  for (const value of ["pkg:pypi/Typing_Extensions", "pkg:pypi/openai@1.0", "pkg:pypi/../x", "pkg:pypi/a?x=1", "pkg:cargo/serde"])
    expect(() => packageIdentity(value)).toThrow();
  expect(technologyId("pkg:pypi/openai")).not.toBe(technologyId("pkg:npm/openai"));
});
test("PyPI release tags: v-prefixed, bare, name-prefixed; two- or three-part stable versions", () => {
  const tag = new RegExp(releasePattern("pkg:pypi/typing-extensions"));
  for (const [t, v] of [["v1.2.3", "1.2.3"], ["4.12.2", "4.12.2"], ["2.0", "2.0"], ["typing_extensions-4.12.2", "4.12.2"], ["typing-extensions==4.1.0", "4.1.0"], ["typing-extensions_4.1.1", "4.1.1"]] as const)
    expect(tag.exec(t)?.[1]).toBe(v);
  for (const t of ["v1.2.3rc1", "other-1.2.3", "1"]) expect(tag.test(t)).toBe(false);
});
test("public registry discovery handles monorepo tag prefixes without hand-curated aliases", async () => {
  vi.spyOn(HttpClient.prototype, "get").mockResolvedValue({
    status: 200,
    headers: new Headers(),
    body: Buffer.from(
      JSON.stringify({
        name: "@example/ui",
        "dist-tags": { latest: "2.1.0" },
        versions: {
          "2.1.0": {
            repository: {
              url: "git+https://github.com/example/framework.git",
              directory: "packages/ui",
            },
            homepage: "https://example.com/docs",
          },
        },
      }),
    ),
    finalUrl: "https://registry.npmjs.org/@example%2Fui",
  });
  const t = await discoverTechnology("pkg:npm/%40example/ui");
  expect(t.repo).toBe("example/framework");
  expect(t.components).toEqual(["pkg:npm/%40example/ui"]);
  expect(new RegExp(t.tag).exec("@example/ui@2.1.0")?.[1]).toBe("2.1.0");
  expect(new RegExp(t.tag).test("unrelated@2.1.0")).toBe(false);
  expect(new RegExp(t.tag).test("v2.1.0")).toBe(false);
});
test("registration is strict, persisted, deduplicated and resumes interrupted jobs", async () => {
  const service = new CoverageService(0),
    server = createCoverageServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number },
    base = `http://127.0.0.1:${addr.port}`;
  try {
    const register = (
      body: unknown,
      headers: Record<string, string> = { "Content-Type": "application/json" },
    ) =>
      fetch(base + "/coverage", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    expect(
      (await register({ purl: "pkg:npm/astro", repo: "private" })).status,
    ).toBe(400);
    expect(
      (
        await register(
          { purl: "pkg:npm/astro" },
          { "Content-Type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await register(
          { purl: "pkg:npm/astro" },
          {
            "Content-Type": "application/json",
            Origin: "https://untrusted.example",
          },
        )
      ).status,
    ).toBe(403);
    const a = await (await register({ purl: "pkg:npm/astro" })).json();
    const b = await (await register({ purl: "pkg:npm/astro" })).json();
    expect(a.technology).toBe(b.technology);
    expect(service.jobs.size).toBe(1);
    expect(a.state).toBe("queued");
    const job = service.jobs.get("pkg:npm/astro")!;
    job.state = "analyzing";
    const { sha256 } = await import("../src/pipeline/util.ts");
    writeAtomic(
      join(dir, "central/onboarding/jobs", sha256(job.purl) + ".json"),
      JSON.stringify(job),
    );
    const resumed = new CoverageService(0);
    expect(resumed.status(job.purl)?.state).toBe("queued");
    expect(resumed.status(job.purl)?.stage).toContain("Resuming");
    expect(
      (await fetch(base + "/v1/tech/../../central/usage.jsonl")).status,
    ).toBe(404);
    writeAtomic(
      join(dir, "catalog/v1/root.json"),
      JSON.stringify({ schema: 1, min_client: "0.1.0" }),
    );
    const catalog = await fetch(base + "/v1/root.json");
    expect(catalog.status).toBe(200);
    expect(
      (
        await fetch(base + "/v1/root.json", {
          headers: { "If-None-Match": catalog.headers.get("etag")! },
        })
      ).status,
    ).toBe(304);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.stop();
  }
});
test("cold jobs publish early, interleave history with the docs module's pass and never synthesize a baseline", async () => {
  const discovery = await import("../src/onboarding/discovery.ts");
  const fetching = await import("../src/pipeline/fetch.ts");
  const synthesis = await import("../src/onboarding/synthesis.ts");
  const docs = await import("../src/docs/extract.ts");
  const t = {
    discovery_version: 1,
    purl: "pkg:npm/example",
    id: "example",
    name: "Example",
    latest: "1.4.0",
    repo: "example/example",
    tag: "^v(\\d+\\.\\d+\\.\\d+)$",
    components: ["pkg:npm/example"],
    homepage: "https://docs.example.com",
  };
  vi.spyOn(discovery, "discoverTechnology").mockResolvedValue(t);
  vi.spyOn(fetching, "fetchReleases").mockResolvedValue({
    checked: "2026-10-15T00:00:00Z",
    stats: { requests: 1, newReleases: 4 },
    notes: Array.from({ length: 4 }, (_, i) => ({
      technology: t.id,
      tag: `v1.${i + 1}.0`,
      version: `1.${i + 1}.0`,
      date: "2026-10-15",
      url: `https://github.com/example/example/releases/tag/v1.${i + 1}.0`,
      snapshot: "sha256:" + String(i).repeat(64),
      notes: "Source content",
    })),
  });
  const synth = vi.spyOn(synthesis, "synthesize").mockResolvedValue(7);
  // The docs module's pass: a baseline of 130 pages (no events), so nothing is planned for extraction.
  const pass = vi.spyOn(docs, "dailyPass").mockImplementation(async (_t, o) => {
    for (let i = 1; i <= 130; i++) o.progress?.(i, 130);
    writeAtomic(join(dir, "central", "docs", t.id, "state.json"), JSON.stringify({ at: new Date().toISOString() }));
    return { technology: t.id, sites: [{ site: t.homepage, prefix: "", method: "sitemap", pages: 130, copyRule: "html", dropped: {} as never, namespaces: [] }], checked: 130, outcomes: { first_seen: 130 }, events: {}, sections: { publishable: 0, held: {} }, baseline: true };
  });
  const plan = vi.spyOn(docs, "extract");
  // The advisories stage asks OSV; answered here with no advisories, so the test does not wait on the network.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ vulns: [] })));
  const service = new CoverageService(1, {
    admission: async () => ({ admit: true, why: "test" }),
  });
  try {
    service.submit(t.purl);
    await vi.waitFor(
      () => expect(service.status(t.purl)?.state).toBe("monitoring"),
      { timeout: 3000 },
    );
    const job = service.jobs.get(t.purl)!;
    expect(job.docs_done).toBe(130);
    expect(job.enumeration).toBe("complete");
    expect(job.releases_done).toBe(4);
    expect(pass).toHaveBeenCalled();
    expect(plan).toHaveBeenCalled();
    expect(synth).toHaveBeenCalledTimes(4); // no retrospective changes invented from docs baselines
    // A later run: the docs are due again, history is complete; still nothing invented.
    job.docs_checked = "2020-01-01T00:00:00Z";
    job.retry_at = "2020-01-01T00:00:00Z";
    (service as unknown as { pump: () => void }).pump();
    await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await vi.waitFor(() => expect(job.state).toBe("monitoring"), { timeout: 3000 });
    expect(synth).toHaveBeenCalledTimes(4);
  } finally {
    service.stop();
  }
});

test("a cached release from a different monorepo component is retracted, never republished as a feature", async () => {
  const { reconcileSources } = await import(
    "../src/onboarding/source-quality.ts"
  );
  const { loadStore } = await import("../src/pipeline/store.ts");
  const store = loadStore("ui");
  store.records["ui:bad"] = {
    technology: "ui",
    change_type: "new_api",
    breaking: false,
    surface: "code_api",
    subject: "newApi",
    subject_kind: "literal",
    summary: "A documented API",
    benefit: ["none"],
    prerequisites: [],
    conditions: [],
    requires: [],
    introduces: [],
    terms: [],
    replaces: [],
    related: [],
    sources: [],
    id: "ui:bad",
    status: "active",
    revision: 1,
    label_version: 1,
    history: [],
    releases: [
      {
        component: "pkg:npm/%40example/ui",
        version: "7.0.0",
        date: "2026-10-15",
        line: "7",
      },
    ],
    evidence: [
      {
        kind: "release_notes",
        url: "https://github.com/example/framework/releases/tag/core%407.0.0",
        quote: "Core release",
        snapshot: "sha256:abc",
      },
    ],
  } as import("../src/pipeline/store.ts").StoredRecord;
  store.ingested["ui@7.0.0#0.0"] = "ui:bad";
  expect(
    reconcileSources(
      {
        id: "ui",
        name: "UI",
        repo: "example/framework",
        components: ["pkg:npm/%40example/ui"],
        tag: /^ui@(\d+\.\d+\.\d+)$/,
        clean: (x) => x,
      },
      store,
    ),
  ).toBe(1);
  expect(store.records["ui:bad"]?.status).toBe("retracted");
  expect(store.ingested).toEqual({});
});

test("documentation reads as monitored only when pages were listed and all checked", () => {
  const job = (enumeration: string, docs_done: number, docs_total: number, docs_failed = 0) => ({ enumeration, docs_done, docs_total, docs_failed });
  expect(docsCoverage(job("complete", 212, 212))).toBe("documentation monitored (212/212 pages)");
  expect(docsCoverage(job("empty", 0, 0))).toBe("documentation not monitored: a docs site was found but listed no pages");
  expect(docsCoverage(job("complete", 0, 0))).toBe("documentation coverage partial (0/0 pages)");
  expect(docsCoverage(job("unavailable", 0, 0))).toBe("documentation not found (0/0 pages)");
  expect(docsCoverage(job("partial", 1653, 1657))).toBe("documentation coverage partial (1653/1657 pages)");
  expect(docsCoverage(job("complete", 10, 10, 2))).toBe("documentation coverage partial (8/10 pages)");
});
