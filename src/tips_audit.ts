// src/db/tips_audit.ts
import { Client } from "pg";

/**
 * Insert an audit row for a tip transfer (idempotent).
 * Call inside the same transaction that inserts the two ledger rows + updates users.transferred_tip_lites.
 */
export async function recordTipAudit(
  c: Client,
  fromUserId: number,
  toUserId: number,
  amountLites: number,
  ledgerOutId: number | null,
  ledgerInId: number | null,
  createdAt: Date = new Date()
) {
  await c.query(
    `
    INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, created_at, ledger_out_id, ledger_in_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING;
    `,
    [
      fromUserId,
      toUserId,
      Math.abs(amountLites),
      createdAt,
      ledgerOutId,
      ledgerInId,
    ]
  );
}
