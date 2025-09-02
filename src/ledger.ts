import { ClientBase } from "pg";

/**
 * Posts a single ledger row safely.
 * Uses the DB constraint so rebuilds can't break inserts.
 */
export async function postLedger(
  db: ClientBase,
  userId: number,
  deltaLites: bigint,
  reason:
    | "deposit"
    | "withdrawal"
    | "tip_out"
    | "tip_in"
    | "rain_out"
    | "rain_in"
    | "airdrop_out"
    | "airdrop_in",
  ref: string,
  at: Date
): Promise<number | null> {
  const res = await db.query<{
    id: string;
  }>(
    `INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
     VALUES($1,$2,$3,$4,$5)
     ON CONSTRAINT ledger_reason_ref_unique DO NOTHING
     RETURNING id`,
    [userId, deltaLites.toString(), reason, ref, at]
  );
  return res.rows[0]?.id ? Number(res.rows[0].id) : null;
}

/**
 * Atomically posts a tip transfer (out + in) and proactively fires the pairing,
 * so /balance reflects more than deposits even before the sweep.
 */
export async function postTipTransfer(
  db: ClientBase,
  fromUserId: number,
  toUserId: number,
  amountLites: bigint,
  ref: string,
  at: Date
) {
  await db.query("BEGIN");

  try {
    // out (negative)
    let outId = await postLedger(
      db,
      fromUserId,
      -amountLites,
      "tip_out",
      ref,
      at
    );
    if (outId == null) {
      const q = await db.query<{ id: number }>(
        `SELECT id FROM public.ledger WHERE user_id=$1 AND reason='tip_out' AND ref=$2 LIMIT 1`,
        [fromUserId, ref]
      );
      outId = q.rows[0]?.id ?? null;
    }

    // in (positive)
    let inId = await postLedger(db, toUserId, amountLites, "tip_in", ref, at);
    if (inId == null) {
      const q = await db.query<{ id: number }>(
        `SELECT id FROM public.ledger WHERE user_id=$1 AND reason='tip_in' AND ref=$2 LIMIT 1`,
        [toUserId, ref]
      );
      inId = q.rows[0]?.id ?? null;
    }

    // proactively fire pairing on whichever we have
    if (outId != null) {
      await db.query(`SELECT public.tips_try_pair($1::BIGINT)`, [outId]);
    }
    if (inId != null) {
      await db.query(`SELECT public.tips_try_pair($1::BIGINT)`, [inId]);
    }

    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
