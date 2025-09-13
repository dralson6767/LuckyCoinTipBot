import { query } from "./db.js";

/**
 * Ledger + Users helpers with compacted tip logic.
 *
 * Balances are now computed as:
 *   balance_lites = users.transferred_tip_lites
 *                 + SUM(ledger.delta_lites WHERE reason IN ('deposit','withdrawal'))
 *
 * Tip operations (transfer) update `users.transferred_tip_lites` directly,
 * and may still write paired tip rows to `ledger` (for audit),
 * but those rows are no longer used in balance calculations.
 */

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

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

export type LedgerReason =
  | "deposit"
  | "withdrawal"
  | "tip_out"
  | "tip_in"
  | "rain_out"
  | "rain_in"
  | "airdrop_out"
  | "airdrop_in";

const TIP_REASONS: LedgerReason[] = [
  "tip_out",
  "tip_in",
  "rain_out",
  "rain_in",
  "airdrop_out",
  "airdrop_in",
];

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/** normalize @username → lowercase, no leading '@' */
function normUsername(u?: string | null): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  return (s.startsWith("@") ? s.slice(1) : s).toLowerCase();
}

// -----------------------------------------------------------------------------
// Users
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Balance (compacted)
// -----------------------------------------------------------------------------

/**
 * Return the user's balance in lites as BigInt using compacted logic:
 *   users.transferred_tip_lites + SUM(ledger for deposit/withdrawal)
 */
export async function balanceLites(userId: number): Promise<bigint> {
  const r = await query<{ s: string }>(
    `SELECT (
        u.transferred_tip_lites
        + COALESCE(SUM(CASE WHEN l.reason IN ('deposit','withdrawal') THEN l.delta_lites ELSE 0 END), 0)
      )::text AS s
       FROM public.users u
       LEFT JOIN public.ledger l ON l.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, u.transferred_tip_lites`,
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

// -----------------------------------------------------------------------------
// Ledger insert helpers
// -----------------------------------------------------------------------------

/** Internal: find an existing ledger row id by (reason, ref). */
async function findLedgerIdByRef(
  reason: LedgerReason,
  ref: string
): Promise<number | null> {
  const r = await query<{ id: number }>(
    `SELECT id FROM public.ledger WHERE reason = $1 AND ref = $2 LIMIT 1`,
    [reason, ref]
  );
  return r.rows[0]?.id ?? null;
}

/** Internal: insert a ledger row idempotently using the UNIQUE (reason, ref). */
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
     ON CONFLICT ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
     RETURNING id`,
    [userId, delta.toString(), reason, ref, ts]
  );
  return res.rows[0]?.id ?? null;
}

/** Internal: record a tip audit row (idempotent; relies on a UNIQUE in tips). */
async function recordTipAudit(
  fromUserId: number,
  toUserId: number,
  amountLites: bigint,
  createdAt: Date,
  ledgerOutId: number | null,
  ledgerInId: number | null
): Promise<void> {
  await query(
    `INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, created_at, ledger_out_id, ledger_in_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING`,
    [
      fromUserId,
      toUserId,
      amountLites < 0n ? (-amountLites).toString() : amountLites.toString(),
      createdAt.toISOString(),
      ledgerOutId,
      ledgerInId,
    ]
  );
}

/** CREDIT: positive delta (exported for scan_explorer/worker). */
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

// -----------------------------------------------------------------------------
// Transfers (tips)
// -----------------------------------------------------------------------------

/**
 * High-level tip transfer between users.
 * - Ensures sufficient balance using compacted logic.
 * - Writes paired tip rows to ledger (audit only; balances ignore them).
 * - Updates users.transferred_tip_lites for both users so balances remain correct
 *   even if tip rows are later pruned.
 *
 * NOTE: This uses multiple statements. If your ./db.js "query" does not keep a
 * single connection across BEGIN/COMMIT, consider refactoring to run these
 * inside one multi-statement call or a client/transaction helper. For now,
 * this mirrors your existing pattern.
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

  const now = new Date();
  const ref = `tip:${now.getTime()}:${fromUserId}->${toUserId}:${amountLites.toString()}`;

  await query("BEGIN");
  try {
    // (1) Optional audit rows (kept for history/pairing; not used in balance)
    let outId = await insertLedger(
      fromUserId,
      -amountLites,
      "tip_out",
      ref,
      now
    );
    let inId = await insertLedger(toUserId, amountLites, "tip_in", ref, now);

    // If concurrent insert raced, fetch existing IDs by (reason, ref)
    if (outId === null) outId = await findLedgerIdByRef("tip_out", ref);
    if (inId === null) inId = await findLedgerIdByRef("tip_in", ref);

    // (2) Update compacted totals on users (authoritative for balances)
    await query(
      `UPDATE public.users SET transferred_tip_lites = transferred_tip_lites - $1 WHERE id = $2`,
      [amountLites.toString(), fromUserId]
    );
    await query(
      `UPDATE public.users SET transferred_tip_lites = transferred_tip_lites + $1 WHERE id = $2`,
      [amountLites.toString(), toUserId]
    );

    // (3) App-side tip audit (no DB trigger/function dependency)
    await recordTipAudit(fromUserId, toUserId, amountLites, now, outId, inId);

    await query("COMMIT");
  } catch (e) {
    await query("ROLLBACK");
    throw e;
  }
}
