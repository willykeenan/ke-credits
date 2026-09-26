import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MigrationDrift } from "../src/errors.ts";
import { Ledger } from "../src/ledger.ts";
import { MIGRATIONS, migrate, splitSqlStatements } from "../src/schema.ts";
import { pgliteDb } from "./helpers.ts";

const sqlDir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");

async function setup() {
  const db = await pgliteDb();
  const first = await migrate(db);
  return { db, first };
}

test("shipped sql/*.sql files match MIGRATIONS", () => {
  assert.ok(MIGRATIONS.length >= 4);
  for (const migration of MIGRATIONS) {
    const onDisk = readFileSync(join(sqlDir, `${migration.id}.sql`), "utf8");
    assert.equal(onDisk, migration.sql, migration.id);
  }
});

test("migrate is idempotent", async () => {
  const { db, first } = await setup();
  assert.deepEqual(
    first.applied,
    MIGRATIONS.map((m) => m.id),
  );
  const second = await migrate(db);
  assert.deepEqual(second.applied, []);
  const third = await migrate(db);
  assert.deepEqual(third.applied, []);
});

test("migrate refuses when an applied checksum drifted", async () => {
  const { db } = await setup();
  await db.query(
    "UPDATE credits_schema_migrations SET checksum = $1 WHERE id = $2",
    ["deadbeef", MIGRATIONS[0].id],
  );
  await assert.rejects(() => migrate(db), (err: unknown) => {
    assert.ok(err instanceof MigrationDrift);
    assert.equal((err as MigrationDrift).id, MIGRATIONS[0].id);
    return true;
  });
});

test("ledger entries refuse UPDATE and DELETE at the database", async () => {
  const { db } = await setup();
  const ledger = new Ledger(db);
  await ledger.createAccount("acct-append");
  const granted = await ledger.grant({
    account: "acct-append",
    credits: 5,
    ref: "pack-1",
    idempotencyKey: "grant-append",
  });
  await assert.rejects(
    () => db.query("UPDATE credits_ledger SET delta = 1 WHERE id = $1", [granted.entryId]),
    /append-only/i,
  );
  await assert.rejects(
    () => db.query("DELETE FROM credits_ledger WHERE id = $1", [granted.entryId]),
    /append-only/i,
  );
  const rows = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM credits_ledger WHERE id = $1",
    [granted.entryId],
  );
  assert.equal(rows.rows[0].n, 1);
  assert.equal(await ledger.balance("acct-append"), 5);
});

test("database refuses a spend that would go negative", async () => {
  const { db } = await setup();
  const ledger = new Ledger(db);
  await ledger.createAccount("acct-floor");
  await ledger.grant({
    account: "acct-floor",
    credits: 3,
    ref: "pack-1",
    idempotencyKey: "g1",
  });
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO credits_ledger (id, account, delta, kind, ref, meta)
         VALUES ('forced-overdraw', 'acct-floor', -9, 'spend', 'x', '{}'::jsonb)`,
      ),
    /negative/i,
  );
  assert.equal(await ledger.balance("acct-floor"), 3);
  await assert.rejects(
    () =>
      db.query(
        `INSERT INTO credits_ledger (id, account, delta, kind, ref, meta)
         VALUES ('zero-spend', 'acct-floor', 0, 'spend', 'x', '{}'::jsonb)`,
      ),
    /check|violat|nonzero|sign/i,
  );
});

test("splitSqlStatements keeps dollar-quoted function bodies intact", () => {
  const statements = splitSqlStatements(MIGRATIONS.find((m) => m.id === "002_ledger")!.sql);
  assert.ok(statements.some((s) => s.includes("credits_ledger_refuse_mutation")));
  assert.ok(statements.some((s) => s.includes("credits_ledger_nonnegative")));
  assert.ok(statements.every((s) => !s.startsWith("$$")));
});
