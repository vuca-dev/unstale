// A Durable Object's `ctx.storage.sql` over node:sqlite. node:sqlite has no row counters, so each cursor carries an
// estimate of what a Durable Object bills (index rows included):
// - rows read: a statement whose plan scans a table (or an index over it) reads every row of it; one that only
//   searches by key reads the rows it returns, at least one; schema statements read none;
// - rows written: each row inserted or deleted writes the table row and one row per index (a TEXT PRIMARY KEY on a
//   rowid table is such an index; a WITHOUT ROWID table's key is the table itself); each row updated writes one
//   (no statement here changes an indexed column).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Sql } from "../src/queue.ts";

export function memorySql(): Sql & { db: DatabaseSync; rowsRead: number; rowsWritten: number; transaction<T>(f: () => T): T } {
  const db = new DatabaseSync(":memory:");
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const indexes = (table: string) => {
    const withoutRowid = /without\s+rowid/i.test(String((db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql?: string } | undefined)?.sql ?? ""));
    const list = db.prepare(`PRAGMA index_list(${table})`).all() as { origin: string }[];
    return list.filter((i) => !(withoutRowid && i.origin === "pk")).length;
  };
  const sql = {
    db,
    rowsRead: 0,
    rowsWritten: 0,
    exec(query: string, ...bindings: unknown[]) {
      const args = bindings as SQLInputValue[];
      const ddl = /^\s*(create|drop|alter)/i.test(query);
      const target = /^\s*(?:insert\s+into|update|delete\s+from)\s+(\w+)/i.exec(query)?.[1];
      const plan = ddl ? [] : (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as { detail: string }[]);
      const scanned = plan.flatMap(({ detail }) => /^SCAN (\w+)/.exec(detail)?.[1] ?? []);
      const before = target ? count(target) : 0;
      const stmt = db.prepare(query);
      const rows = /^\s*select|returning/i.test(query) ? (stmt.all(...args) as Record<string, unknown>[]) : (stmt.run(...args), []);
      let written = 0;
      if (target) {
        const changes = Number((db.prepare("SELECT changes() AS n").get() as { n: number }).n);
        const delta = count(target) - before;
        written = Math.abs(delta) * (1 + indexes(target)) + Math.max(0, changes - Math.abs(delta));
      }
      const read = ddl ? 0 : scanned.length ? scanned.reduce((n, table) => n + count(table), 0) : Math.max(1, rows.length);
      sql.rowsRead += read;
      sql.rowsWritten += written;
      return { toArray: () => rows, rowsRead: read, rowsWritten: written };
    },
    /** As `ctx.storage.transactionSync`: all or nothing. */
    transaction<T>(f: () => T): T {
      db.exec("SAVEPOINT tx");
      try {
        const out = f();
        db.exec("RELEASE tx");
        return out;
      } catch (e) {
        db.exec("ROLLBACK TO tx");
        db.exec("RELEASE tx");
        throw e;
      }
    },
  };
  return sql;
}
