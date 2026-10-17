// A Durable Object's `ctx.storage.sql` over node:sqlite: statements that return rows are read, the rest are run.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Sql } from "../src/queue.ts";

export function memorySql(): Sql & { db: DatabaseSync; rowsRead: number } {
  const db = new DatabaseSync(":memory:");
  const sql = {
    db,
    /** Rows the statements visited, as a Durable Object bills them: a statement whose plan scans a table (or an index
     * over it) reads every row of it; one that only searches by key reads the rows it returns, at least one. */
    rowsRead: 0,
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const args = bindings as SQLInputValue[];
      const plan = /^\s*create/i.test(query) ? [] : (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as { detail: string }[]);
      const scanned = plan.flatMap(({ detail }) => /^SCAN (\w+)/.exec(detail)?.[1] ?? []);
      const rows = /^\s*select|returning/i.test(query) ? (stmt.all(...args) as Record<string, unknown>[]) : (stmt.run(...args), []);
      sql.rowsRead += scanned.length
        ? scanned.reduce((n, table) => n + Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n), 0)
        : Math.max(1, rows.length);
      return { toArray: () => rows };
    },
  };
  return sql;
}
