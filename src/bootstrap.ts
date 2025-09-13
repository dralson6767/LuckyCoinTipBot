/**
 * Idempotent DB bootstrap that runs on every worker start.
 * - Enforces required constraints (safe to re-run)
 * - (Re)creates tips pairing function + trigger (safe to re-run)
 * - Credits deposits to ledger (min confirmations or credited=true)
 * - Debits withdrawals to ledger
 * - Pairs tips from existing ledger rows (strict 10-min window)
 *
 * No destructive ops. If DB/session is read-only, skip writes.
 */
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[bootstrap] DATABASE_URL missing");
    process.exit(0);
  }
  const MIN_CONFS = Number(process.env.MIN_CONFIRMATIONS || 6);

  const c = new Client({ connectionString: url });
  await c.connect();
  console.log("[bootstrap] connected; enforcing search_path + constraints…");

  await c.query(`
    SET search_path TO public;
    SET default_transaction_read_only = off;
    SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;
  `);

  const lockRes = await c.query(
    `SELECT pg_try_advisory_lock(922337203) AS locked`
  );
  const locked = !!lockRes.rows?.[0]?.locked;
  if (!locked) {
    console.log("[bootstrap] another instance is bootstrapping; skipping");
    await c.end();
    return;
  }

  try {
    const ro = await c.query(`SHOW transaction_read_only;`);
    const isRO = (ro.rows?.[0]?.transaction_read_only ?? "off") === "on";
    if (isRO) {
      console.warn("[bootstrap] DB is READ-ONLY; skipping DDL and data sync");
      return;
    }

    // Make sure legacy NULLs are zero (non-destructive; idempotent)
    await c.query(
      `UPDATE public.users SET transferred_tip_lites = 0 WHERE transferred_tip_lites IS NULL;`
    );

    // 1) Minimal constraints we rely on (safe to rerun)
    await c.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ledger_reason_ref_unique') THEN
          ALTER TABLE public.ledger ADD CONSTRAINT ledger_reason_ref_unique UNIQUE (reason, ref);
        END IF;

        -- (Optional) We do NOT add ledger_user_reason_ref_unique here to avoid redundancy.

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='withdrawals_txid_unique') THEN
          ALTER TABLE public.withdrawals ADD CONSTRAINT withdrawals_txid_unique UNIQUE (txid);
        END IF;
      END $$;
    `);

    console.log("[bootstrap] constraints ok; (re)installing tips trigger…");

    // 2) (Re)install tips pairing function(s) and trigger (idempotent)
    await c.query(`
      CREATE OR REPLACE FUNCTION public.tips_try_pair(p_ledger_id BIGINT)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      DECLARE
        r_ledger RECORD;
        match_ledger_id BIGINT;
      BEGIN
        SELECT id, user_id, delta_lites, created_at, reason
          INTO r_ledger
        FROM public.ledger
        WHERE id = p_ledger_id;

        IF NOT FOUND THEN RETURN; END IF;

        IF r_ledger.reason NOT IN ('tip_out','rain_out','airdrop_out','tip_in','rain_in','airdrop_in') THEN
          RETURN;
        END IF;

        IF r_ledger.reason IN ('tip_out','rain_out','airdrop_out') THEN
          SELECT l.id INTO match_ledger_id
          FROM public.ledger l
          WHERE l.reason IN ('tip_in','rain_in','airdrop_in')
            AND l.user_id <> r_ledger.user_id
            AND ABS(l.delta_lites) = ABS(r_ledger.delta_lites)
            AND l.created_at BETWEEN (r_ledger.created_at - INTERVAL '5 minutes')
                                 AND (r_ledger.created_at + INTERVAL '5 minutes')
            AND NOT EXISTS (
              SELECT 1 FROM public.tips t
               WHERE t.ledger_out_id = r_ledger.id OR t.ledger_in_id = l.id
            )
          ORDER BY l.id ASC
          LIMIT 1;
          IF match_ledger_id IS NULL THEN RETURN; END IF;

          INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, created_at, ledger_out_id, ledger_in_id)
          SELECT r_ledger.user_id, l.user_id, ABS(r_ledger.delta_lites),
                 LEAST(r_ledger.created_at, l.created_at), r_ledger.id, l.id
          FROM public.ledger l
          WHERE l.id = match_ledger_id
          ON CONFLICT DO NOTHING;

        ELSE
          SELECT l.id INTO match_ledger_id
          FROM public.ledger l
          WHERE l.reason IN ('tip_out','rain_out','airdrop_out')
            AND l.user_id <> r_ledger.user_id
            AND ABS(l.delta_lites) = ABS(r_ledger.delta_lites)
            AND l.created_at BETWEEN (r_ledger.created_at - INTERVAL '5 minutes')
                                 AND (r_ledger.created_at + INTERVAL '5 minutes')
            AND NOT EXISTS (
              SELECT 1 FROM public.tips t
               WHERE t.ledger_in_id = r_ledger.id OR t.ledger_out_id = l.id
            )
          ORDER BY l.id ASC
          LIMIT 1;
          IF match_ledger_id IS NULL THEN RETURN; END IF;

          INSERT INTO public.tips (from_user_id, to_user_id, amount_lites, created_at, ledger_out_id, ledger_in_id)
          SELECT l.user_id, r_ledger.user_id, ABS(r_ledger.delta_lites),
                 LEAST(r_ledger.created_at, l.created_at), l.id, r_ledger.id
          FROM public.ledger l
          WHERE l.id = match_ledger_id
          ON CONFLICT DO NOTHING;
        END IF;
      END $$;

      CREATE OR REPLACE FUNCTION public.tips_try_pair(p_ledger_id INTEGER)
      RETURNS VOID
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM public.tips_try_pair(p_ledger_id::BIGINT);
      END $$;

      CREATE OR REPLACE FUNCTION public.tips_trigger_fire()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM public.tips_try_pair(NEW.id::BIGINT);
        RETURN NEW;
      END $$;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tips_after_insert') THEN
          CREATE TRIGGER tips_after_insert
          AFTER INSERT ON public.ledger
          FOR EACH ROW EXECUTE FUNCTION public.tips_trigger_fire();
        END IF;
      END $$;
    `);

    console.log("[bootstrap] trigger ready; posting deposits → ledger…");

    // 3) Deposits → ledger (credit) idempotent
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

    // 4) Withdrawals → ledger (debit) idempotent
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

    console.log("[bootstrap] withdrawals posted; pairing tips sweep…");

    // 5) Pair any historical tip rows that arrived out-of-order (10-min window)
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
        SELECT 1 FROM public.tips t
        WHERE t.ledger_out_id = o.id OR t.ledger_in_id = i.id
      );
    `);

    console.log("[bootstrap] complete");
  } catch (e: any) {
    if (e?.code === "25006") {
      console.warn("[bootstrap] read-only; skipping writes");
    } else {
      console.error("[bootstrap] non-fatal error:", e?.message ?? e);
    }
  } finally {
    try {
      await c.query(`SELECT pg_advisory_unlock(922337203)`);
    } catch {}
    await c.end();
  }
}

main().catch((e) => {
  console.error("[bootstrap] non-fatal top-level:", e?.message ?? e);
  process.exit(0);
});
