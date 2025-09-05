// src/db.ts
import { Pool, PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Small pool + fast timeouts so the app fails fast if PG is unreachable.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? "10"),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? "2000"),
});

/**
 * Per-connection session setup.
 * - NO global ALTER DATABASE.
 * - Force our session to be READ WRITE even if the server/db/role default is read-only.
 * - Keep everything scoped to THIS connection only.
 */
async function initSession(client: PoolClient) {
  try {
    await client.query(`
      SET application_name = 'tipbot';
      SET search_path TO public;

      -- If a default made sessions read-only, flip OUR session back to read-write.
      SET default_transaction_read_only = off;
      SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;

      -- Timeouts
      SET statement_timeout = ${Number(
        process.env.PG_STMT_TIMEOUT_MS ?? "5000"
      )};
      SET lock_timeout = ${Number(process.env.PG_LOCK_TIMEOUT_MS ?? "2000")};
      SET idle_in_transaction_session_timeout = 5000;
    `);

    // Optional: warn if server still reports read-only (e.g., actual physical standby)
    const ro = await client.query(`SHOW transaction_read_only;`);
    if ((ro.rows?.[0]?.transaction_read_only ?? "off") === "on") {
      console.warn(
        "[pg] WARNING: connected in READ-ONLY mode; writes will fail."
      );
    }
  } catch (e) {
    console.error("pg connect setup failed", (e as Error)?.message);
  }
}

pool.on("connect", initSession);

export async function query<T = any>(
  text: string,
  params: any[] = []
): Promise<{ rows: T[] }> {
  const t0 = Date.now();
  const res = await pool.query(text, params);
  const dur = Date.now() - t0;
  if (dur > 1000) {
    console.warn(
      `[pg] slow query ${dur}ms: ${text.replace(/\s+/g, " ").slice(0, 180)}`
    );
  }
  return { rows: res.rows as T[] };
}
