// src/balance.ts
import { query } from "./db.js";

/**
 * Return a user's full balance (in lites) as BigInt.
 * Sums ALL ledger rows for the user: deposits, withdrawals, tips, rain, airdrops, etc.
 */
export async function getUserBalanceLites(userId: number): Promise<bigint> {
  const { rows } = await query<{ balance_lites: string }>(
    `
    SELECT COALESCE(SUM(delta_lites), 0)::bigint::text AS balance_lites
    FROM public.ledger
    WHERE user_id = $1
    `,
    [userId]
  );
  return BigInt(rows[0]?.balance_lites ?? "0");
}
