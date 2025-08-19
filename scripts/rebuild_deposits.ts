// scripts/rebuild_deposits.ts
import "dotenv/config";
import { rpc } from "../src/rpc.js";
import { query } from "../src/db.js";
import { credit, ensureUser } from "../src/ledger.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || "6");

type TxItem = {
  category: string;
  amount: number;
  label?: string;
  confirmations?: number;
  txid: string;
  vout?: number;
};

async function main() {
  console.log("Rebuilding deposits from node wallet…");
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 10000, 0, true]);

  let added = 0,
    skipped = 0;

  for (const t of txs) {
    if (t.category !== "receive") continue;
    if (!t.label || !/^\d+$/.test(String(t.label))) continue;
    if ((t.confirmations ?? 0) < MIN_CONF) continue;

    // ignore wallet change from our own withdrawals
    const full = await rpc<any>("gettransaction", [t.txid]);
    if (
      Array.isArray(full?.details) &&
      full.details.some((d: any) => d.category === "send")
    ) {
      skipped++;
      continue;
    }

    const tgId = Number(t.label);
    const vout = t.vout ?? 0;
    const ref = `${t.txid}:${vout}`;
    const amountLites = BigInt(Math.round(Number(t.amount) * 1e8));

    // deposits table idempotency
    const ex = await query("SELECT 1 FROM deposits WHERE txid=$1 AND vout=$2", [
      t.txid,
      vout,
    ]);
    if (ex.rows.length) {
      skipped++;
      continue;
    }

    const user = await ensureUser({ id: tgId });
    await query("BEGIN");
    try {
      await query(
        "INSERT INTO deposits (user_id, txid, vout, amount_lites, confirmations, credited) VALUES ($1,$2,$3,$4,$5,$6)",
        [user.id, t.txid, vout, String(amountLites), t.confirmations ?? 0, true]
      );
      // ledger idempotency via unique ref
      await credit(user.id, amountLites, "deposit", ref);
      await query("COMMIT");
      added++;
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      console.error("failed insert", t.txid, e);
    }
  }

  console.log(`Done. Added ${added}, skipped ${skipped}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
