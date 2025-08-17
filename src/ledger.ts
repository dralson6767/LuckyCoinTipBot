import { query } from "./db.js";

type TgUser = {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export async function ensureUser(u: TgUser) {
  // upsert by Telegram user id
  const res = await query<{
    id: number;
    tg_user_id: string;
    username: string | null;
  }>(
    `
    INSERT INTO users (tg_user_id, username, first_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tg_user_id) DO UPDATE
      SET username = COALESCE(EXCLUDED.username, users.username),
          first_name = COALESCE(EXCLUDED.first_name, users.first_name),
          last_seen = now()
    RETURNING id, tg_user_id, username
    `,
    [String(u.id), u.username ?? null, u.first_name ?? null]
  );
  return res.rows[0];
}

export async function findUserByUsername(uname: string) {
  const res = await query<{
    id: number;
    tg_user_id: string;
    username: string | null;
  }>(
    `SELECT id, tg_user_id, username FROM users WHERE lower(username) = lower($1) LIMIT 1`,
    [uname]
  );
  return res.rows[0] ?? null;
}

export async function balanceLites(userId: number): Promise<bigint> {
  const res = await query<{ bal: string }>(
    `SELECT COALESCE(SUM(delta_lites::bigint), 0) AS bal FROM ledger WHERE user_id = $1`,
    [userId]
  );
  return BigInt(res.rows[0].bal ?? "0");
}

// Atomic internal transfer: from -> to
export async function transfer(fromId: number, toId: number, amount: bigint) {
  if (amount <= 0n) throw new Error("amount must be > 0");

  await query("BEGIN");
  try {
    // lock the sender row to serialize concurrent spends
    await query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [fromId]);

    // compute current balance inside the txn
    const balRes = await query<{ bal: string }>(
      `SELECT COALESCE(SUM(delta_lites::bigint), 0) AS bal FROM ledger WHERE user_id = $1`,
      [fromId]
    );
    const cur = BigInt(balRes.rows[0].bal ?? "0");
    if (cur < amount) throw new Error("Insufficient balance");

    // shared reference to make the pair traceable (and unique)
    const ref = `tip:${Date.now()}:${fromId}->${toId}:${amount.toString()}`;

    // write sender debit and receiver credit
    await query(
      `INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)`,
      [fromId, String(-amount), "tip_out", ref]
    );
    await query(
      `INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)`,
      [toId, String(amount), "tip_in", ref]
    );

    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    throw e;
  }
}
