// src/tips.ts
import type { Pool } from "pg";
// If this file is in src/, db.ts is also in src/, so use "./db.js".
// If your tips file lives in src/services/, change this to "../db.js".
import { getBalanceLitesWithClient } from "./db.js";

export type TipArgs = {
  fromUserId: number;
  toUserId: number;
  amountLites: bigint;
};

export async function tipLites(
  pool: Pool,
  { fromUserId, toUserId, amountLites }: TipArgs
) {
  if (amountLites <= 0n) throw new Error("amount must be positive");
  if (fromUserId === toUserId) throw new Error("cannot tip yourself");

  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    const bal = await getBalanceLitesWithClient(c, fromUserId);
    if (bal < amountLites) throw new Error("insufficient balance");

    const ref = `tip:${Date.now()}:${fromUserId}->${toUserId}:${amountLites.toString()}`;

    // Avoid unary + on bigint; normalize once
    const pos = amountLites.toString();
    const neg = (0n - amountLites).toString();

    const outRes = await c.query(
      `INSERT INTO ledger (user_id, delta_lites, reason, ref)
       VALUES ($1, $2, 'tip_out', $3)
       RETURNING id`,
      [fromUserId, neg, ref]
    );
    const inRes = await c.query(
      `INSERT INTO ledger (user_id, delta_lites, reason, ref)
       VALUES ($1, $2, 'tip_in', $3)
       RETURNING id`,
      [toUserId, pos, ref]
    );
    const ledgerOutId = outRes.rows[0].id as number;
    const ledgerInId = inRes.rows[0].id as number;

    await c.query(
      `UPDATE users
         SET transferred_tip_lites = transferred_tip_lites - $1
       WHERE id = $2`,
      [pos, fromUserId]
    );
    await c.query(
      `UPDATE users
         SET transferred_tip_lites = transferred_tip_lites + $1
       WHERE id = $2`,
      [pos, toUserId]
    );

    await c.query(
      `INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, ledger_out_id, ledger_in_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [fromUserId, toUserId, pos, ledgerOutId, ledgerInId]
    );

    await c.query("COMMIT");
    return { ok: true, ref, amountLites: pos };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
