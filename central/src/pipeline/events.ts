// Change events: the deterministic inputs of the model steps, published beside the records so a client can run those
// steps itself. One event per source document of a release (its release notes, an upgrade guide, a docs change), its
// text split by `chunk` (extract.ts) exactly as extraction reads it, each chunk with a stable id and a content hash.
// No model call anywhere here.
//
// Recorded whenever central reads sources (`recordNotes`, from the pipeline and the coverage service), kept per
// technology under `central/events/<tech>/` (a lazy state member, as its releases are):
//   notes.json      every event as it will be published, with when central first read it. Release notes are replaced
//                   by each read of the release list (it is always the whole list in the window); upgrade guides and
//                   docs changes accumulate (each read names only what it found then).
//   published.json  when each event first went into a published index, and a digest of the events last published
//                   (written by `publishEvents`, under the technology lock with the rest of a publish).
//   processed.json  the events central ran its model steps on, each with a digest of the chunks it read
//                   (`markProcessed`, written after the records it made are saved in the store): published as
//                   `extracted` while the event's chunks are still those, so a client never re-derives them.
// Both are written under the technology lock (`recordNotesLocked` for a read, a publish holds it already).
// Published by `publishEvents` as one gzipped JSON-lines shard per release line, `v1/shards/<tech>/<line>.events.<16
// hex>.jsonl.gz`, named by content hash like the record shards and listed in the index's `events`; the same store in
// gives the same bytes out, so a rerun or a no-op republish writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { EventLine, type EventChunk, type ShardRef } from "../schema/catalog.ts";
import { techLocal } from "../state/client.ts";
import { chunk, contentFree, type DocsNote } from "./extract.ts";
import { cachedPublishTimes, type GuideNote, type ReleaseNote } from "./fetch.ts";
import { withTechLock } from "./lock.ts";
import { centralDir } from "./paths.ts";
import type { Technology } from "./technologies.ts";
import { canonical, compareVersions, readJson, releaseLine, sha256, writeAtomic } from "./util.ts";

/** Where a note was read: the release list (replaced whole by each read), upgrade guides or docs changes (kept). */
export type EventSource = "releases" | "guides" | "docs";

/** An event as recorded: the published line without `first_published`, and where it was read. */
export interface StoredEvent extends Omit<EventLine, "freshness" | "extracted"> {
  source: EventSource;
  freshness: Omit<EventLine["freshness"], "first_published">;
}

interface NotesFile {
  schema: 1;
  technology: string;
  /** When each source was first recorded for this technology: events recorded then are `backfilled`. */
  started: Partial<Record<EventSource, string>>;
  events: Record<string, StoredEvent>;
}

interface PublishedFile {
  schema: 1;
  technology: string;
  first_published: Record<string, string>;
  /** sha256 of the recorded events the last publish wrote (`eventsDigest`). */
  digest?: string;
}

interface ProcessedFile {
  schema: 1;
  technology: string;
  /** Event id → `chunksDigest` of the chunks central's model steps read. */
  events: Record<string, string>;
}

/** A digest of an event's chunks: what its model steps read. */
const chunksDigest = (chunks: readonly Pick<EventChunk, "sha256">[]): string => sha256(chunks.map((c) => c.sha256).join("\n"));

/** The recorded events central has processed as they stand: their marks still name their current chunks. */
function processedIds(tech: string, events: Record<string, StoredEvent>): string[] {
  const done = readJson<ProcessedFile>(processedPath(tech))?.events ?? {};
  return Object.keys(events)
    .filter((id) => done[id] !== undefined && done[id] === chunksDigest(events[id]!.chunks))
    .sort();
}

/** A digest of the recorded events and of which of them are processed: changes with any event's text or metadata,
 * and with each new mark. Events no publish has marked keep the digest they had before marks existed. */
const eventsDigest = (events: Record<string, StoredEvent>, processed: readonly string[]): string =>
  sha256(canonical(processed.length ? { events, processed } : events));

const dir = (tech: string): string => join(centralDir(), "events", techLocal(tech));
const notesPath = (tech: string): string => join(dir(tech), "notes.json");
const publishedPath = (tech: string): string => join(dir(tech), "published.json");
const processedPath = (tech: string): string => join(dir(tech), "processed.json");

/** The event file name part of a shard: `<line>.events.<16 hex>.jsonl.gz` (prune.ts `SHARD_FILE` matches it too). */
export const EVENTS_FILE = /^[a-zA-Z0-9._-]+\.events\.[0-9a-f]{16}\.jsonl\.gz$/;

/** A note's event id: the key prefix extraction gives its records (`{tech}@{version}{keyTag}`, extract.ts). */
export const eventId = (tech: string, note: Pick<ReleaseNote, "version" | "keyTag">): string => `${tech}@${note.version}${note.keyTag ?? ""}`;

/** A note's text as chunks: `chunk(notes)` in order, each `{id}#{index}` with the sha256 of its text, marked when
 * extraction would make no call for it (empty or `contentFree`). */
export function eventChunks(id: string, notes: string): EventChunk[] {
  return chunk(notes).map((text, i) => ({ id: `${id}#${i}`, sha256: sha256(text), text, ...(!text.trim() || contentFree(text) ? { content_free: true } : {}) }));
}

type Note = ReleaseNote | GuideNote | DocsNote;

/** The event of one note, before its timestamps. */
export function eventOf(t: Pick<Technology, "id" | "name">, note: Note): Omit<StoredEvent, "source" | "freshness"> {
  const id = eventId(t.id, note);
  const kind = "kind" in note && note.kind ? note.kind : "release_notes";
  return {
    id,
    technology: t.id,
    name: t.name,
    kind,
    version: note.version,
    line: releaseLine(note.version),
    date: note.date,
    ...(note.noteDate && note.noteDate !== note.date ? { prompt_date: note.noteDate } : {}),
    ...(note.noLaterThan ? { no_later_than: note.noLaterThan } : {}),
    url: note.url,
    snapshot: note.snapshot,
    chunks: eventChunks(id, note.notes),
  };
}

function readNotes(tech: string): NotesFile {
  return readJson<NotesFile>(notesPath(tech)) ?? { schema: 1, technology: tech, started: {}, events: {} };
}

/**
 * Records the notes central has just read from `source` for technology `t`. An event keeps the time it was first
 * recorded (and its registry publish time once known); its text and metadata follow the latest read. Notes with an id
 * already taken in this read are left out, as extraction keeps the first record of a key. Synchronous: within one
 * process no other write to the file can come between its read and its write. Returns the events recorded.
 */
export function recordNotes(t: Pick<Technology, "id" | "name" | "components">, source: EventSource, notes: readonly Note[], now = new Date()): number {
  const file = readNotes(t.id);
  const at = now.toISOString();
  const first = !file.started[source];
  if (first) file.started[source] = at;
  const times = cachedPublishTimes(t, [...new Set(notes.map((n) => n.version))]);
  const seen = new Set<string>();
  for (const note of notes) {
    const e = eventOf(t, note);
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const old = file.events[e.id];
    const registry = times.get(note.version) ?? old?.freshness.registry_published;
    file.events[e.id] = {
      ...e,
      source: old?.source ?? source,
      freshness: {
        ...(registry ? { registry_published: registry } : {}),
        first_seen: old?.freshness.first_seen ?? at,
        ...((old ? old.freshness.backfilled : first && source !== "docs") ? { backfilled: true } : {}),
      },
    };
  }
  // The release list is read whole: a release no longer in it (out of the window, another package's) leaves.
  if (source === "releases") for (const [id, e] of Object.entries(file.events)) if (e.source === "releases" && !seen.has(id)) delete file.events[id];
  const text = JSON.stringify(JSON.parse(canonical(file)), null, 1) + "\n";
  const path = notesPath(t.id);
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeAtomic(path, text);
  return seen.size;
}

/** `recordNotes` under the technology lock, so no other process's publish or read of the technology comes between
 * its read and its write (re-entrant: a caller holding the lock keeps it). */
export function recordNotesLocked(t: Pick<Technology, "id" | "name" | "components">, source: EventSource, notes: readonly Note[]): Promise<number> {
  return withTechLock(t.id, "events", async () => recordNotes(t, source, notes));
}

/**
 * Marks the events of these notes as processed: central's model steps ran on each, on its text as it stands now, and
 * the records they made are saved in the technology's store. Call it under the technology lock, after the store is
 * saved and before the publish that carries those records, so an event is never published as processed ahead of its
 * records. No model call; a mark already there is kept.
 */
export function markProcessed(t: Pick<Technology, "id">, notes: readonly Note[]): number {
  const marks = new Map<string, string>();
  for (const note of notes) {
    const id = eventId(t.id, note);
    marks.set(id, chunksDigest(eventChunks(id, note.notes)));
  }
  return writeMarks(t.id, marks);
}

/**
 * Marks recorded events as processed by id, with the chunks each holds now: for work central did before marks existed
 * (release notes a coverage job completed, docs events its ledger lists), told apart by `pick`. Same rules as
 * `markProcessed`.
 */
export function markRecorded(tech: string, pick: (e: StoredEvent) => boolean): number {
  const events = readJson<NotesFile>(notesPath(tech))?.events ?? {};
  const marks = new Map<string, string>();
  for (const e of Object.values(events)) if (pick(e)) marks.set(e.id, chunksDigest(e.chunks));
  return writeMarks(tech, marks);
}

function writeMarks(tech: string, marks: ReadonlyMap<string, string>): number {
  const file = readJson<ProcessedFile>(processedPath(tech)) ?? { schema: 1, technology: tech, events: {} };
  let n = 0;
  for (const [id, digest] of marks) {
    if (file.events[id] === digest) continue;
    file.events[id] = digest;
    n++;
  }
  if (n) writeAtomic(processedPath(tech), JSON.stringify(JSON.parse(canonical(file)), null, 1) + "\n");
  return n;
}

/** Whether the recorded events differ from what the last publish wrote (a new event, one whose text or metadata
 * changed, or a new mark): a publish is due. */
export function eventsChanged(tech: string): boolean {
  const events = readJson<NotesFile>(notesPath(tech))?.events ?? {};
  if (!Object.keys(events).length) return false;
  return readJson<PublishedFile>(publishedPath(tech))?.digest !== eventsDigest(events, processedIds(tech, events));
}

export interface PublishedEvents {
  refs: ShardRef[];
  bytes: number;
  written: number;
}

/**
 * Writes the technology's event shards into `outDir` and returns their references for its index. Every line is
 * validated by the generated Zod before anything is written. An event's `first_published` is stamped the first time
 * it is published here and kept after, so republishing the same events gives the same bytes. Call it under the
 * technology lock, with the publish (publish.ts).
 */
export function publishEvents(tech: string, outDir: string, now = new Date()): PublishedEvents {
  const recorded = readJson<NotesFile>(notesPath(tech))?.events ?? {};
  const events = Object.values(recorded);
  const out: PublishedEvents = { refs: [], bytes: 0, written: 0 };
  if (!events.length) return out;
  const pub: PublishedFile = readJson<PublishedFile>(publishedPath(tech)) ?? { schema: 1, technology: tech, first_published: {} };
  const at = now.toISOString();
  const byLine = new Map<string, string[]>();
  const processed = processedIds(tech, recorded);
  const marked = new Set(processed);
  const digest = eventsDigest(recorded, processed);
  let stamped = pub.digest !== digest;
  pub.digest = digest;
  for (const e of events.sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    if (!pub.first_published[e.id]) {
      pub.first_published[e.id] = at;
      stamped = true;
    }
    const { source: _source, ...rest } = e;
    const line = canonical(
      EventLine.parse({ ...rest, freshness: { ...e.freshness, first_published: pub.first_published[e.id]! }, ...(marked.has(e.id) ? { extracted: true } : {}) }),
    );
    byLine.set(e.line, [...(byLine.get(e.line) ?? []), line]);
  }
  const shards: Array<{ file: string; gz: Buffer }> = [];
  for (const line of [...byLine.keys()].sort(compareVersions)) {
    const lines = byLine.get(line)!;
    const gz = gzipSync(Buffer.from(lines.join("\n") + "\n"), { level: 9 });
    const digest = sha256(gz);
    const path = `v1/shards/${tech}/${line}.events.${digest.slice(0, 16)}.jsonl.gz`;
    shards.push({ file: join(outDir, path), gz });
    out.refs.push({ line, path, sha256: digest, bytes: gz.length, records: lines.length });
    out.bytes += gz.length;
  }
  for (const s of shards) {
    // Immutable: an existing file with this name already has these bytes.
    if (!existsSync(s.file)) {
      writeAtomic(s.file, s.gz);
      out.written++;
    }
  }
  // Ids no longer recorded keep their stamp: a release that comes back is not new.
  if (stamped) writeAtomic(publishedPath(tech), JSON.stringify(JSON.parse(canonical(pub)), null, 1) + "\n");
  return out;
}
