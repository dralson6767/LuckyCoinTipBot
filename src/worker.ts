import 'dotenv/config';
import { rpc } from './rpc.js';
import { query } from './db.js';
import { ensureUser, credit } from './ledger.js';

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || "6");
const POLL_MS = 30_000;

type TxItem = {
  address: string;
  category: string;
  amount: number;
  label?: string;
  confirmations: number;
  txid: string;
  vout: number;
  time?: number;
};

async function scanOnce() {
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 200, 0, true]);
  const receives = txs.filter(t => t.category === "receive" && t.confirmations >= MIN_CONF && t.label);
  for (const t of receives) {
    const exists = await query("SELECT 1 FROM deposits WHERE txid = $1 AND vout = $2", [t.txid, t.vout]);
    if (exists.rows.length) continue;

    const tgId = Number(t.label);
    if (!Number.isFinite(tgId)) continue;

    const user = await ensureUser({ id: tgId });
    const amountLites = BigInt(Math.round(t.amount * 1e8));
    await query("BEGIN");
    try {
      await query("INSERT INTO deposits (user_id, txid, vout, amount_lites, confirmations, credited) VALUES ($1,$2,$3,$4,$5,$6)",
        [user.id, t.txid, t.vout, String(amountLites), t.confirmations, true]);
      await credit(user.id, amountLites, "deposit", `${t.txid}:${t.vout}`);
      await query("COMMIT");
      console.log(`Credited deposit ${t.txid}:${t.vout} to user ${user.id}`);
    } catch (e) {
      await query("ROLLBACK");
      console.error("Failed to record deposit", e);
    }
  }
}

async function main() {
  console.log(`Deposit worker running (every ${POLL_MS/1000}s, min confs=${MIN_CONF})`);
  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error("scanOnce error", e);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
