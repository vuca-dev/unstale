// Guard before a deploy (ingest.yml): the exported tree's root parses, every index entry has its shard with the size
// and sha256 the index states, and the root and every index verify against the public key release clients carry
// (UNSTALE_CATALOG_KEY; a client verifies the same).
//   node .github/scripts/verify-catalog.mjs <site>
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2];
if (!site) throw new Error("usage: verify-catalog.mjs <site>");
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(process.env.UNSTALE_CATALOG_KEY ?? "", "hex").toString("base64url") }, format: "jwk" });
const signed = (rel) => {
  const sig = Buffer.from(readFileSync(join(site, `${rel}.sig`), "utf8").trim(), "hex");
  if (!verify(null, readFileSync(join(site, rel)), key, sig)) throw new Error(`${rel}: signature does not verify against UNSTALE_CATALOG_KEY`);
};
signed("v1/root.json");
const root = JSON.parse(readFileSync(join(site, "v1", "root.json"), "utf8"));
if (typeof root.schema !== "number") throw new Error("v1/root.json has no schema");
const techs = readdirSync(join(site, "v1", "tech")).filter((f) => f.endsWith(".json"));
if (!techs.length) throw new Error("no technology indexes");
let shards = 0;
for (const f of techs) {
  signed(`v1/tech/${f}`);
  const index = JSON.parse(readFileSync(join(site, "v1", "tech", f), "utf8"));
  for (const s of index.shards ?? []) {
    const bytes = readFileSync(join(site, s.path));
    if (bytes.length !== s.bytes) throw new Error(`${s.path}: ${bytes.length} bytes, index says ${s.bytes}`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (sha !== s.sha256) throw new Error(`${s.path}: sha256 ${sha}, index says ${s.sha256}`);
    shards++;
  }
}
console.log(`${techs.length} technologies, ${shards} shards verified, root and indexes signed`);
