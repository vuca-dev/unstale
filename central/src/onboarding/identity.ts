// Public package identities (npm, PyPI) and the technology id derived from one. Free of Node-only modules except
// node:crypto, so the gateway (a Worker with nodejs_compat) validates and names packages exactly as central does.
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function npmIdentity(purl: string): string {
  if (
    !/^pkg:npm\/(?:%40[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(purl) ||
    purl.length > 230
  )
    throw new Error(
      "Expected a canonical public npm package URL, without version or qualifiers",
    );
  return purl.slice(8).replace("%40", "@");
}
/** A PEP 503-normalised PyPI name from a canonical `pkg:pypi/<name>` URL. */
export function pypiIdentity(purl: string): string {
  if (!/^pkg:pypi\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(purl) || purl.length > 230)
    throw new Error("Expected a canonical public PyPI package URL (PEP 503 normalised), without version or qualifiers");
  return purl.slice(9);
}
export const CARGO_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A crates.io crate name, spelled as the registry and Cargo.lock record it: crates.io keeps a name's case
 * (`Inflector`), so the exact spelling is the identity (discovery checks it against the registry's `crate.id`). */
export function cargoIdentity(purl: string): string {
  const name = purl.startsWith("pkg:cargo/") ? purl.slice(10) : "";
  if (!CARGO_NAME.test(name))
    throw new Error("Expected a canonical public Cargo package URL, without version or qualifiers");
  return name;
}
export function cargoPurl(name: string): string {
  const purl = `pkg:cargo/${name}`;
  cargoIdentity(purl);
  return purl;
}
/** The package name of a public identity in an ecosystem this service registers (npm, PyPI, Cargo). */
export function packageIdentity(purl: string): string {
  if (purl.startsWith("pkg:pypi/")) return pypiIdentity(purl);
  if (purl.startsWith("pkg:cargo/")) return cargoIdentity(purl);
  return npmIdentity(purl);
}
export function technologyId(purl: string): string {
  const name = packageIdentity(purl);
  return (
    name.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9.-]/g, "-") +
    "-" +
    sha256(purl).slice(0, 8)
  );
}
