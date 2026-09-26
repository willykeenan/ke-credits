/** Driver-agnostic SQL surface. Plug in `pg`, postgres.js, PGlite, or Neon. */
export interface Sql {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
