// src/db.ts
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX ?? "10"),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? "30000"),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS ?? "5000"), // <— important
});

// Simple helper; transactions in this app are BEGIN/COMMIT via separate calls anyway.
export async function query<T = any>(
  text: string,
  params: any[] = []
): Promise<{ rows: T[] }> {
  const res = await pool.query(text, params);
  return { rows: res.rows as T[] };
}
