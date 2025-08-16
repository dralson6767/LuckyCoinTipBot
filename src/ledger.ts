import { query } from './db.js';

export type User = {
  id: number;
  tg_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
};

export async function ensureUser(tgUser: { id: number; username?: string; first_name?: string; last_name?: string }): Promise<User> {
  const { id, username, first_name, last_name } = tgUser;
  const existing = await query<User>("SELECT * FROM users WHERE tg_user_id = $1", [String(id)]);
  if (existing.rows.length) {
    await query("UPDATE users SET username = COALESCE($2, username), first_name = COALESCE($3, first_name), last_name = COALESCE($4, last_name) WHERE tg_user_id = $1",
      [String(id), username ?? null, first_name ?? null, last_name ?? null]);
    return existing.rows[0];
  }
  const ins = await query<User>(
    "INSERT INTO users (tg_user_id, username, first_name, last_name) VALUES ($1,$2,$3,$4) RETURNING *",
    [String(id), username ?? null, first_name ?? null, last_name ?? null]
  );
  return ins.rows[0];
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const res = await query<User>("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
  return res.rows[0] ?? null;
}

export async function balanceLites(userId: number): Promise<bigint> {
  const res = await query<{ sum: string }>("SELECT COALESCE(SUM(delta_lites),0)::bigint AS sum FROM ledger WHERE user_id = $1", [userId]);
  const s = (res.rows[0]?.sum ?? "0");
  return BigInt(s);
}

export async function credit(userId: number, amountLites: bigint, reason: string, ref: string | null = null) {
  await query("INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)",
    [userId, String(amountLites), reason, ref]);
}

export async function transfer(fromUserId: number, toUserId: number, amountLites: bigint): Promise<void> {
  const bal = await balanceLites(fromUserId);
  if (bal < amountLites) throw new Error("insufficient balance");
  await query("BEGIN");
  try {
    await query("INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)",
      [fromUserId, String(-amountLites), "tip", `to:${toUserId}`]);
    await query("INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)",
      [toUserId, String(amountLites), "tip", `from:${fromUserId}`]);
    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    throw e;
  }
}
