import { loadStore, saveStore, type TechStore } from "../pipeline/store.ts";
import type { Technology } from "../pipeline/technologies.ts";
import { isChangelogName } from "../pipeline/changelog.ts";
/** Never attribute another monorepo component's release to this technology. Also repairs cached early runs. */
export function reconcileSources(
  t: Technology,
  store: TechStore = loadStore(t.id),
): number {
  let removed = 0;
  for (const record of Object.values(store.records)) {
    if (record.status !== "active") continue;
    const valid = record.evidence.filter((e) => {
      if (e.kind !== "release_notes") return true;
      try {
        const url = new URL(e.url);
        const prefix = `/${t.repo}/releases/tag/`;
        if (url.hostname !== "github.com") return false;
        // A section of the repository's changelog file (fetch.ts, a package with no GitHub release): the file is the
        // package's own or the repository root's, never another component's release.
        if (url.pathname.startsWith(`/${t.repo}/blob/`))
          return isChangelogName(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""));
        return (
          url.pathname.startsWith(prefix) &&
          t.tag.test(decodeURIComponent(url.pathname.slice(prefix.length)))
        );
      } catch {
        return false;
      }
    });
    if (valid.length === record.evidence.length) continue;
    const versions = new Set(
      valid.flatMap((e) => {
        try {
          const tag = decodeURIComponent(
            new URL(e.url).pathname.split("/releases/tag/")[1] ?? "",
          );
          return t.tag.exec(tag)?.[1] ?? [];
        } catch {
          return [];
        }
      }),
    );
    record.evidence = valid;
    if (!valid.length) {
      record.status = "retracted";
      record.stub_line = record.releases.at(-1)?.line ?? "0";
      for (const [key, id] of Object.entries(store.ingested))
        if (id === record.id) delete store.ingested[key];
    } else if (versions.size)
      record.releases = record.releases.filter((r) => versions.has(r.version));
    record.revision++;
    record.history.push({
      action: "source-identity-correction",
      revision: record.revision,
      label_version: record.label_version,
    });
    removed++;
  }
  if (removed) saveStore(store);
  return removed;
}
