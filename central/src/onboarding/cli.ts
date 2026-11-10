import { CoverageService, createCoverageServer } from "./service.ts";
import { writeRoot } from "../pipeline/publish.ts";
import { catalogDir } from "../pipeline/paths.ts";
const port = Number(process.env.UNSTALE_PORT ?? "47831");
// 0.0.0.0 in a container; the default keeps a developer's service off the network.
const host = process.env.UNSTALE_HOST ?? "127.0.0.1";
writeRoot(catalogDir());
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
