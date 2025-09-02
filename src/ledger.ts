// src/ledger.ts
import { query } from "./db.js";

type TgLike = {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

export type DbUser = {
  id: number;
  tg_user_id: number;
  username: string | null;
};

/** Normalize @username → lowercase, no leading '@' */
function normUsername(u?: string | null): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  return (s.startsWith("@") ? s.slice(1) : s).toLowerCase();
}

/** Ensure a users row exists for this Telegram user id; update username if provided. */
export async function ensureUser(tg: TgLike): Promise<DbUser> {
  const tgId = Number(tg.id);
  const uname = normUsername(tg.username);

  // users(tg_user_id UNIQUE, username nullable)
  const res = await query<DbUser>(
    `
    INSERT INTO public.users (tg_user_id, username)
    VALUES ($1, $2)
    ON CONFLICT (tg_user_id)
    DO UPDATE SET username = COALESCE(EXCLUDED.username, public.users.username)
    RETURNING id, tg_user_id, username
  `,
    [tgId, uname]
  );

  return res.rows[0];
}

/** Sum of all ledger deltas for a user, as bigint (in lites). */
export async function balanceLites(userId: number): Promise<bigint> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(delta_lites),0)::text AS s FROM public.ledger WHERE user_id=$1`,
    [userId]
  );
  return BigInt(r.rows[0]?.s ?? "0");
}

/** Find a user by @username (case-insensitive). Returns null if not found. */
export async function findUserByUsername(
  username: string
): Promise<DbUser | null> {
  const uname = normUsername(username);
  if (!uname) return null;
  const r = await query<DbUser>(
    `SELECT id, tg_user_id, username
     FROM public.users
     WHERE LOWER(username) = LOWER($1)
     ORDER BY id ASC
     LIMIT 1`,
    [uname]
  );
  return r.rows[0] ?? null;
}

/**
 * Transfer amount (in lites) from one internal user to another.
 * - Checks balance
 * - Writes tip_out and tip_in with the SAME ref
 * - Uses the UNIQUE CONSTRAINT (reason, ref) to be idempotent
 * - Proactively fires tips_try_pair() to create a tips row immediately when possible
 */
export async function transfer(
  fromUserId: number,
  toUserId: number,
  amountLites: bigint
): Promise<void> {
  if (amountLites <= 0n) throw new Error("Amount must be positive");
  if (fromUserId === toUserId) throw new Error("Cannot tip yourself");

  const bal = await balanceLites(fromUserId);
  if (bal < amountLites) throw new Error("Insufficient balance");

  // Unique-ish reference shared by out/in; UNIQUE is on (reason, ref), so using same ref is OK.
  const ref = `tip:${Date.now()}:${fromUserId}->${toUserId}:${amountLites.toString()}`;

  // OUT (negative)
  const out = await query<{ id: number }>(
    `
    INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
    VALUES ($1, ($2)::bigint * -1, 'tip_out', $3, NOW())
    ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
    RETURNING id
  `,
    [fromUserId, amountLites.toString(), ref]
  );
  const outId = out.rows[0]?.id ?? null;

  // IN (positive)
  const inn = await query<{ id: number }>(
    `
    INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
    VALUES ($1, ($2)::bigint, 'tip_in', $3, NOW())
    ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
    RETURNING id
  `,
    [toUserId, amountLites.toString(), ref]
  );
  const inId = inn.rows[0]?.id ?? null;

  // Proactively try to pair into tips (safe if trigger exists; also safe if function is absent)
  try {
    if (outId != null) {
      await query(`SELECT public.tips_try_pair($1::BIGINT)`, [outId]);
    }
    if (inId != null) {
      await query(`SELECT public.tips_try_pair($1::BIGINT)`, [inId]);
    }
  } catch {
    // ignore — bootstrap/trigger sweep will pair soon anyway
  }
}
