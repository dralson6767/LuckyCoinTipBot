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

type LedgerReason =
  | "deposit"
  | "withdrawal"
  | "tip_out"
  | "tip_in"
  | "rain_out"
  | "rain_in"
  | "airdrop_out"
  | "airdrop_in";

/** normalize @username → lowercase, no leading '@' */
function normUsername(u?: string | null): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  return (s.startsWith("@") ? s.slice(1) : s).toLowerCase();
}

/** Ensure a users row exists; update username if provided. */
export async function ensureUser(tg: TgLike): Promise<DbUser> {
  const tgId = Number(tg.id);
  const uname = normUsername(tg.username);
  const res = await query<DbUser>(
    `INSERT INTO public.users (tg_user_id, username)
     VALUES ($1,$2)
     ON CONFLICT (tg_user_id)
     DO UPDATE SET username = COALESCE(EXCLUDED.username, public.users.username)
     RETURNING id, tg_user_id, username`,
    [tgId, uname]
  );
  return res.rows[0];
}

/** Sum of all ledger deltas (in lites) for a user. */
export async function balanceLites(userId: number): Promise<bigint> {
  const r = await query<{ s: string }>(
    `SELECT COALESCE(SUM(delta_lites),0)::text AS s
     FROM public.ledger WHERE user_id=$1`,
    [userId]
  );
  return BigInt(r.rows[0]?.s ?? "0");
}

/** Find a user by @username (case-insensitive). */
export async function findUserByUsername(
  username: string
): Promise<DbUser | null> {
  const uname = normUsername(username);
  if (!uname) return null;
  const r = await query<DbUser>(
    `SELECT id, tg_user_id, username
       FROM public.users
      WHERE LOWER(username)=LOWER($1)
      ORDER BY id ASC
      LIMIT 1`,
    [uname]
  );
  return r.rows[0] ?? null;
}

/** Internal: insert a ledger row idempotently using the UNIQUE constraint. */
async function insertLedger(
  userId: number,
  delta: bigint,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const ts = (at ?? new Date()).toISOString();
  const res = await query<{ id: number }>(
    `INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
     VALUES ($1, $2::bigint, $3, $4, $5)
     ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
     RETURNING id`,
    [userId, delta.toString(), reason, ref, ts]
  );
  const id = res.rows[0]?.id ?? null;

  // Pair tips immediately when applicable (safe no-op if function missing)
  if (
    id !== null &&
    (reason === "tip_out" ||
      reason === "tip_in" ||
      reason === "rain_out" ||
      reason === "rain_in" ||
      reason === "airdrop_out" ||
      reason === "airdrop_in")
  ) {
    try {
      await query(`SELECT public.tips_try_pair($1::BIGINT)`, [id]);
    } catch {
      // ignore; bootstrap sweep will pair later
    }
  }
  return id;
}

/**
 * CREDIT: positive delta. This is what scan_explorer.ts / worker.ts import.
 * Signature kept flexible so existing calls compile:
 *  - amount can be bigint | number | string (already in lites)
 *  - at is optional Date
 */
export async function credit(
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const amt =
    typeof amountLites === "bigint" ? amountLites : BigInt(String(amountLites));
  if (amt <= 0n) throw new Error("credit amount must be > 0");
  return insertLedger(userId, amt, reason, ref, at);
}

/** DEBIT: negative delta (exported in case any caller uses it). */
export async function debit(
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const amt =
    typeof amountLites === "bigint" ? amountLites : BigInt(String(amountLites));
  if (amt <= 0n) throw new Error("debit amount must be > 0");
  return insertLedger(userId, -amt, reason, ref, at);
}

/**
 * High-level tip transfer: writes tip_out and tip_in with the SAME ref,
 * then tries to pair them immediately.
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

  const ref = `tip:${Date.now()}:${fromUserId}->${toUserId}:${amountLites.toString()}`;
  const outId = await insertLedger(
    fromUserId,
    -amountLites,
    "tip_out",
    ref,
    new Date()
  );
  const inId = await insertLedger(
    toUserId,
    amountLites,
    "tip_in",
    ref,
    new Date()
  );

  // If for some reason we didn't get ids (duplicate ref), attempt pairing anyway.
  try {
    if (outId != null)
      await query(`SELECT public.tips_try_pair($1::BIGINT)`, [outId]);
    if (inId != null)
      await query(`SELECT public.tips_try_pair($1::BIGINT)`, [inId]);
  } catch {
    // ignore
  }
}
