// scripts/migrate.ts (dev-only safe guard)
// Refuses to create base tables unless explicitly allowed.
// In production: exits if DB looks empty (prevents accidental blank schema).

import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL missing");
    process.exit(1);
  }

  // Only allow empty-DB init in dev or when explicitly opted-in.
  const ALLOW_EMPTY_DB_INIT =
    process.env.ALLOW_EMPTY_DB_INIT === "1" ||
    process.env.NODE_ENV === "development";

  const c = new Client({ connectionString: url });
  await c.connect();

  // Sanity: detect empty/wrong DB name.
  const sanity = await c.query(`
    SELECT
      (SELECT to_regclass('public.users')  IS NOT NULL) AS has_users_tbl,
      (SELECT to_regclass('public.ledger') IS NOT NULL) AS has_ledger_tbl,
      (SELECT COUNT(*) FROM pg_class WHERE relnamespace='public'::regnamespace) AS public_object_count,
      COALESCE((SELECT COUNT(*) FROM public.users), 0) AS users_count
  `);

  const row = sanity.rows[0] || {};
  const hasUsersTbl = !!row.has_users_tbl;
  const hasLedgerTbl = !!row.has_ledger_tbl;
  const usersCount = Number(row.users_count || 0);

  if (
    (!hasUsersTbl || !hasLedgerTbl || usersCount === 0) &&
    !ALLOW_EMPTY_DB_INIT
  ) {
    console.error(
      "[migrate] REFUSING: DB looks empty or wrong; set ALLOW_EMPTY_DB_INIT=1 for dev only."
    );
    await c.end();
    process.exit(1);
  }

  // Example: migrations that are safe on non-empty DBs (idempotent)
  await c.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGSERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  console.log("[migrate] done.");
  await c.end();
}

main().catch((e) => {
  console.error("[migrate] error:", e?.message ?? e);
  process.exit(1);
});
