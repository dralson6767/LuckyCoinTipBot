/**
 * Idempotent DB bootstrap that runs on every worker start.
 * - Enforces required constraints (safe to re-run)
 * - Credits deposits to ledger (min confirmations or credited=true)
 * - Debits withdrawals to ledger
 * - Pairs tips from existing ledger rows (strict 10-min window)
 *
 * This makes restarts/rebuilds self-heal: data only grows, never rolls back.
 */
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!url) {
    console.error("[bootstrap] DATABASE_URL missing");
    process.exit(1);
  }
  const MIN_CONFS = Number(process.env.MIN_CONFIRMATIONS || 6);

  const c = new Client({ connectionString: url });
  await c.connect();

  console.log("[bootstrap] connected; enforcing constraints…");

  // 1) Constraints we rely on (safe to rerun)
  await c.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ledger_reason_ref_unique') THEN
      ALTER TABLE public.ledger ADD CONSTRAINT ledger_reason_ref_unique UNIQUE (reason, ref);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ledger_user_reason_ref_unique') THEN
      ALTER TABLE public.ledger ADD CONSTRAINT ledger_user_reason_ref_unique UNIQUE (user_id, reason, ref);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='withdrawals_txid_unique') THEN
      ALTER TABLE public.withdrawals ADD CONSTRAINT withdrawals_txid_unique UNIQUE (txid);
    END IF;
  END $$;`);

  console.log("[bootstrap] constraints ok; posting deposits → ledger…");

  // 2) Deposits → ledger (credit) idempotent
  await c.query(
    `
    INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
    SELECT d.user_id,
           d.amount_lites,
           'deposit',
           d.txid || ':' || d.vout,
           d.created_at
    FROM public.deposits d
    WHERE (d.credited = true OR d.confirmations >= $1)
      AND NOT EXISTS (
        SELECT 1 FROM public.ledger l
        WHERE l.reason = 'deposit'
          AND l.ref = d.txid || ':' || d.vout
      );
  `,
    [MIN_CONFS]
  );

  console.log("[bootstrap] deposits posted; posting withdrawals → ledger…");

  // 3) Withdrawals → ledger (debit) idempotent
  await c.query(`
    INSERT INTO public.ledger(user_id, delta_lites, reason, ref, created_at)
    SELECT w.user_id,
           -w.amount_lites,
           'withdrawal',
           w.txid,
           COALESCE(w.created_at, NOW())
    FROM public.withdrawals w
    WHERE w.txid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.ledger l
        WHERE l.reason = 'withdrawal'
          AND l.ref = w.txid
      );
  `);

  console.log("[bootstrap] withdrawals posted; pairing tips…");

  // 4) Pair tips from existing ledger rows (strict pairing, idempotent)
  await c.query(`
    WITH outs AS (
      SELECT id, user_id, delta_lites, created_at
      FROM public.ledger
      WHERE reason IN ('tip_out','rain_out','airdrop_out')
    ),
    ins AS (
      SELECT id, user_id, delta_lites, created_at
      FROM public.ledger
      WHERE reason IN ('tip_in','rain_in','airdrop_in')
    )
    INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, created_at, ledger_out_id, ledger_in_id)
    SELECT o.user_id, i.user_id, ABS(o.delta_lites), LEAST(o.created_at,i.created_at), o.id, i.id
    FROM outs o
    JOIN ins  i
      ON ABS(o.delta_lites) = ABS(i.delta_lites)
     AND o.user_id <> i.user_id
     AND ABS(EXTRACT(EPOCH FROM (i.created_at - o.created_at))) <= 600
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.tips t
      WHERE t.ledger_out_id = o.id OR t.ledger_in_id = i.id
    );
  `);

  console.log("[bootstrap] complete");
  await c.end();
}

main().catch((e) => {
  console.error("[bootstrap] failed:", e);
  process.exit(1);
});
