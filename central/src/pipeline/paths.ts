// Where the central pipeline keeps its state, caches and the published catalog (CONTRACT: Paths).
// `UNSTALE_STORE` overrides the root (tests use temp dirs).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const storeRoot = (): string => process.env.UNSTALE_STORE ?? join(REPO_ROOT, ".store");
// `UNSTALE_CENTRAL_DIR` and `UNSTALE_CATALOG_DIR` override each directory alone (a rebuild into a side store).
export const centralDir = (): string => process.env.UNSTALE_CENTRAL_DIR ?? join(storeRoot(), "central");
export const catalogDir = (): string => process.env.UNSTALE_CATALOG_DIR ?? join(storeRoot(), "catalog");
export const usageLog = (): string => join(centralDir(), "usage.jsonl");
