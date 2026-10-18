// The state snapshot's command line (snapshot.ts), over the store at UNSTALE_STORE and the remote at
// UNSTALE_STATE_REMOTE (`github:<owner>/<repo>#<release id>` with GH_TOKEN, or `dir:<path>`).
//
//   npm run state -- restore [--all]                 newest complete generation into an empty store (eager members;
//                                                    every member with --all); prints a JSON report
//   npm run state -- save --generation <state-...> [--keep 3] [--evict]
//                                                    --evict: then remove the lazy members it saved from the store
//   npm run state -- serve --socket <path>           restore docs stores on first use (client.ts) until killed
//   npm run state -- hydrate <key>                   restore one member now (`docs:<tech>`, `tech:<tech>`, `archive:<file>`)
//   npm run state -- caches pack|unpack              the store's caches into packs, or back to one file per entry (to
//                                                    run code from before packs on this store; pipeline/packs.ts)
//   npm run state -- stats [--top 20]                the local manifest by area and kind: members, files, bytes
import { join } from "node:path";
import { parseArgs } from "node:util";
import { expandCaches, migrateCaches } from "../pipeline/packs.ts";
import { storeRoot } from "../pipeline/paths.ts";
import { areaOfKey } from "./layout.ts";
import { remoteFromEnv } from "./remote.ts";
import { serve } from "./server.ts";
import { hydrate, localManifest, restore, save } from "./snapshot.ts";

const log = (s: string): void => console.error(`[state] ${s}`);

function count(flag: string, value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, not ${value}`);
  return n;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = storeRoot();
  switch (cmd) {
    case "restore": {
      const { values } = parseArgs({ args: rest, options: { all: { type: "boolean" } } });
      const r = await restore(root, remoteFromEnv(), { all: !!values.all, log });
      console.log(JSON.stringify(r));
      if (r.kind === "none") process.exitCode = 3;
      return;
    }
    case "save": {
      const { values } = parseArgs({ args: rest, options: { generation: { type: "string" }, keep: { type: "string" }, evict: { type: "boolean" } } });
      if (!values.generation || !/^state-[^.]+$/.test(values.generation)) throw new Error("save --generation state-<stamp>");
      const keep = count("--keep", values.keep, 3);
      if (keep < 1) throw new Error("save --keep must be at least 1");
      console.log(JSON.stringify(await save(root, remoteFromEnv(), { generation: values.generation, keep, log, evict: !!values.evict })));
      return;
    }
    case "serve": {
      const { values } = parseArgs({ args: rest, options: { socket: { type: "string" } } });
      if (!values.socket) throw new Error("serve --socket <path>");
      await serve(root, remoteFromEnv(), values.socket, log);
      log(`serving ${values.socket}`);
      return;
    }
    case "hydrate": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      for (const key of positionals) console.log(`${key}: ${await hydrate(root, remoteFromEnv(), key)}`);
      return;
    }
    case "caches": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const central = join(root, "central");
      if (positionals[0] === "pack") console.log(`moved ${migrateCaches(central)} cache files into packs`);
      else if (positionals[0] === "unpack") console.log(`wrote ${expandCaches(central)} cache files`);
      else throw new Error("caches pack|unpack");
      return;
    }
    case "stats": {
      const { values } = parseArgs({ args: rest, options: { top: { type: "string" } } });
      const m = localManifest(root);
      if (!m) throw new Error(`no manifest under ${root}`);
      const by = new Map<string, { kind: string; members: number; files: number; bytes: number; compressed: number }>();
      for (const [k, x] of Object.entries(m.members)) {
        const area = x.kind === "eager" ? areaOfKey(k) : k.startsWith("docs:") ? "central/docs/*/store" : k.startsWith("tech:") ? "tech:*" : "central/archive";
        const b = by.get(area) ?? { kind: x.kind, members: 0, files: 0, bytes: 0, compressed: 0 };
        b.members++;
        b.files += x.files;
        b.bytes += x.bytes;
        b.compressed += x.length;
        by.set(area, b);
      }
      const rows = [...by].sort(([, a], [, b]) => b.compressed - a.compressed).slice(0, count("--top", values.top, 1000));
      for (const [area, b] of rows) console.log(JSON.stringify({ area, ...b }));
      const segs = Object.values(m.segments);
      console.log(JSON.stringify({ generation: m.generation, members: Object.keys(m.members).length, segments: segs.length, segment_bytes: segs.reduce((a, b) => a + b, 0), largest_segment: Math.max(0, ...segs) }));
      return;
    }
    default:
      console.error("commands: restore [--all], save --generation <name> [--keep n] [--evict], serve --socket <path>, hydrate <key>, caches pack|unpack, stats");
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
