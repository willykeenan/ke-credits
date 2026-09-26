import { PGlite } from "@electric-sql/pglite";
import type { Db, Sql } from "../src/db.ts";

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function wrapClient(client: {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Sql {
  return {
    async query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await client.query(text, params ?? []);
      return { rows: result.rows as T[] };
    },
  };
}

export async function pgliteDb(): Promise<Db> {
  const pg = new PGlite();
  const mutex = new Mutex();
  const root = wrapClient(pg);
  return {
    query: (text, params) => mutex.run(() => root.query(text, params)),
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return mutex.run(async () => {
        if (typeof pg.transaction === "function") {
          return pg.transaction(async (tx) => fn(wrapClient(tx)));
        }
        await pg.query("BEGIN");
        try {
          const result = await fn(wrapClient(pg));
          await pg.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await pg.query("ROLLBACK");
          } catch {
            // connection is aborted
          }
          throw error;
        }
      });
    },
  };
}
