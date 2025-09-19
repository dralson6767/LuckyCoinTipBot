// src/db.ts
import { Pool, PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// ---- Pool (fail fast, avoid zombie conns) ----
export const pool = new Pool({
  connectionString,
  // small pool is fine for a bot; tune via env if needed
  max: Number(process.env.PG_POOL_MAX ?? "10"),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? "2000"),
  allowExitOnIdle: true,
  keepAlive: true,
  keepAliveInitialDelayMillis: 0,
  // recycle clients periodically to avoid weird long-lived states (supported by pg Pool)
  // (set to "0" to disable via env)
  maxUses: Number(process.env.PG_MAX_USES ?? "10000"),
  maxLifetimeSeconds:
    Number(process.env.PG_MAX_LIFETIME_SEC ?? "0") || undefined,
  application_name:
    process.env.PG_APP_NAME ?? process.env.SERVICE_NAME ?? "tipbot", // shown in pg_stat_activity
});

// Per-connection session setup (scoped to this client only)
async function initSession(client: PoolClient) {
  try {
    await client.query(`
      SET application_name = '${(
        process.env.PG_APP_NAME ??
        process.env.SERVICE_NAME ??
        "tipbot"
      ).replace(/'/g, "''")}';
      SET TIME ZONE 'UTC';
      SET search_path TO public;

      -- Make sure our session can write even if db/role defaults are read-only.
      SET default_transaction_read_only = off;
      SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;

      -- Safety timeouts so queries don't hang the event loop.
      SET statement_timeout = ${Number(
        process.env.PG_STMT_TIMEOUT_MS ?? "5000"
      )};
      SET lock_timeout = ${Number(process.env.PG_LOCK_TIMEOUT_MS ?? "2000")};
      SET idle_in_transaction_session_timeout = 5000;
    `);

    const ro = await client.query<{ transaction_read_only: "on" | "off" }>(
      `SHOW transaction_read_only;`
    );
    if (ro.rows?.[0]?.transaction_read_only === "on") {
      console.warn(
        "[pg] WARNING: connected in READ-ONLY mode; writes will fail."
      );
    }
  } catch (e: any) {
    console.error("[pg] connect setup failed:", e?.message ?? e);
  }
}

pool.on("connect", initSession);
pool.on("error", (e) => {
  // Prevents unhandled error events from killing the process
  console.error("[pg] pool error:", e?.message || e);
});

/** Lightweight query wrapper with slow-query logging */
export async function query<T = any>(
  text: string,
  params: any[] = []
): Promise<{ rows: T[] }> {
  const t0 = Date.now();
  const res = await pool.query(text, params);
  const dur = Date.now() - t0;
  if (dur > Number(process.env.PG_SLOW_MS ?? "1000")) {
    console.warn(
      `[pg] slow query ${dur}ms: ${text.replace(/\s+/g, " ").slice(0, 180)}`
    );
  }
  return { rows: res.rows as T[] };
}

/** Run a function with a pooled client (same connection for the whole fn). */
export async function withClient<T>(
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/**
 * Fast balance:
 * balance_lites = users.transferred_tip_lites
 *               + SUM(ledger.delta_lites WHERE reason IN ('deposit','withdrawal'))
 * Use inside an existing TX when possible.
 */
export async function getBalanceLitesWithClient(
  c: PoolClient,
  userId: number
): Promise<bigint> {
  const { rows } = await c.query(
    `
    SELECT COALESCE(u.transferred_tip_lites, 0)
         + COALESCE(SUM(CASE WHEN l.reason IN ('deposit','withdrawal')
                             THEN l.delta_lites ELSE 0 END), 0) AS balance_lites
    FROM public.users u
    LEFT JOIN public.ledger l ON l.user_id = u.id
    WHERE u.id = $1
    GROUP BY u.transferred_tip_lites
    `,
    [userId]
  );
  return BigInt(rows?.[0]?.balance_lites ?? 0);
}

/** Same as above but manages its own client. */
export async function getBalanceLites(userId: number): Promise<bigint> {
  return withClient((c) => getBalanceLitesWithClient(c, userId));
}

// Allow graceful shutdown
export async function closePool() {
  try {
    await pool.end();
  } catch {}
}

export type { PoolClient };
export { pool as default };
