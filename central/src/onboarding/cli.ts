import { CoverageService, createCoverageServer } from "./service.ts";
import { writeAtomic } from "../pipeline/util.ts";
import { catalogDir } from "../pipeline/paths.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
const port = Number(process.env.UNSTALE_PORT ?? "47831");
// 0.0.0.0 in a container; the default keeps a developer's service off the network.
const host = process.env.UNSTALE_HOST ?? "127.0.0.1";
if (!existsSync(join(catalogDir(), "v1/root.json")))
  writeAtomic(
    join(catalogDir(), "v1/root.json"),
    JSON.stringify({ schema: 1, min_client: "0.1.0" }),
  );
const service = new CoverageService(),
  server = createCoverageServer(service);
server.on("error", (error) => {
  service.stop();
  console.error(String(error));
  process.exit(1);
});
server.listen(port, host, () => {
  service.start();
  console.log(
    `unstale central ready: http://${host}:${port}\nShared public technology jobs; no repository context accepted.`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    service.stop();
    server.close(() => process.exit(0));
  });
