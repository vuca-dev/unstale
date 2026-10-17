// The docs module from the command line.
//   docs resolve <purl>                         trace a package's docs sources (no state written)
//   docs refresh <technology> [--purl P] [--limit N] [--resolve]
//                                               the daily pass: list, check, record change events
//   docs events <technology> [--hunks]          the event log, with recomputed hunks on request
//   docs extract <technology> [--run] [--limit N]
//                                               extraction notes for versioned changes; a dry run unless --run
import { parseArgs } from "node:util";
import { DEFAULT_HTTP, HttpClient } from "../collector/http.ts";
import { TECHNOLOGIES } from "../pipeline/technologies.ts";
import { httpFetcher } from "./fetcher.ts";
import { extract, plan } from "./extract.ts";
import { eventChanges, readEvents, refresh } from "./monitor.ts";
import { renderChange } from "./render.ts";
import { createResolver } from "./resolve.ts";
import { RobotsCache } from "./robots.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    purl: { type: "string" },
    limit: { type: "string" },
    resolve: { type: "boolean", default: false },
    hunks: { type: "boolean", default: false },
    run: { type: "boolean", default: false },
  },
});
const [command, arg] = positionals;
const http = new HttpClient(DEFAULT_HTTP);

if (command === "resolve" && arg) {
  const r = await createResolver(httpFetcher(http, new RobotsCache(http))).resolve(arg);
  console.log(JSON.stringify(r, null, 1));
} else if (command === "refresh" && arg) {
  const purls = values.purl ? [values.purl] : (TECHNOLOGIES[arg]?.components ?? []).map((p) => p.replace("%40", "@"));
  if (!purls.length) throw new Error(`no package for ${arg}: pass --purl`);
  const report = await refresh(
    { technology: arg, purls },
    { http, resolve: values.resolve, ...(values.limit ? { limit: Number(values.limit) } : {}), log: (s) => console.error(s) },
  );
  console.log(JSON.stringify(report, null, 1));
} else if (command === "events" && arg) {
  for (const e of readEvents(arg)) {
    const held = (e.sections ?? []).filter((s) => s.attribution.by !== "marker" && s.attribution.by !== "guide").length;
    console.log(`${e.at} ${e.kind} ${e.url}${e.to ? ` → ${e.to}` : ""}${e.pages ? ` (${e.pages} pages)` : ""}${e.sections ? ` — ${e.sections.length} sections, ${held} held` : ""}`);
    if (values.hunks && e.sections?.length) console.log(renderChange(e.url, e.kind, await eventChanges(e)));
  }
} else if (command === "extract" && arg) {
  if (values.run) console.log(JSON.stringify(await extract(arg, values.limit ? Number(values.limit) : Infinity, (s) => console.error(s))));
  else {
    const p = await plan(arg);
    for (const n of p.notes) console.log(`--- ${n.note.url} → ${n.note.version} (${n.sections} sections)\n${n.note.notes}`);
    const chars = p.notes.reduce((s, n) => s + n.note.notes.length, 0);
    console.log(JSON.stringify({ notes: p.notes.length, chars, held: p.held, trivial: p.trivial, skipped: p.skipped }));
  }
} else {
  console.error("usage: docs resolve <purl> | docs refresh <technology> [--purl P] [--limit N] [--resolve] | docs events <technology> [--hunks] | docs extract <technology> [--run] [--limit N]");
  process.exitCode = 2;
}
