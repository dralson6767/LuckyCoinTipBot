// src/ledger.ts
import {
  query,
  withClient,
  type PoolClient,
  getBalanceLitesWithClient,
} from "./db.js";

/**
 * Ledger + Users helpers with compacted tip logic.
 *
 * balance_lites =
 *   users.transferred_tip_lites
 *   + SUM(ledger.delta_lites WHERE reason IN ('deposit','withdrawal'))
 *
 * Tips update users.transferred_tip_lites (authoritative) and still
 * write paired audit rows in ledger (tip_out / tip_in).
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
// Balance (compacted read)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Ledger helpers (client-safe variants + pool wrappers)
// -----------------------------------------------------------------------------

/** Internal: find an existing ledger row id by (reason, ref) using a specific client. */
async function findLedgerIdByRefWithClient(
  c: PoolClient,
  reason: LedgerReason,
  ref: string
): Promise<number | null> {
  const r = await c.query<{ id: number }>(
    `SELECT id FROM public.ledger WHERE reason = $1 AND ref = $2 LIMIT 1`,
    [reason, ref]
  );
  return (r.rows[0] as any)?.id ?? null;
}

/** Internal: insert a ledger row idempotently (UNIQUE(reason,ref)) on a specific client. */
async function insertLedgerWithClient(
  c: PoolClient,
  userId: number,
  delta: bigint,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const ts = (at ?? new Date()).toISOString();
  const res = await c.query<{ id: number }>(
    `INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
       VALUES ($1, $2::bigint, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
     RETURNING id`,
    [userId, delta.toString(), reason, ref, ts]
  );
  return (res.rows[0] as any)?.id ?? null;
}

/** Pool wrapper (kept for any legacy single-call uses). */
async function insertLedger(
  userId: number,
  delta: bigint,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  return withClient((c) =>
    insertLedgerWithClient(c, userId, delta, reason, ref, at)
  );
}

/** Internal: record a tip audit row on a specific client. */
async function recordTipAuditWithClient(
  c: PoolClient,
  fromUserId: number,
  toUserId: number,
  amountLites: bigint,
  createdAt: Date,
  ledgerOutId: number | null,
  ledgerInId: number | null
): Promise<void> {
  await c.query(
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

// -----------------------------------------------------------------------------
// Credits / Debits (export both client+pool versions)
// -----------------------------------------------------------------------------

/** CREDIT with an existing client (preferred inside transactions). */
export async function creditWithClient(
  c: PoolClient,
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const amt =
    typeof amountLites === "bigint" ? amountLites : BigInt(String(amountLites));
  if (amt <= 0n) throw new Error("credit amount must be > 0");
  return insertLedgerWithClient(c, userId, amt, reason, ref, at);
}

/** CREDIT pool wrapper. */
export async function credit(
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  return withClient((c) =>
    creditWithClient(c, userId, amountLites, reason, ref, at)
  );
}

/** DEBIT with an existing client (preferred inside transactions). */
export async function debitWithClient(
  c: PoolClient,
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  const amt =
    typeof amountLites === "bigint" ? amountLites : BigInt(String(amountLites));
  if (amt <= 0n) throw new Error("debit amount must be > 0");
  return insertLedgerWithClient(c, userId, -amt, reason, ref, at);
}

/** DEBIT pool wrapper. */
export async function debit(
  userId: number,
  amountLites: bigint | number | string,
  reason: LedgerReason,
  ref: string,
  at?: Date
): Promise<number | null> {
  return withClient((c) =>
    debitWithClient(c, userId, amountLites, reason, ref, at)
  );
}

// -----------------------------------------------------------------------------
// Transfers (tips) — transaction-safe on ONE client
// -----------------------------------------------------------------------------

/**
 * Tip transfer between users, fully atomic:
 * - Locks sender row to serialize concurrent tips (prevents double-spend)
 * - Validates balance on the same connection
 * - Writes ledger audit rows (idempotent) on the same connection
 * - Updates users.transferred_tip_lites for both users
 * - Records app-side tip audit
 */
export async function transfer(
  fromUserId: number,
  toUserId: number,
  amountLites: bigint
): Promise<void> {
  if (amountLites <= 0n) throw new Error("Amount must be positive");
  if (fromUserId === toUserId) throw new Error("Cannot tip yourself");

  const now = new Date();
  const ref = `tip:${now.getTime()}:${fromUserId}->${toUserId}:${amountLites.toString()}`;

  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      // 0) Serialize concurrent spenders: lock sender row
      await c.query(`SELECT id FROM public.users WHERE id = $1 FOR UPDATE`, [
        fromUserId,
      ]);

      // 1) Balance check on THIS connection (reads deposits/withdrawals too)
      const bal = await getBalanceLitesWithClient(c, fromUserId);
      if (bal < amountLites) {
        await c.query("ROLLBACK");
        throw new Error("Insufficient balance");
      }

      // 2) Audit rows (idempotent)
      let outId = await insertLedgerWithClient(
        c,
        fromUserId,
        -amountLites,
        "tip_out",
        ref,
        now
      );
      let inId = await insertLedgerWithClient(
        c,
        toUserId,
        amountLites,
        "tip_in",
        ref,
        now
      );
      if (outId === null)
        outId = await findLedgerIdByRefWithClient(c, "tip_out", ref);
      if (inId === null)
        inId = await findLedgerIdByRefWithClient(c, "tip_in", ref);

      // 3) Apply authoritative totals
      await c.query(
        `UPDATE public.users
           SET transferred_tip_lites = transferred_tip_lites - $1
         WHERE id = $2`,
        [amountLites.toString(), fromUserId]
      );
      await c.query(
        `UPDATE public.users
           SET transferred_tip_lites = transferred_tip_lites + $1
         WHERE id = $2`,
        [amountLites.toString(), toUserId]
      );

      // 4) App-side tip audit
      await recordTipAuditWithClient(
        c,
        fromUserId,
        toUserId,
        amountLites,
        now,
        outId,
        inId
      );

      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
