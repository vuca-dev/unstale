// Build into a temporary directory so previewing never changes the exported catalog.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = resolve(process.argv[2] ?? join(root, ".store/catalog"));
const site = mkdtempSync(join(tmpdir(), "unstale-site-"));
symlinkSync(join(catalog, "v1"), join(site, "v1"), "dir");
const count = build(site);
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".json": "application/json", ".txt": "text/plain; charset=utf-8",
};
const server = createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    let file = resolve(site, `.${pathname}`);
    if (file !== site && !file.startsWith(site + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
const port = Number(process.env.PORT ?? 4174);
server.listen(port, "127.0.0.1", () => {
  console.log(`Preview: http://127.0.0.1:${port} (${count} packages)`);
  console.log("Stop and rerun after editing the site sources.");
});
