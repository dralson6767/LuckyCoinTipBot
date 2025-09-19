// src/scan_explorer.ts
// Explorer (Esplora-compatible) scanner using a single pooled client per tx for atomicity.

import "dotenv/config";
import { getTipHeight, getAddressTxs, Tx } from "./explorer.js";
import { query, withClient } from "./db.js";
import { creditWithClient } from "./ledger.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS ?? "6");

type Watched = { user_id: number; address: string };

export async function scanOnceExplorer(): Promise<void> {
  const tip = await getTipHeight();

  // Known deposit addresses (already mapped to user_id)
  const { rows } = await query<Watched>(
    "SELECT user_id, address FROM public.wallet_addresses"
  );

  for (const { user_id, address } of rows) {
    // First page (newest + mempool). If deep history is needed, extend with /txs/chain/:lastSeenTxid
    let txs: Tx[] = [];
    try {
      txs = await getAddressTxs(address);
    } catch (e) {
      console.error(`Explorer fetch error for ${address}`, e);
      continue;
    }

    for (const tx of txs) {
      if (!tx?.status?.confirmed) continue;

      const h = tx.status.block_height ?? 0;
      const conf = h ? Math.max(0, tip - h + 1) : 0;
      if (conf < MIN_CONF) continue;

      for (let vout = 0; vout < tx.vout.length; vout++) {
        const out = tx.vout[vout];
        if (out.scriptpubkey_address !== address) continue;

        // Idempotency guard
        const exists = await query(
          "SELECT 1 FROM public.deposits WHERE txid=$1 AND vout=$2",
          [tx.txid, vout]
        );
        if (exists.rows.length) continue;

        const amountLites = BigInt(out.value);
        const createdAt =
          tx.status.block_time != null
            ? new Date(tx.status.block_time * 1000)
            : new Date();

        await withClient(async (c) => {
          await c.query("BEGIN");
          try {
            await c.query(
              `INSERT INTO public.deposits
                 (user_id, txid, vout, amount_lites, confirmations, credited, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [
                user_id,
                tx.txid,
                vout,
                String(amountLites),
                conf,
                true,
                createdAt,
              ]
            );

            // ledger ref = txid:vout so re-runs are safe
            await creditWithClient(
              c,
              user_id,
              amountLites,
              "deposit",
              `${tx.txid}:${vout}`
            );

            await c.query("COMMIT");
            console.log(
              `Explorer credited ${tx.txid}:${vout} → user ${user_id}`
            );
          } catch (e) {
            await c.query("ROLLBACK").catch(() => {});
            console.error("Failed to record deposit (Explorer)", e);
          }
        });
      }
    }
  }
}
