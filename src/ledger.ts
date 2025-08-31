import { query } from "./db.js";

// Minimal user shape the bot needs
export type BotUser = { id: number; username?: string | null };

// idempotent upsert of Telegram user into public.users
export async function ensureUser(
  from: any
): Promise<{ id: number; username?: string | null }> {
  const tgId = Number(from?.id ?? from?.tg_user_id);
  const uname = from?.username ?? null;

  if (!Number.isFinite(tgId)) throw new Error("ensureUser: bad tg id");

  const r = await query<{ id: number; username: string | null }>(
    `
    INSERT INTO public.users (tg_user_id, username)
    VALUES ($1, NULLIF($2,''))
    ON CONFLICT (tg_user_id) DO UPDATE
      SET username = COALESCE(NULLIF(EXCLUDED.username,''), public.users.username)
    RETURNING id, username
    `,
    [tgId, uname]
  );
  return r.rows[0];
}

// FAST balance: single indexed aggregate, return as bigint
export async function balanceLites(userId: number): Promise<bigint> {
  const r = await query<{ bal: string }>(
    `SELECT COALESCE(SUM(delta_lites),0)::text AS bal
       FROM public.ledger
      WHERE user_id = $1`,
    [userId]
  );
  return BigInt(r.rows[0]?.bal ?? "0");
}

// simple username lookup (case-insensitive)
export async function findUserByUsername(username: string) {
  const r = await query<{
    id: number;
    tg_user_id: string;
    username: string | null;
  }>(
    `SELECT id, tg_user_id::text, username
       FROM public.users
      WHERE LOWER(username) = LOWER($1)
      LIMIT 1`,
    [username]
  );
  return r.rows[0] ?? null;
}

// atomic transfer with balance check (2 ledger rows)
export async function transfer(fromId: number, toId: number, amount: bigint) {
  if (amount <= 0n) throw new Error("amount must be positive");
  if (fromId === toId) throw new Error("cannot tip yourself");

  // check balance first
  const balRow = await query<{ bal: string }>(
    `SELECT COALESCE(SUM(delta_lites),0)::text AS bal
       FROM public.ledger
      WHERE user_id = $1`,
    [fromId]
  );
  const bal = BigInt(balRow.rows[0]?.bal ?? "0");
  if (bal < amount) throw new Error("Insufficient balance");

  await query("BEGIN");
  try {
    const now = new Date();

    await query(
      `INSERT INTO public.ledger (user_id, delta_lites, reason, ref, created_at)
       VALUES ($1, $2, 'tip_out', NULL, $3)`,
      [fromId, String(-amount), now]
    );

    await query(
      `INSERT INTO public.ledger (user_id, delta_lites, reason, ref, created_at)
       VALUES ($1, $2, 'tip_in', NULL, $3)`,
      [toId, String(amount), now]
    );

    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// Idempotent credit insert: positive delta_lites.
export async function credit(
  userId: number,
  amount_lites: bigint,
  reason: string,
  ref: string | null = null,
  createdAt?: Date
): Promise<void> {
  await query(
    `INSERT INTO public.ledger (user_id, delta_lites, reason, ref, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
     ON CONFLICT DO NOTHING`,
    [userId, String(amount_lites), reason, ref, createdAt ?? null]
  );
}

// Optional: symmetric debit (negative delta_lites). Not required if not imported anywhere.
export async function debit(
  userId: number,
  amount_lites: bigint,
  reason: string,
  ref: string | null = null,
  createdAt?: Date
): Promise<void> {
  await query(
    `INSERT INTO public.ledger (user_id, delta_lites, reason, ref, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
     ON CONFLICT DO NOTHING`,
    [userId, String(-amount_lites), reason, ref, createdAt ?? null]
  );
}
