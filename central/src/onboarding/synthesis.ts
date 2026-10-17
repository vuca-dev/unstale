import {
  interpret,
  labelQuestions,
  recordState,
} from "../pipeline/classify/labels.ts";
import { extractRelease, type DocsNote } from "../pipeline/extract.ts";
import type { ReleaseNote } from "../pipeline/fetch.ts";
import { ingest } from "../pipeline/match.ts";
import { makeClassifier } from "../pipeline/pipeline.ts";
import { checkIncoming } from "../pipeline/prereqs.ts";
import { loadStore, saveStore, applyChange } from "../pipeline/store.ts";
import { publishTechnology } from "../pipeline/publish.ts";
import { catalogDir } from "../pipeline/paths.ts";
import { withTechLock } from "../pipeline/lock.ts";
import type { Technology } from "../pipeline/technologies.ts";
const classifier = makeClassifier();
export async function synthesize(
  t: Technology,
  note: ReleaseNote | DocsNote,
): Promise<number> {
  const extracted = await extractRelease(t, note);
  if (extracted.failed)
    throw new Error(
      `Source analysis incomplete (${extracted.failed} failed calls); retry scheduled`,
    );
  // From loading the store to publishing it, the only writer of this technology (lock.ts).
  return withTechLock(t.id, "onboarding", async () => {
    const store = loadStore(t.id);
    for (const inc of extracted.incoming.filter((i) => i.grounded)) {
      const existing = store.records[store.ingested[inc.key] ?? ""];
      if (
        existing &&
        inc.conditions.some((c) => !existing.conditions.includes(c))
      ) {
        applyChange(
          existing,
          {
            conditions: [...new Set([...existing.conditions, ...inc.conditions])],
          },
          "source-metadata-refresh",
        );
      }
    }
    saveStore(store);
    const incoming = extracted.incoming.filter(
      (i) => i.grounded && !store.ingested[i.key],
    );
    await checkIncoming(incoming);
    for (const inc of incoming) {
      const labels = interpret(
        await classifier.classify(recordState(t.name, inc), labelQuestions()),
      );
      await ingest(store, t.name, t.components, inc, labels, (state, questions) =>
        classifier.classify(state, questions),
      );
      saveStore(store);
    }
    publishTechnology(store, new Date().toISOString(), catalogDir());
    return Object.values(store.records).filter((r) => r.status === "active")
      .length;
  });
}
