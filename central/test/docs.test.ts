import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_HTTP, HttpClient } from "../src/collector/http.ts";
import { attribute, guideCandidate, guideMajor, markerIn } from "../src/docs/attribute.ts";
import { findNamespaces, listSite, llmsPages, RELEASE_NOTES } from "../src/docs/listing.ts";
import { extract, nextGate, passDue, plan, DOCS_PASS } from "../src/docs/extract.ts";
import type { Technology } from "../src/pipeline/technologies.ts";
import { docsDir, readEvents, refresh } from "../src/docs/monitor.ts";
import { fetchGuides } from "../src/pipeline/fetch.ts";
import { ownGuide } from "../src/docs/guides.ts";
import { compact, fenceFor, markViews, renderChange, unmarkQuote } from "../src/docs/render.ts";
import { editKind } from "../src/docs/materiality.ts";
import { parseRobots, RobotsCache } from "../src/docs/robots.ts";
import { siteSignal } from "../src/docs/signals.ts";
import type { Fetcher } from "../src/docs/resolve.ts";
import { writeAtomic } from "../src/pipeline/util.ts";
import { env, type TestEnv } from "./helpers.ts";

describe("robots.txt", () => {
  test("our group over *, longest match wins, Allow on a tie, wildcards and $", () => {
    const r = parseRobots(["User-agent: *", "Disallow: /", "", "User-agent: unstale-collector", "Disallow: /docs/api/", "Allow: /docs/api/public", "Disallow: /*.pdf$", "Sitemap: https://x.dev/sitemap.xml"].join("\n"));
    expect(r.allowed("https://x.dev/docs/intro")).toBe(true);
    expect(r.allowed("https://x.dev/docs/api/secret")).toBe(false);
    expect(r.allowed("https://x.dev/docs/api/public/a")).toBe(true);
    expect(r.allowed("https://x.dev/guide.pdf")).toBe(false);
    expect(r.allowed("https://x.dev/guide.pdf?x=1")).toBe(true);
    expect(r.sitemaps).toEqual(["https://x.dev/sitemap.xml"]);
  });

  test("without our group, the * group applies", () => {
    const r = parseRobots("User-agent: *\nDisallow: /docs/*?query=*\n");
    expect(r.allowed("https://x.dev/docs/a?query=1")).toBe(false);
    expect(r.allowed("https://x.dev/docs/a")).toBe(true);
  });
});

describe("namespaces", () => {
  const pages = (prefix: string, names: string[]) => names.map((n) => `${prefix}/${n}`);
  const names = ["intro", "install", "config", "api", "cli"];

  test("an older version mirroring the unversioned pages is excluded (Next.js /docs/15)", () => {
    const ns = findNamespaces([...pages("/docs", names), ...pages("/docs/15", names)], "16");
    expect(ns).toEqual([expect.objectContaining({ segment: "15", kept: false, mirror: 1 })]);
  });

  test("sibling versions keep the current major; a lone namespace is site structure (Prisma /docs/orm/v6, v7)", () => {
    const ns = findNamespaces([...pages("/docs/orm/v6", names), ...pages("/docs/orm/v7", names), ...pages("/docs/cli/v7", names)], "7");
    const kept = Object.fromEntries(ns.map((n) => [`${n.position}:${n.segment}`, n.kept]));
    expect(kept).toEqual({ "3:v6": false, "3:v7": true });
  });

  test("locales: English kept, translations excluded; ai, db and js are not locales", () => {
    const ns = findNamespaces([...pages("/en/5.2", names), ...pages("/fr/5.2", names), ...pages("/en/5.1", names), ...pages("/ai", names), ...pages("/db", names)], "5");
    const kept = Object.fromEntries(ns.map((n) => [`${n.kind}:${n.segment}`, n.kept]));
    expect(kept).toEqual({ "locale:en": true, "locale:fr": false, "version:5.1": false, "version:5.2": true });
  });

  test("release notes are not docs pages (the release pipeline owns them)", () => {
    expect(["/doc/build/changelog/unreleased_20/13641", "/docs/releases/5.1", "/docs/release-notes"].map((p) => RELEASE_NOTES.test(p))).toEqual([true, true, true]);
    expect(RELEASE_NOTES.test("/docs/guides/releasing-a-package")).toBe(false);
  });

  test("llms.txt .md links are copies of the page without the suffix", () => {
    expect(llmsPages("- [Controllers](https://docs.x.dev/controllers.md)\n- [Home](https://docs.x.dev/index.md)\n- [Elsewhere](https://y.dev/a.md)", "docs.x.dev")).toEqual([
      { url: "https://docs.x.dev/controllers", copy: "https://docs.x.dev/controllers.md" },
      { url: "https://docs.x.dev/", copy: "https://docs.x.dev/index.md" },
    ]);
  });

  test("llms.txt links relative to the file are pages too; www. is the same host", () => {
    expect(llmsPages("- [Config](/config.md)\n- [Guide](guide/why.md): why\n- [Blog](https://www.x.dev/blog)\n- [Mail](mailto:a@x.dev)", "x.dev", "https://x.dev/llms.txt")).toEqual([
      { url: "https://x.dev/config", copy: "https://x.dev/config.md" },
      { url: "https://x.dev/guide/why", copy: "https://x.dev/guide/why.md" },
      { url: "https://www.x.dev/blog" },
    ]);
  });
});

describe("attribution", () => {
  test("upgrade guides from the URL or, for an unnumbered guide page, its text; not migration feature pages", () => {
    expect(guideMajor("https://nextjs.org/docs/app/guides/upgrading/version-16")).toBe("16");
    expect(guideMajor("https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7")).toBe("7");
    expect(guideMajor("https://www.prisma.io/docs/orm/v7/prisma-migrate/getting-started")).toBeUndefined();
    expect(guideMajor("https://www.prisma.io/docs/orm/migrations/squashing")).toBeUndefined();
    expect(guideMajor("https://docs.nestjs.com/migration-guide", "# Migration guide\n\nThis article provides a set of guidelines for migrating from NestJS version 11 to version 12.")).toBe("12");
    expect(guideMajor("https://nextjs.org/docs/app/guides/upgrading/codemods", "upgrade to version 16")).toBeUndefined();
    expect(guideMajor("https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-miniflare-2")).toBeUndefined();
    // The AI SDK numbers its guides by release: the major's guide is `<major>-0`; a minor's or a part's is not one.
    expect(guideMajor("https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0")).toBe("7");
    expect(guideCandidate("https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0")).toBe(true);
    expect(guideMajor("https://ai-sdk.dev/docs/migration-guides/migration-guide-5-1")).toBeUndefined();
    expect(guideMajor("https://ai-sdk.dev/docs/migration-guides/migration-guide-5-0-data")).toBeUndefined();
    expect(guideMajor("https://ai-sdk.dev/docs/migration-guides/versioning")).toBeUndefined();
    expect(guideMajor("https://ai-sdk.dev/docs/migration-guides")).toBeUndefined();
    // The major before the word (Babel's `v8-migration`, React's `react-19-upgrade-guide`), and its API part.
    expect(guideMajor("https://babeljs.io/docs/v8-migration")).toBe("8");
    expect(guideMajor("https://babeljs.io/docs/v8-migration-api")).toBe("8");
    expect(guideMajor("https://react.dev/blog/2024/04/25/react-19-upgrade-guide")).toBe("19");
    expect(guideMajor("https://react.dev/blog/2024/04/25/react-19")).toBeUndefined();
    // An unnumbered guide's title: the target without `version` ("Upgrade to Babel 8"), or the major it leaves.
    expect(guideMajor("https://babeljs.io/docs/upgrade", "# Upgrade to Babel 8\n\nThis document lists the breaking changes")).toBe("8");
    expect(guideMajor("https://vite.dev/guide/migration", "# Migration from v7\n\nIf you are migrating from `rolldown-vite`")).toBe("8");
    expect(guideMajor("https://vite.dev/guide/migration", "# Migration\n\nSee the changelog.")).toBeUndefined();
  });

  test("markers on added lines name the version; runtime versions above the current major are ignored", () => {
    expect(markerIn("+The `ignore` option was added in v15.2.")).toEqual({ version: "15.2.0", marker: "added in v15.2" });
    expect(markerIn(".. versionadded:: 5.1\n+.. versionadded:: 5.2")).toEqual({ version: "5.2.0", marker: "versionadded:: 5.2" });
    expect(markerIn("+Requires Node.js. Available since v20.9.0", undefined, "16")).toBeUndefined();
    expect(markerIn("-Added in v1.2")).toBeUndefined();
    expect(markerIn("-We use it since version 3.0.\n+It has been used since version 3.0.")).toBeUndefined();
    expect(markerIn("+Tracks errors since v2.4.1 of the SDK.", undefined, "12")).toBeUndefined();
    expect(markerIn("+Added in v11.1.", undefined, "12")).toEqual({ version: "11.1.0", marker: "Added in v11.1" });
    // A version the package never released (another product on a shared docs host) is not a marker; a minor counts
    // by its x.y.0 key (releasedVersions adds it for every minor).
    const released = new Set(["0.3.0", "1.2.0", "1.2.18", "16.4.0", "16.4.1"]);
    expect(markerIn("+Starting in v0.7, agents stream.", released, "1")).toBeUndefined();
    expect(markerIn("+Available in v16.4.", released, "16")).toEqual({ version: "16.4.0", marker: "Available in v16.4" });
  });

  test("marker, then guide, then namespace, then unknown", () => {
    const s = { path: ["A"], status: "modified" as const, hunks: "+New in 7.1: `omit`.", added: 1, removed: 0 };
    expect(attribute(s, { guideMajor: "7" })).toEqual({ by: "marker", version: "7.1.0", marker: "New in 7.1" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "7" })).toEqual({ by: "guide", version: "7.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "6", maxMajor: "7" })).toEqual({ by: "guide", version: "6.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "4", maxMajor: "7" })).toEqual({ by: "old-guide", version: "4.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { guideMajor: "1", maxMajor: "0" })).toEqual({ by: "unreleased-guide", version: "1.0.0" });
    expect(attribute({ ...s, hunks: "+text" }, { namespaceMajor: "7" })).toEqual({ by: "namespace", line: "7" });
    expect(attribute({ ...s, hunks: "+text" }, {})).toEqual({ by: "unknown" });
  });
});

describe("guide ownership", () => {
  const own = (url: string, purls: string[], pages: string[], entries: string[] = []) => ownGuide(url, { purls, pages, guides: new Set<string>(), entries });

  test("another platform's guides on a per-platform site are not the Python SDK's (Sentry); its own are", () => {
    const sentry = "https://docs.sentry.io/platforms";
    const pages = [`${sentry}/android/migration/v1-to-v2`, `${sentry}/android/migration/timber-v5-6-2`, `${sentry}/javascript/guides/capacitor/migration/v1-to-v2`, `${sentry}/apple/migration/v8-to-v9`];
    const purls = ["pkg:pypi/sentry-sdk"];
    // The Python section is known from the technology's docs entry, even when the listing names none of its pages.
    for (const u of pages) expect(own(u, purls, pages, [`${sentry}/python/`])).toBe(false);
    const python = `${sentry}/python/migration/1.x-to-2.x`;
    expect(own(python, purls, [...pages, python], [`${sentry}/python/`])).toBe(true);
    // Without anything marking a section as the technology's, nothing is dropped.
    expect(own(pages[0]!, purls, pages)).toBe(true);
  });

  test("the Vue guide is not React Query's; the React guides are, and the Vue package keeps its own", () => {
    const q = "https://tanstack.com/query/latest/docs/framework";
    const pages = ["react", "vue", "solid", "svelte"].flatMap((f) => [`${q}/${f}/overview`, `${q}/${f}/guides/migrating-to-v5`]).concat(`${q}/react/guides/migrating-to-react-query-4`, `${q}/react/react-native`);
    const entries = ["https://tanstack.com/query/latest"];
    const react = ["pkg:npm/%40tanstack/react-query"];
    expect(own(`${q}/vue/guides/migrating-to-v5`, react, pages, entries)).toBe(false);
    expect(own(`${q}/react/guides/migrating-to-v5`, react, pages, entries)).toBe(true);
    expect(own(`${q}/react/guides/migrating-to-react-query-4`, react, pages, entries)).toBe(true);
    expect(own(`${q}/vue/guides/migrating-to-v5`, ["pkg:npm/%40tanstack/vue-query"], pages, entries)).toBe(true);
    expect(own(`${q}/react/guides/migrating-to-v5`, ["pkg:npm/%40tanstack/vue-query"], pages, entries)).toBe(false);
  });

  test("a guide to another named thing's version is not the technology's (OpenTelemetry's OBI config v2)", () => {
    const otel = ["pkg:npm/%40opentelemetry/semantic-conventions", "pkg:npm/%40opentelemetry/api"];
    expect(own("https://opentelemetry.io/docs/zero-code/obi/configure/migrate-to-config-v2", otel, [])).toBe(false);
    expect(own("https://mui.com/material-ui/migration/upgrade-to-grid-v2", ["pkg:npm/%40mui/material"], [])).toBe(false);
    // A target named by the technology or its site is its own major.
    expect(own("https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-to-prisma-7", ["pkg:npm/prisma"], [])).toBe(true);
    expect(own("https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-react-query-4", ["pkg:npm/%40tanstack/react-query"], [])).toBe(true);
    expect(own("https://docs.slack.dev/tools/node-slack-sdk/migration/migrating-socket-mode-package-to-v2", ["pkg:npm/%40slack/socket-mode"], [])).toBe(true);
    // `<words>[-vN]-to-vM` names the thing too: the socket-mode package's v2 is not `@slack/types`'s, MUI's v6 not Refine's.
    expect(own("https://docs.slack.dev/tools/node-slack-sdk/migration/migrating-socket-mode-package-to-v2", ["pkg:npm/%40slack/types"], [])).toBe(false);
    expect(own("https://refine.dev/core/docs/ui-integrations/material-ui/migration-guide/material-ui-v5-to-v6", ["pkg:npm/%40refinedev/inferencer"], [])).toBe(false);
    expect(own("https://langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5", ["pkg:pypi/langfuse"], [])).toBe(false);
    expect(own("https://langfuse.com/docs/observability/sdk/upgrade-path/python-v4-to-v5", ["pkg:pypi/langfuse"], [])).toBe(true);
    expect(own("https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4", ["pkg:npm/wrangler"], [])).toBe(true);
  });

  test("another language's section on a site split by language is not the package's (connectrpc's Go, Algolia's Django)", () => {
    const c = "https://connectrpc.com/docs";
    const pages = ["go/migrating-to-v2", "go/getting-started", "node/getting-started", "python/getting-started", "introduction"].map((p) => `${c}/${p}`);
    expect(own(`${c}/go/migrating-to-v2`, ["pkg:npm/%40connectrpc/connect"], pages, [`${c}/introduction/`])).toBe(false);
    expect(own(`${c}/go/migrating-to-v2`, ["pkg:golang/connectrpc.com/connect"], pages, [`${c}/introduction/`])).toBe(true);
    const a = "https://www.algolia.com/doc/framework-integration";
    const algolia = [`${a}/django/upgrade-guide`, `${a}/laravel/getting-started/upgrade-guide`, `${a}/rails/getting-started/setup`];
    for (const u of algolia.slice(0, 2)) expect(own(u, ["pkg:npm/algoliasearch"], algolia)).toBe(false);
    expect(own(algolia[0]!, ["pkg:pypi/algoliasearch-django"], algolia)).toBe(true);
    // A language word alone, with no other language beside it, is no language-split site.
    expect(own("https://example.dev/docs/go/migration", ["pkg:npm/example"], ["https://example.dev/docs/go/migration", "https://example.dev/docs/intro"])).toBe(true);
  });

  test("a docs generator's own site is not a package built with it (Docusaurus)", () => {
    const d = "https://docusaurus.io/docs/migration/v3";
    expect(own(d, ["pkg:npm/npm-to-yarn"], [d], ["https://docusaurus.io/docs"])).toBe(false);
    expect(own(d, ["pkg:npm/%40rjsf/utils"], [d], ["https://docusaurus.io/docs"])).toBe(false);
    expect(own(d, ["pkg:npm/%40docusaurus/core"], [d], ["https://docusaurus.io/docs"])).toBe(true);
  });

  test("another product's docs on a multi-product site are not the technology's (Hocuspocus, gesture handler, Pydantic AI, Bolt)", () => {
    const t = "https://tiptap.dev/docs";
    const tiptap = ["hocuspocus/getting-started/overview", "hocuspocus/getting-started/upgrade", "guides/upgrade-tiptap-v2", "guides/output-json-html", "editor/getting-started/install", "resources/changelog", "resources/contributing"].map((p) => `${t}/${p}`);
    const ext = ["pkg:npm/%40tiptap/extension-link"];
    expect(own(`${t}/hocuspocus/getting-started/upgrade`, ext, tiptap, [`${t}/resources/changelog`])).toBe(false);
    expect(own(`${t}/guides/upgrade-tiptap-v2`, ext, tiptap, [`${t}/resources/changelog`])).toBe(true);
    expect(own(`${t}/hocuspocus/getting-started/upgrade`, ["pkg:npm/%40hocuspocus/server"], tiptap, [`${t}/hocuspocus/getting-started/overview`])).toBe(true);
    const s = "https://docs.swmansion.com";
    const sw = ["react-native-gesture-handler/docs/guides/upgrading-to-3", "react-native-gesture-handler/docs/fundamentals/installation", "react-native-reanimated/docs/fundamentals/getting-started", "react-native-reanimated/docs/guides/migration-from-3.x"].map((p) => `${s}/${p}`);
    expect(own(sw[0]!, ["pkg:npm/react-native-reanimated"], sw, [`${s}/react-native-reanimated/`])).toBe(false);
    expect(own(sw[0]!, ["pkg:npm/react-native-gesture-handler"], sw, [`${s}/react-native-gesture-handler/`])).toBe(true);
    const p = "https://pydantic.dev/docs";
    const pyd = ["ai/overview/install", "ai/overview/migration", "validation/latest/get-started/install", "validation/2.12/get-started/migration"].map((x) => `${p}/${x}`);
    const entry = [`${p}/validation/latest/get-started/`];
    expect(own(`${p}/ai/overview/migration`, ["pkg:pypi/pydantic"], pyd, entry)).toBe(false);
    // `2.12` and `latest` are releases of one section.
    expect(own(`${p}/validation/2.12/get-started/migration`, ["pkg:pypi/pydantic"], pyd, entry)).toBe(true);
    const k = "https://docs.slack.dev/tools";
    const slack = ["bolt-js/migration/migration-v4", "bolt-js/reference", "node-slack-sdk/migration/legacy/migrating-to-v6", "node-slack-sdk/reference/types", "node-slack-sdk/oauth"].map((x) => `${k}/${x}`);
    expect(own(`${k}/bolt-js/migration/migration-v4`, ["pkg:npm/%40slack/types"], slack, [`${k}/node-slack-sdk/reference/types/`])).toBe(false);
    expect(own(`${k}/bolt-js/migration/migration-v4`, ["pkg:npm/%40slack/bolt"], slack, [`${k}/bolt-js/`])).toBe(true);
  });

  test("one product's docs in two halves, and an entry that is no docs section, drop nothing (Next.js, Bootstrap)", () => {
    const n = "https://nextjs.org/docs";
    const next = ["app/getting-started/installation", "app/guides/upgrading/version-16", "app/api-reference/config/eslint", "pages/getting-started/installation", "pages/guides/upgrading/version-13", "pages/guides/upgrading/version-16"].map((x) => `${n}/${x}`);
    for (const u of next.filter((x) => x.includes("/pages/guides/"))) expect(own(u, ["pkg:npm/eslint-config-next"], next, [`${n}/app/api-reference/config/eslint`])).toBe(true);
    const b = "https://getbootstrap.com/docs/6.0";
    const boot = [`${b}/guides/migration`, `${b}/guides/quickstart`, `${b}/dist/css/bootstrap.min.css`];
    expect(own(boot[0]!, ["pkg:npm/bootstrap"], boot, [boot[2]!])).toBe(true);
  });

  test("one service's page in a catalogue of integrations is not an SDK's (RudderStack's Intercom destination)", () => {
    const r = "https://www.rudderstack.com/docs/destinations/streaming-destinations";
    const services = Array.from({ length: 25 }, (_, i) => `${r}/service-${String.fromCharCode(97 + i)}x`);
    const pages = [...services, `${r}/intercom`, `${r}/intercom/migration-guide`, "https://www.rudderstack.com/docs/user-guides/migration-guides/migrate-sdk"];
    const sdk = ["pkg:npm/%40rudderstack/rudder-sdk-node"];
    expect(own(`${r}/intercom/migration-guide`, sdk, pages, ["https://www.rudderstack.com/docs/"])).toBe(false);
    expect(own(`${r}/intercom/migration-guide`, ["pkg:npm/intercom-client"], pages, ["https://www.rudderstack.com/docs/"])).toBe(true);
    expect(own("https://www.rudderstack.com/docs/user-guides/migration-guides/migrate-sdk", sdk, pages, ["https://www.rudderstack.com/docs/"])).toBe(true);
  });

  test("sections that are topics, not variants, drop nothing (Next.js, MUI, NestJS)", () => {
    const next = ["https://nextjs.org/docs/app/guides/upgrading/version-16", "https://nextjs.org/docs/pages/guides/upgrading/version-16", "https://nextjs.org/docs/app/guides/css-in-js", "https://nextjs.org/docs/app/api-reference/config/eslint"];
    for (const u of next.slice(0, 2)) expect(own(u, ["pkg:npm/eslint-config-next"], next, ["https://nextjs.org/docs/app/api-reference/config/eslint"])).toBe(true);
    // The icons package's docs entry is one page, not a section of its own.
    const mui = ["https://mui.com/material-ui/migration/upgrade-to-v9", "https://mui.com/material-ui/material-icons", "https://mui.com/material-ui/getting-started/installation"];
    expect(own(mui[0]!, ["pkg:npm/%40mui/icons-material", "pkg:npm/%40mui/material"], mui, ["https://mui.com/material-ui/material-icons/"])).toBe(true);
    const nest = ["https://docs.nestjs.com/migration-guide", "https://docs.nestjs.com/cli/overview", "https://docs.nestjs.com/cli/usages"];
    expect(own(nest[0]!, ["pkg:npm/%40nestjs/cli"], nest, ["https://docs.nestjs.com/cli/overview"])).toBe(true);
  });
});

describe("edit kinds", () => {
  const k = (rem: string, add: string) => editKind({ hunks: [rem && `-${rem}`, add && `+${add}`].filter(Boolean).join("\n") });
  test("trivial edits are recognised", () => {
    expect(k("Use the  option.", "Use the option")).toBe("format");
    expect(k("See [the guide](/old).", "See [the guide](/new).")).toBe("link");
    expect(k("Defined in: [retryer.ts:91](https://x/retryer.ts#L91)", "Defined in: [retryer.ts:120](https://x/retryer.ts#L120)")).toBe("renumber");
    expect(k("This is teh option for caching.", "This is the option for caching.")).toBe("typo");
    expect(k("We can obtain a reference to any instance from the standalone object.", "The standalone object lets you get a reference to any instance at all.")).toBe("reword");
  });
  test("meaning-flipping words, versions and technical tokens are always substantive", () => {
    expect(k("The cache is enabled by default.", "The cache is disabled by default.")).toBe("substantive");
    expect(k("Requires Node.js 18.18 or later.", "Requires Node.js 20.9 or later.")).toBe("substantive");
    expect(k("Node 20 required.", "Node 22 required.")).toBe("substantive");
    expect(k("| Server Actions | 100.0% 208/208 passed |", "| Server Actions | 100.0% 218/218 passed |")).toBe("renumber");
    expect(k("Pass the `cache` option.", "Pass the `revalidate` option.")).toBe("substantive");
    expect(k("", "Seeding no longer runs automatically after migrate dev; run prisma db seed yourself.")).toBe("substantive");
    expect(k("Вы можете использовать ловушку здесь.", "Вы можете использовать хук здесь.")).toBe("substantive");
    expect(k("Prisma ORM 8 is the current release.", "Prisma ORM 8 is a release candidate.")).toBe("substantive");
    expect(k("<span>hello</span><em>world</em>", '<span>hello</span>{" "}<em>world</em>')).toBe("substantive");
    expect(editKind({ hunks: "+<AppOnly>\n ## React 19.2\n+</AppOnly>" })).toBe("format");
  });
});

describe("render", () => {
  test("word-marked rendering drops line-number headers and tells the model to extract only changes", () => {
    const out = renderChange("https://x.dev/a", "modified", [{ path: ["A"], status: "modified", hunks: "@@ -1,2 +1,2 @@\n ctx\n-timeout is 10 s by default here\n+timeout is 30 s by default here\n@@ -9 +9 @@\n+new line", added: 2, removed: 1 }], { words: true });
    expect(out).toContain("~timeout is [-10-]{+30+} s by default here");
    expect(out).not.toContain("@@");
    expect(out).toContain("…\n+new line");
    expect(out).toContain("Emit records only for what changed");
    expect(compact("@@ -1 +1 @@\n+x")).toBe("+x");
  });

  test("quotes from word-marked notes are page text, grounded in the text after or before the change", () => {
    expect(unmarkQuote("[-turbopackFileSystemCache-]")).toBe("turbopackFileSystemCache");
    expect(unmarkQuote("timeout defaults to [-10-]{+30+} s")).toBe("timeout defaults to 30 s");
    expect(unmarkQuote("~Use `cache`")).toBe("Use `cache`");
    const v = markViews("~timeout defaults to [-10-]{+30+} s");
    expect([v.after, v.before]).toEqual(["~timeout defaults to 30 s", "~timeout defaults to 10 s"]);
  });

  test("the fence is longer than any backtick run in the page, so page text cannot close it", () => {
    const hunks = "+```js\n+code\n+```\n+```` nested";
    expect(fenceFor(hunks)).toBe("`````");
    const out = renderChange("https://x.dev/a", "modified", [{ path: ["A", "B"], status: "modified", hunks, added: 4, removed: 0 }]);
    expect(out).toContain("Section: A > B (modified)\n`````diff\n");
    expect(out).toContain("untrusted data");
  });
});

describe("listing from the site's links", () => {
  let e: TestEnv;
  beforeEach(async () => void (e = await env()));
  afterEach(async () => e.close());
  const nav = (links: string[]) => `<!doctype html><html><body><nav>${links.map((l) => `<a href=${l}>x</a>`).join("")}</nav><main>Text.</main></body></html>`;

  test("no sitemap or llms.txt: one page read per directory, links in scope and allowed by robots.txt", async () => {
    const guide = ["/docs/guide/a", "/docs/guide/b", "/docs/guide/c"];
    const api = ["/docs/api/x", "/docs/api/y"];
    const hits = new Map<string, number>();
    const serve = (p: string, body: string) => e.route(p, (_q, r) => { hits.set(p, (hits.get(p) ?? 0) + 1); r.writeHead(200, { "content-type": "text/html" }).end(body); });
    e.route("/robots.txt", (_q, r) => void r.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /docs/api/y\nDisallow: /private\n"));
    e.route("/docs/old/z", (_q, r) => void r.writeHead(301, { location: "/private/z" }).end());
    serve("/private/z", nav(["/docs/hidden/p"]));
    for (const p of guide) serve(p, nav([...guide, "/docs/api/x", "/docs/old/z", "/blog/post", "https://elsewhere.dev/docs/z", "/docs/style.css"]));
    for (const p of api) serve(p, nav([...api, "./x#part", "/docs/guide/a"]));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const l = await listSite(http, new RobotsCache(http), `${e.base}/docs/guide/a`, "/docs");
    // A redirect to a disallowed path is not read: its links never reach the listing.
    expect([l.method, l.pages.map((p) => new URL(p.url).pathname)]).toEqual(["links", ["/docs/api/x", ...guide.slice(0, 1), ...guide.slice(1), "/docs/old/z"].sort()]);
    expect(l.dropped.robots).toBe(0); // a disallowed link is never queued
    expect([...hits].sort(([a], [b]) => a.localeCompare(b))).toEqual([["/docs/api/x", 1], ["/docs/guide/a", 1]]);
  });

  test("an entry with a trailing slash is the base of its relative links", async () => {
    e.route("/docs/", (_q, r) => void r.writeHead(200, { "content-type": "text/html" }).end(nav(["a", "b"])));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const l = await listSite(http, new RobotsCache(http), `${e.base}/docs/`, "/docs");
    expect(l.pages.map((p) => new URL(p.url).pathname)).toEqual(["/docs", "/docs/a", "/docs/b"]);
  });

  test("an entry page that lands on another host is listed on that host", async () => {
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1", "localhost"], retryBaseMs: 10, timeoutMs: 2_000 });
    const other = e.base.replace("127.0.0.1", "localhost");
    e.route("/docs/intro", (q, r) => {
      if (q.headers.host?.startsWith("127.0.0.1")) return void r.writeHead(301, { location: `${other}/pages/start` }).end();
      r.writeHead(404).end();
    });
    e.route("/pages/start", (_q, r) => void r.writeHead(200, { "content-type": "text/html" }).end(nav(["/pages/a", "/pages/b"])));
    const l = await listSite(http, new RobotsCache(http), `${e.base}/docs/intro`, "/docs");
    expect([l.site, l.prefix, l.method, l.pages.map((p) => p.url)]).toEqual([`${other}/pages/start`, "", "links", [`${other}/pages/a`, `${other}/pages/b`, `${other}/pages/start`]]);
  });
});

describe("pass gate", () => {
  const T = Date.parse("2026-10-16T00:00:00Z");
  const day = 86_400_000;
  const g = { followupMs: 3 * day, maxAgeMs: 0 };
  const last = new Date(T - day).toISOString();
  test("a pass runs first as a baseline, then on a new release, once more after the follow-up, and not otherwise", () => {
    expect(passDue(undefined, "pkg:npm/a@1.0.0", undefined, T, g)).toBe("baseline");
    let gate = nextGate(undefined, "baseline", "pkg:npm/a@1.0.0", 10, 3000, T, g);
    expect(passDue(gate, "pkg:npm/a@1.0.0", last, T + 30 * day, g)).toBeUndefined(); // no release: no pass, however long
    expect(passDue(gate, "pkg:npm/a@1.1.0", last, T, g)).toBe("release");
    gate = nextGate(gate, "release", "pkg:npm/a@1.1.0", 10, 3000, T, g);
    expect(passDue(gate, "pkg:npm/a@1.1.0", last, T + 2 * day, g)).toBeUndefined();
    expect(passDue(gate, "pkg:npm/a@1.1.0", last, T + 3 * day, g)).toBe("followup");
    gate = nextGate(gate, "followup", "pkg:npm/a@1.1.0", 10, 3000, T + 3 * day, g);
    expect(gate.followupAt).toBeUndefined();
    expect(passDue(gate, "pkg:npm/a@1.1.0", last, T + 60 * day, g)).toBeUndefined();
  });
  test("a pass cut short by the page budget continues; an unreadable registry falls back to the daily cadence; a max age re-checks", () => {
    const cut = nextGate(undefined, "release", "r1", 3000, 3000, T, g);
    expect(passDue(cut, "r1", last, T, g)).toBe("continue");
    expect(passDue(nextGate(cut, "continue", "r1", 12, 3000, T, g), "r1", last, T, g)).toBeUndefined();
    expect(passDue({ release: "r1" }, undefined, new Date(T - DOCS_PASS.freshMs).toISOString(), T, g)).toBe("daily");
    expect(passDue({ release: "r1" }, undefined, new Date(T - 3600_000).toISOString(), T, g)).toBeUndefined();
    expect(passDue({ release: "r1" }, "r1", new Date(T - 31 * day).toISOString(), T, { ...g, maxAgeMs: 30 * day })).toBe("age");
  });
  test("a site whose listing named no page is listed again a day later, without waiting for a release", () => {
    const failed = nextGate(undefined, "baseline", "r1", 0, 3000, T, g, true);
    expect(passDue(failed, "r1", last, T + 3600_000, g)).toBeUndefined();
    expect(passDue(failed, "r1", last, T + DOCS_PASS.freshMs, g)).toBe("relist");
    expect(nextGate(failed, "relist", "r1", 200, 3000, T + day, g).unlistedAt).toBeUndefined();
  });
});

describe("monitor", () => {
  let e: TestEnv;
  let dir: string;
  let saved: string | undefined;
  beforeEach(async () => {
    e = await env();
    dir = await mkdtemp(join(tmpdir(), "unstale-docs-"));
    saved = process.env.UNSTALE_CENTRAL_DIR;
    process.env.UNSTALE_CENTRAL_DIR = dir;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
    else process.env.UNSTALE_CENTRAL_DIR = saved;
    await e.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("guides come from the docs module: current and previous major only, ingested whole once, other pages not fetched", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const site: Record<string, string> = {
      "/docs/intro": html("<h1>Intro</h1><p>Hello.</p>"),
      "/docs/upgrading/version-1": html("<h1>Upgrading to 1</h1><p>Old.</p>"),
      "/docs/upgrading/version-3": html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 22 required.</p>"),
      "/docs/migration-guide": html("<h1>Migration guide</h1><p>Migrating from version 1 to version 2.</p>"),
    };
    const hits = new Map<string, number>();
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${Object.keys(site).map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    for (const p of Object.keys(site)) e.route(p, (_q, r) => { hits.set(p, (hits.get(p) ?? 0) + 1); r.writeHead(200, { "content-type": "text/html" }).end(site[p]); });
    writeAtomic(join(docsDir("g"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/g"],
      resolutions: [{ purl: "pkg:generic/g", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 4, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const tech = { id: "g", name: "G", repo: "", components: ["pkg:generic/g"], tag: /^v(.*)$/, clean: (b: string) => b };
    const first = await fetchGuides(tech, [{ version: "3.0.0", date: "2026-01-01" }], { refresh: true, http });
    expect(first.map((g) => [new URL(g.url).pathname, g.version, g.kind])).toEqual([["/docs/upgrading/version-3", "3.0.0", "upgrade_guide"], ["/docs/migration-guide", "2.0.0", "upgrade_guide"]]);
    expect(first[0]!.notes).toContain("Node 22 required.");
    const sampled = hits.get("/docs/intro") ?? 0; // the site's copy rule is learned once from a few sampled pages
    // An edited guide is not re-ingested whole: its first snapshot stays the source; edits arrive as section notes.
    site["/docs/upgrading/version-3"] = html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 24 required.</p>");
    const second = await fetchGuides(tech, [], { refresh: true, http });
    expect(second.map((g) => g.snapshot)).toEqual(first.map((g) => g.snapshot));
    expect(hits.get("/docs/intro") ?? 0).toBe(sampled); // a guides-only check fetches no other page
    // A legacy entry from the table-driven path (a repository file) is history, not a source.
    const ip = join(dir, "guides", "g", "index.json");
    const index = JSON.parse(readFileSync(ip, "utf8"));
    index.guides.push({ ...index.guides[0], url: "https://github.com/o/r/blob/abc/docs/upgrading/version-3.md", repo: "o/r", path: "docs/upgrading/version-3.md", commit: "abc" });
    writeAtomic(ip, JSON.stringify(index));
    expect((await fetchGuides(tech, [], { offline: true })).map((g) => new URL(g.url).hostname)).toEqual(["127.0.0.1", "127.0.0.1"]);
  });

  test("a guide ingested before guides were told apart by variant stays in the index but is no source", async () => {
    const q = "https://tanstack.com/query/latest/docs/framework";
    const page = { site: "https://tanstack.com/", watch: { id: "w" } };
    writeAtomic(join(docsDir("rq"), "state.json"), JSON.stringify({
      technology: "rq", at: "x", sites: [{ site: "https://tanstack.com/query/latest", prefix: "/query" }],
      pages: { [`${q}/react/guides/migrating-to-v5`]: { ...page, guideMajor: "5" }, [`${q}/vue/guides/migrating-to-v5`]: { ...page, guideMajor: "5" }, [`${q}/vue/overview`]: page },
    }));
    const entry = (f: string, h: string) => ({ technology: "rq", kind: "upgrade_guide", tag: "guide-5", version: "5.0.0", date: "2026-01-01", url: `${q}/${f}/guides/migrating-to-v5`, snapshot: `sha256:${h}`, keyTag: `+guide.${h.slice(0, 8)}` });
    const guides = [entry("react", "a".repeat(64)), entry("vue", "b".repeat(64))];
    for (const g of guides) writeAtomic(join(dir, "guides", "rq", `5.${g.snapshot.slice(7, 15)}.md`), `# ${g.url}`);
    writeAtomic(join(dir, "guides", "rq", "index.json"), JSON.stringify({ checked: new Date().toISOString(), guides }));
    const tech = { id: "rq", name: "React Query", repo: "", components: ["pkg:npm/%40tanstack/react-query"], tag: /^v(.*)$/, clean: (b: string) => b };
    expect((await fetchGuides(tech, [], { offline: true })).map((g) => g.url)).toEqual([`${q}/react/guides/migrating-to-v5`]);
  });

  test("a site whose llms-full.txt is unchanged since every page was checked is not checked page by page", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const paths = ["/docs/a", "/docs/b"];
    let full = "# Docs\n\n" + "The whole documentation in one file. ".repeat(10);
    const hits = new Map<string, number>();
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    e.route("/docs/llms-full.txt", (_q, r) => void r.writeHead(200, { "content-type": "text/plain" }).end(full));
    for (const p of paths) e.route(p, (_q, r) => { hits.set(p, (hits.get(p) ?? 0) + 1); r.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>${p}</h1><p>Text.</p>`)); });
    writeAtomic(join(docsDir("q"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/q"],
      resolutions: [{ purl: "pkg:generic/q", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 2, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "q", purls: ["pkg:generic/q"] };
    const on = (day: number) => refresh(src, { http, now: () => new Date(Date.UTC(2026, 9, day)) });
    expect((await on(1)).checked).toBe(2);
    const seen = hits.get("/docs/a");
    const quiet = await on(2);
    expect([quiet.checked, quiet.quiet]).toEqual([0, { [`${e.base}/docs`]: "llms-full" }]);
    expect(hits.get("/docs/a")).toBe(seen);
    full += "A new section.";
    const changed = await on(3);
    expect([changed.checked, changed.quiet]).toEqual([2, undefined]);
  });

  test("on a quiet site an unnumbered guide whose major was never read is read from its stored snapshot, with no request", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const paths = ["/docs/a", "/docs/migration"];
    const hits = new Map<string, number>();
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    e.route("/docs/llms-full.txt", (_q, r) => void r.writeHead(200, { "content-type": "text/plain" }).end("# Docs\n\n" + "The whole documentation in one file. ".repeat(10)));
    const body: Record<string, string> = { "/docs/a": "<h1>A</h1><p>Text.</p>", "/docs/migration": "<h1>Migration from v2</h1><p>Breaking changes.</p>" };
    for (const p of paths) e.route(p, (_q, r) => { hits.set(p, (hits.get(p) ?? 0) + 1); r.writeHead(200, { "content-type": "text/html" }).end(html(body[p]!)); });
    writeAtomic(join(docsDir("m"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/m"],
      resolutions: [{ purl: "pkg:generic/m", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 2, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const on = (day: number) => refresh({ technology: "m", purls: ["pkg:generic/m"] }, { http, now: () => new Date(Date.UTC(2026, 9, day)) });
    await on(1);
    const sp = join(docsDir("m"), "state.json");
    const state = JSON.parse(readFileSync(sp, "utf8"));
    expect(state.pages[`${e.base}/docs/migration`].guideMajor).toBe("3");
    delete state.pages[`${e.base}/docs/migration`].guideMajor; // as kept before the title rule
    writeAtomic(sp, JSON.stringify(state));
    const seen = hits.get("/docs/migration");
    expect((await on(2)).quiet).toEqual({ [`${e.base}/docs`]: "llms-full" });
    expect(hits.get("/docs/migration")).toBe(seen);
    expect(JSON.parse(readFileSync(sp, "utf8")).pages[`${e.base}/docs/migration`].guideMajor).toBe("3");
  });

  test("a site built from a repository is quiet when no commit touched its docs directories; GitHub unreadable is no signal", async () => {
    const resolutions = [{ purl: "pkg:npm/x", answer: { kind: "site+repo" }, pairs: [{ site: "https://docs.x.dev/", repo: "o/x", validated: true, docDirs: ["docs"] }], evidence: {}, requests: 0 }] as never;
    const fetcher = (commits: string, status = 200): Fetcher => ({ requests: 0, get: async (url) => (url.includes("api.github.com") ? { status, url, text: commits } : { status: 404, url, text: "" }) });
    const last = { since: "2026-10-01T00:00:00Z", newPages: false };
    expect(await siteSignal(fetcher("[]"), { site: "https://docs.x.dev/", prefix: "" }, resolutions, last)).toEqual({ quiet: "repo" });
    expect(await siteSignal(fetcher('[{"sha":"a"}]'), { site: "https://docs.x.dev/", prefix: "" }, resolutions, last)).toEqual({});
    expect(await siteSignal(fetcher("", 403), { site: "https://docs.x.dev/", prefix: "" }, resolutions, last)).toEqual({});
    expect(await siteSignal(fetcher("[]"), { site: "https://docs.x.dev/", prefix: "" }, resolutions, { ...last, newPages: true })).toEqual({});
    expect(await siteSignal(fetcher("[]"), { site: "https://other.dev/", prefix: "" }, resolutions, last)).toEqual({});
  });

  test("a failed listing keeps the site's pages; pages first listed later are a baseline, not created", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const paths = ["/docs/a", "/docs/b"];
    let sitemapUp = false;
    e.route("/sitemap.xml", (_q, r) => {
      if (!sitemapUp) return void r.writeHead(404).end();
      r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`);
    });
    for (const p of paths) e.route(p, (_q, r) => void r.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>${p}</h1><p>Text.</p>`)));
    writeAtomic(join(docsDir("f"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/f"],
      resolutions: [{ purl: "pkg:generic/f", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 2, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "f", purls: ["pkg:generic/f"] };
    const first = await refresh(src, { http }); // nothing names a page (the entry page is a 404)
    expect([first.checked, first.sites[0]!.listingFailed]).toEqual([0, true]);
    sitemapUp = true;
    const second = await refresh(src, { http });
    expect([second.checked, second.events, second.sites[0]!.listingFailed]).toEqual([2, {}, undefined]);
    sitemapUp = false;
    const third = await refresh(src, { http });
    expect([third.checked, third.events, third.sites[0]!.listingFailed]).toEqual([2, {}, true]);
  });

  test("a page budget checks new pages first, then the least recently checked; guides always", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const paths = ["/docs/a", "/docs/b", "/docs/c", "/docs/d", "/docs/upgrading/version-3"];
    e.route("/sitemap.xml", (_q, r) => void r.writeHead(200, { "content-type": "application/xml" }).end(`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`));
    for (const p of paths) e.route(p, (_q, r) => { r.writeHead(200, { "content-type": "text/html" }).end(html(`<h1>${p}</h1><p>Text.</p>`)); });
    writeAtomic(join(docsDir("b"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/b"],
      resolutions: [{ purl: "pkg:generic/b", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 5, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "b", purls: ["pkg:generic/b"] };
    const checkedOn = (day: number) => refresh(src, { http, budget: 2, now: () => new Date(Date.UTC(2026, 9, day)) }).then(() => {
      const st = JSON.parse(readFileSync(join(docsDir("b"), "state.json"), "utf8"));
      return Object.entries<{ checked?: string }>(st.pages).filter(([, p]) => p.checked === new Date(Date.UTC(2026, 9, day)).toISOString()).map(([u]) => new URL(u).pathname).sort();
    });
    expect(await checkedOn(1)).toEqual(["/docs/a", "/docs/b", "/docs/upgrading/version-3"]);
    expect(await checkedOn(2)).toEqual(["/docs/c", "/docs/d", "/docs/upgrading/version-3"]);
    expect(await checkedOn(3)).toEqual(["/docs/a", "/docs/b", "/docs/upgrading/version-3"]);
  });

  test("baseline, then created, modified, deleted, moved and attributed sections; a rerun adds nothing", async () => {
    const html = (body: string) => `<!doctype html><html><body><main>${body}</main></body></html>`;
    const site: Record<string, { status: number; body?: string; location?: string }> = {
      "/docs/a": { status: 200, body: html("<h1>A</h1><h2>Options</h2><p>timeout defaults to 10 s.</p>") },
      "/docs/b": { status: 200, body: html("<h1>B</h1><h2>Usage</h2><p>Call b() once.</p><p>Then call c().</p>") },
      "/docs/old": { status: 200, body: html("<h1>Old</h1><h2>Legacy</h2><p>Use legacy() here.</p>") },
      "/docs/upgrading/version-3": { status: 200, body: html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 20 required.</p>") },
      "/docs/migration": { status: 200, body: html("<h1>Migration</h1><p>Migrating from version 2 to version 3.</p>") },
    };
    let listed = ["/docs/a", "/docs/b", "/docs/old", "/docs/upgrading/version-3", "/docs/migration"];
    const sitemap = () => `<?xml version="1.0"?><urlset>${listed.map((p) => `<url><loc>${e.base}${p}</loc></url>`).join("")}</urlset>`;
    e.route("/sitemap.xml", (_q, s) => void s.writeHead(200, { "content-type": "application/xml" }).end(sitemap()));
    for (const p of [...Object.keys(site), "/docs/new", "/docs/b2"]) {
      e.route(p, (_q, s) => {
        const x = site[p];
        if (!x) return void s.writeHead(404).end();
        if (x.location) return void s.writeHead(x.status, { location: x.location }).end();
        s.writeHead(x.status, { "content-type": "text/html" }).end(x.body ?? "");
      });
    }
    writeAtomic(join(docsDir("t"), "sources.json"), JSON.stringify({
      at: "x", purls: ["pkg:generic/t"],
      resolutions: [{ purl: "pkg:generic/t", answer: { kind: "site-only", site: `${e.base}/docs`, sites: [{ site: `${e.base}/docs`, pages: 4, prefix: "/docs" }] }, pairs: [], evidence: {}, requests: 0 }],
    }));
    const http = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], retryBaseMs: 10, timeoutMs: 2_000 });
    const src = { technology: "t", purls: ["pkg:generic/t"] };

    const first = await refresh(src, { http });
    expect(first).toMatchObject({ baseline: true, checked: 5, events: {} });

    site["/docs/a"]!.body = html("<h1>A</h1><h2>Options</h2><p>timeout defaults to 30 s. Added in v2.1.</p>");
    site["/docs/new"] = { status: 200, body: html("<h1>New</h1><h2>Streaming</h2><p>Use stream().</p>") };
    delete site["/docs/old"];
    site["/docs/b2"] = { status: 200, body: html("<h1>B</h1><h2>Usage</h2><p>Call b() once.</p><p>Then call d().</p>") };
    site["/docs/b"] = { status: 301, location: `${e.base}/docs/b2` };
    site["/docs/upgrading/version-3"]!.body = html("<h1>Upgrading to 3</h1><h2>Breaking</h2><p>Node 22 required.</p>");
    listed = ["/docs/a", "/docs/b2", "/docs/new", "/docs/upgrading/version-3", "/docs/migration"];

    const second = await refresh(src, { http });
    expect(second.events).toEqual({ created: 1, deleted: 1, moved: 1, modified: 2 });
    const byKind = Object.fromEntries(readEvents("t").map((x) => [`${x.kind} ${new URL(x.url).pathname}`, x]));
    expect(byKind["modified /docs/a"]!.sections).toEqual([expect.objectContaining({ path: ["A", "Options"], attribution: { by: "marker", version: "2.1.0", marker: "Added in v2.1" } })]);
    expect(byKind["modified /docs/upgrading/version-3"]!.sections![0]!.attribution).toEqual({ by: "guide", version: "3.0.0" });
    expect(byKind["created /docs/new"]!.sections!.map((s) => s.attribution.by)).toEqual(["unknown", "unknown"]);
    expect(byKind["deleted /docs/old"]!.sections!.map((s) => s.status)).toEqual(["removed", "removed"]);
    expect(byKind["moved /docs/b"]).toMatchObject({ to: `${e.base}/docs/b2`, sections: [expect.objectContaining({ path: ["B", "Usage"], status: "modified" })] });

    // Extraction gets the versioned sections only, one note per version; the rest are held.
    const p = await plan("t");
    expect(p.notes.map((n) => [new URL(n.note.url).pathname, n.note.version, n.sections])).toEqual([["/docs/upgrading/version-3", "3.0.0", 1], ["/docs/a", "2.1.0", 1]]);
    expect(p.notes[1]!.note.notes).toContain("~timeout defaults to [-10-]{+30+} s.{+ Added in v2.1.+}");
    expect(p.held).toEqual({ unknown: 5 });
    expect(p.settled).toHaveLength(3); // created, deleted and moved: held sections only, so never diffed again
    expect((await plan("t", { context: 3, words: false })).notes[1]!.note.notes).toContain("-timeout defaults to 10 s.");
    // The budget sees each note's measured text before any model call; a refusal stops there and the notes stay planned.
    const seen: string[] = [];
    const refused = await extract({ id: "t", name: "T", components: ["pkg:generic/t"] } as unknown as Technology, Infinity, undefined, (text) => (seen.push(text), false));
    expect(refused).toMatchObject({ notes: 0, stopped: true });
    expect(seen).toEqual([p.notes[0]!.note.notes]);
    expect((await plan("t")).notes).toHaveLength(2);

    const third = await refresh(src, { http });
    expect(third.events).toEqual({});
    // The unnumbered guide's major, read from its text on first sight, survives later refreshes.
    const state = JSON.parse(readFileSync(join(docsDir("t"), "state.json"), "utf8"));
    expect(state.pages[`${e.base}/docs/migration`].guideMajor).toBe("3");
    expect(readEvents("t")).toHaveLength(5);
  });
});
