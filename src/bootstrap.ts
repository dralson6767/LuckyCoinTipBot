/**
 * Idempotent DB bootstrap that runs on every worker start.
 * - Enforces required constraints (safe to re-run)
 * - Ensures FK integrity (adds NOT VALID FKs if missing; no heavy VALIDATE here)
 * - Credits deposits to ledger (min confirmations or credited=true)
 * - Debits withdrawals to ledger
 * - Pairs tips from existing ledger rows (strict 10-min window)
 *
 * IMPORTANT:
 * - No trigger is installed (pairing is app-side).
 * - No destructive ops.
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
        -- Keep a single global uniqueness for ledger refs per reason
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_reason_ref_unique') THEN
          ALTER TABLE public.ledger ADD CONSTRAINT ledger_reason_ref_unique UNIQUE (reason, ref);
        END IF;

        -- WITHDRAWALS: ensure UNIQUE(txid) exists once (name may vary across envs)
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'withdrawals_txid_unique') THEN
          ALTER TABLE public.withdrawals ADD CONSTRAINT withdrawals_txid_unique UNIQUE (txid);
        END IF;
      END $$;
    `);

    // 2) Ensure FOREIGN KEYS exist (NOT VALID to avoid heavy backfill here)
    console.log("[bootstrap] ensuring foreign keys…");
    await c.query(`
      DO $$
      BEGIN
        -- ledger.user_id -> users(id)
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ledger_user_id_fkey') THEN
          ALTER TABLE public.ledger
            ADD CONSTRAINT ledger_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.users(id)
            NOT VALID;
        END IF;

        -- tips.from_user_id / to_user_id -> users(id)
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tips_from_user_fkey') THEN
          ALTER TABLE public.tips
            ADD CONSTRAINT tips_from_user_fkey
            FOREIGN KEY (from_user_id) REFERENCES public.users(id)
            NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tips_to_user_fkey') THEN
          ALTER TABLE public.tips
            ADD CONSTRAINT tips_to_user_fkey
            FOREIGN KEY (to_user_id) REFERENCES public.users(id)
            NOT VALID;
        END IF;

        -- tips.ledger_out_id / ledger_in_id -> ledger(id), allow pruning via SET NULL
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tips_ledger_out_fkey') THEN
          ALTER TABLE public.tips
            ADD CONSTRAINT tips_ledger_out_fkey
            FOREIGN KEY (ledger_out_id) REFERENCES public.ledger(id)
            ON DELETE SET NULL
            NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tips_ledger_in_fkey') THEN
          ALTER TABLE public.tips
            ADD CONSTRAINT tips_ledger_in_fkey
            FOREIGN KEY (ledger_in_id) REFERENCES public.ledger(id)
            ON DELETE SET NULL
            NOT VALID;
        END IF;
      END $$;
    `);

    console.log("[bootstrap] FKs ensured; posting deposits → ledger…");

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

    // 5) Historical pairing sweep (kept as a safety net; ON CONFLICT prevents dup tips)
    console.log("[bootstrap] pairing tips sweep (10 min window) …");
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

    console.log("[bootstrap] complete (no DB trigger; app handles tip audit).");
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
