// src/db.ts
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Pool with fast connect timeout; keep it small so we fail fast if PG is unreachable.
export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? "10"),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? "2000"),
});

// Set server-side timeouts on each new connection so queries cannot hang forever.
pool.on("connect", async (client) => {
  try {
    await client.query(`SET application_name = 'tipbot';
                        SET statement_timeout = ${Number(
                          process.env.PG_STMT_TIMEOUT_MS ?? "5000"
                        )};
                        SET lock_timeout = ${Number(
                          process.env.PG_LOCK_TIMEOUT_MS ?? "2000"
                        )};
                        SET idle_in_transaction_session_timeout = 5000;`);
  } catch (e) {
    // If this fails we still keep going; better to have a connection than none.
    console.error("pg connect setup failed", (e as Error)?.message);
  }
});

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
