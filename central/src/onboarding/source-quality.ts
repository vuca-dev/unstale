import { locate } from "../pipeline/extract.ts";
import type { ReleaseNote } from "../pipeline/fetch.ts";
import { retract, loadStore, saveStore, type TechStore } from "../pipeline/store.ts";
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

/** Repair evidence from cached linked pages that formerly included other versions' sections. Other snapshots and
 * surviving independent evidence are preserved; a record supported only by out-of-section quotes is retracted. */
export function reconcileLinkedEvidence(t: Technology, notes: readonly ReleaseNote[], store = loadStore(t.id)): number {
  const corrected = new Map(notes.filter((n) => n.supersededSnapshot).map((n) => [`${n.url}\n${n.supersededSnapshot}`, n]));
  if (!corrected.size) return 0;
  let changed = 0;
  for (const record of Object.values(store.records)) {
    if (record.status !== "active") continue;
    const evidence = record.evidence.filter((e) => {
      if ((e.kind ?? "release_notes") !== "release_notes") return true;
      const note = corrected.get(`${e.url}\n${e.snapshot}`);
      return !note || locate(note.notes, e.quote).grounded;
    });
    if (evidence.length === record.evidence.length) continue;
    if (evidence.length) {
      record.evidence = evidence;
      record.revision++;
      record.history.push({ action: "linked-release-section", detail: "removed quotes from other release sections", revision: record.revision, label_version: record.label_version });
    } else {
      retract(store, record.id, "linked release page: quote belongs outside this release section");
      for (const [key, id] of Object.entries(store.ingested)) if (id === record.id) delete store.ingested[key];
    }
    changed++;
  }
  if (changed) saveStore(store);
  return changed;
}
