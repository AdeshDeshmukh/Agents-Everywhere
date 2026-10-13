export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@agents-everywhere/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")

      const initialized = yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            // Another process can initialize the database between the read and the write lock.
            const tables = yield* tx.all<{ name: string }>(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            if (tables.some((table) => table.name === "session")) return false
            if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
            yield* schema.up(tx)
            yield* tx.run(
              sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
            )
            yield* Effect.forEach(migrations, (migration) =>
              tx.run(
                sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
              ),
            )
            return true
          }),
        { behavior: "immediate" },
      )
      if (!initialized) yield* applyOnly(db, migrations)
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    const journal = yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`)
    let completed = new Set(
      journal ? (yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id) : [],
    )
    const legacy =
      completed.size === 0 &&
      (yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`))

    if (!journal || legacy) {
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(
              sql`CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
            )
            // Recheck under the write lock so competing processes cannot seed or replay the journal together.
            if ((yield* tx.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`))!.count > 0 || !legacy)
              return
            const named = (yield* tx.all<{ name: string }>(
              sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
            )).some((column) => column.name === "name")
            if (named) {
              yield* tx.run(sql`
                INSERT OR IGNORE INTO migration (id, time_completed)
                SELECT name, ${Date.now()} FROM __drizzle_migrations WHERE name IS NOT NULL
              `)
              return
            }
            const entries = yield* tx.all<{ created_at: number; prefix: string | null }>(sql`
              SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
              FROM __drizzle_migrations WHERE created_at IS NOT NULL
            `)
            for (const entry of entries) {
              const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
              if (!migration) {
                return yield* Effect.die(
                  new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
                )
              }
              yield* tx.run(sql`
                INSERT OR IGNORE INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})
              `)
            }
          }),
        { behavior: "immediate" },
      )
      completed = new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id))
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            if (yield* tx.get(sql`SELECT id FROM migration WHERE id = ${migration.id}`)) return
            yield* migration.up(tx)
            yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})`)
          }),
        { behavior: "immediate" },
      )
    }
  })
}
