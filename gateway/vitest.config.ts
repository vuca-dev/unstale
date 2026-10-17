import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The Worker runtime module is replaced by a stub; the rest runs on Node (node:sqlite stands in for the object's SQL).
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/workers-stub.ts", import.meta.url)) } },
});
