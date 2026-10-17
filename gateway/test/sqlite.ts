// A Durable Object's `ctx.storage.sql` over node:sqlite: statements that return rows are read, the rest are run.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Sql } from "../src/queue.ts";

export function memorySql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const args = bindings as SQLInputValue[];
      const rows = /^\s*select|returning/i.test(query) ? (stmt.all(...args) as Record<string, unknown>[]) : (stmt.run(...args), []);
      return { toArray: () => rows };
    },
  };
}
