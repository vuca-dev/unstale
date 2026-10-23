// Public identity -> verified registry metadata -> official sources. No repository context enters here.
import { HttpClient } from "../collector/http.ts";
import { TECHNOLOGIES, type Technology } from "../pipeline/technologies.ts";
import { isRepoSlug } from "../pipeline/util.ts";

export interface PublicTechnology {
  discovery_version?: number;
  purl: string;
  id: string;
  name: string;
  latest: string;
  repo?: string;
  directory?: string;
  homepage?: string;
  tag: string;
  components: string[];
}
export { npmIdentity, pypiIdentity, packageIdentity, technologyId } from "./identity.ts";
import { npmIdentity, packageIdentity, pypiIdentity, technologyId } from "./identity.ts";
export const DISCOVERY_VERSION = 2;
export function releasePattern(
  purl: string,
  repo?: string,
  directory?: string,
): string {
  const known = Object.values(TECHNOLOGIES).find((t) =>
    t.components.includes(purl),
  );
  if (known) return known.tag.source;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (purl.startsWith("pkg:pypi/")) {
    // Python projects tag `v1.2`, `1.2.3`, `name-1.2.3`, `name_1.2.3` (Azure) or `name==1.2.3` (LangChain); PyPI names may be written with `_` or `.`.
    const name = pypiIdentity(purl).split("-").map(escape).join("[-_.]");
    return `^(?:v|${name}(?:[-_]v?|==|@|\\s+v?))?(\\d+\\.\\d+(?:\\.\\d+)?)$`;
  }
  const name = npmIdentity(purl),
    leaf = name.split("/").at(-1)!;
  const prefixOnly = !!directory && repo?.split("/").at(-1) !== leaf;
  // `name@1.2.3`, `leaf@1.2.3`, `leaf-v1.2.3` (release-please monorepos: puppeteer-v25.14.0 beside
  // puppeteer-core-v25.14.0) and, unless the package is one of several in its repository, `v1.2.3`.
  return `^(?:${escape(name)}@|${escape(leaf)}@|${escape(leaf)}-v?${prefixOnly ? "" : "|v?"})(\\d+\\.\\d+\\.\\d+)$`;
}
const http = new HttpClient();
export async function json(url: string): Promise<any> {
  const r = await http.get(url, {
    accept: "application/json",
    "user-agent": "unstale-central",
  });
  return JSON.parse(Buffer.from(r.body).toString("utf8"));
}
/** The repository, homepage and latest stable version from PyPI's JSON API (`info.project_urls`, `home_page`). */
async function discoverPypi(purl: string): Promise<PublicTechnology> {
  const name = pypiIdentity(purl);
  const info = (await json(`https://pypi.org/pypi/${name}/json`))?.info ?? {};
  const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
  if (typeof info.name !== "string" || norm(info.name) !== name)
    throw new Error("Public registry identity could not be verified");
  const latest: string = info.version ?? "";
  if (!/^\d+(?:\.\d+)+$/.test(latest)) throw new Error("No stable public version found");
  const urls: Record<string, string> = info.project_urls ?? {};
  const source =
    Object.entries(urls).find(([k]) => /source|code|repo|github/i.test(k))?.[1] ??
    [...Object.values(urls), info.home_page ?? ""].find((v) => /github\.com\//.test(v)) ??
    "";
  const m = [/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(source)].find((x) => x && isRepoSlug(x[1]!));
  const docs = Object.entries(urls).find(([k]) => /doc/i.test(k))?.[1];
  const home = docs ?? urls.Homepage ?? urls.homepage ?? info.home_page;
  const t: PublicTechnology = {
    discovery_version: DISCOVERY_VERSION,
    purl,
    id: technologyId(purl),
    name: info.name,
    latest,
    tag: releasePattern(purl, m?.[1]),
    components: [purl],
  };
  if (m) t.repo = m[1]!;
  if (typeof home === "string" && /^https:\/\//.test(home)) t.homepage = home;
  else if (m) t.homepage = `https://github.com/${m[1]}`;
  return t;
}
export async function discoverTechnology(
  purl: string,
): Promise<PublicTechnology> {
  if (purl.startsWith("pkg:pypi/")) return discoverPypi(purl);
  const name = npmIdentity(purl);
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  let meta = await json(registryUrl + "/latest");
  if (meta.version) {
    const version = meta;
    if (!version.repository) {
      try {
        meta = await json(registryUrl);
      } catch {
        /* retain verified latest metadata */
      }
    }
    if (!meta["dist-tags"])
      meta = {
        ...version,
        "dist-tags": { latest: version.version },
        versions: { [version.version]: version },
      };
  }
  if (meta.name !== name || meta.private)
    throw new Error("Public registry identity could not be verified");
  const latest: string = meta["dist-tags"]?.latest ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(latest))
    throw new Error("No stable public version found");
  const version = meta.versions?.[latest] ?? {};
  const repository = version.repository ?? meta.repository;
  const readmeRepo =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:\/|[)#\s]|$)/.exec(
      meta.readme ?? "",
    )?.[1];
  const repoUrl =
    (typeof repository === "string" ? repository : repository?.url) ??
    (readmeRepo ? `https://github.com/${readmeRepo}` : "");
  const m = [/(?:github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(repoUrl)].find((x) => x && isRepoSlug(x[1]!));
  const known = Object.values(TECHNOLOGIES).find((t) =>
    t.components.includes(purl),
  );
  const t: PublicTechnology = {
    discovery_version: DISCOVERY_VERSION,
    purl,
    id: known?.id ?? technologyId(purl),
    name: known?.name ?? name,
    latest,
    tag: releasePattern(purl, m?.[1], repository?.directory),
    components: known?.components ?? [purl],
  };
  if (m) t.repo = m[1]!;
  if (repository?.directory) t.directory = repository.directory;
  const home = version.homepage ?? meta.homepage;
  if (typeof home === "string" && /^https:\/\//.test(home)) t.homepage = home;
  else if (readmeRepo) t.homepage = `https://github.com/${readmeRepo}`;
  return t;
}
export function pipelineTechnology(t: PublicTechnology): Technology {
  return {
    id: t.id,
    name: t.name,
    repo: t.repo ?? "",
    ...(t.directory ? { directory: t.directory } : {}),
    ...(t.homepage ? { homepage: t.homepage } : {}),
    components: t.components,
    tag: new RegExp(t.tag),
    clean: (body) => body.replace(/\n#+\s*Credits[\s\S]*$/, ""),
  };
}
