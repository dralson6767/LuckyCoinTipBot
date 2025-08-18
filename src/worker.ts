import "dotenv/config";
import { rpc } from "./rpc.js";
import { query } from "./db.js";
import { ensureUser, credit } from "./ledger.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || "6");
const POLL_MS = 30_000;

type TxItem = {
  address: string;
  category: string; // "receive" | "send" | ...
  amount: number;
  label?: string;
  confirmations: number;
  txid: string;
  vout: number;
  time?: number;
};

async function scanOnce() {
  // pull plenty so we don't miss older confirmations
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 1000, 0, true]);

  // only receives with enough confs AND a numeric label (we label deposit addrs with Telegram user id)
  const receives = txs.filter(
    (t) =>
      t.category === "receive" &&
      (t.confirmations ?? 0) >= MIN_CONF &&
      t.label &&
      /^\d+$/.test(String(t.label))
  );

  for (const t of receives) {
    // 1) IGNORE wallet change from our own withdrawals:
    // if this tx also has a "send" part, the "receive" leg is change → skip
    const full = await rpc<any>("gettransaction", [t.txid]);
    if (
      Array.isArray(full?.details) &&
      full.details.some((d: any) => d.category === "send")
    ) {
      continue;
    }

    // 2) idempotency via deposits table (txid+vout)
    const exists = await query(
      "SELECT 1 FROM deposits WHERE txid = $1 AND vout = $2",
      [t.txid, t.vout]
    );
    if (exists.rows.length) continue;

    // 3) credit the user
    const tgId = Number(t.label);
    const user = await ensureUser({ id: tgId });
    const amountLites = BigInt(Math.round(Number(t.amount) * 1e8));

    await query("BEGIN");
    try {
      await query(
        "INSERT INTO deposits (user_id, txid, vout, amount_lites, confirmations, credited) VALUES ($1,$2,$3,$4,$5,$6)",
        [user.id, t.txid, t.vout, String(amountLites), t.confirmations, true]
      );

      // ref = txid:vout makes credits idempotent at the ledger level too
      await credit(user.id, amountLites, "deposit", `${t.txid}:${t.vout}`);

      await query("COMMIT");
      console.log(`Credited deposit ${t.txid}:${t.vout} to user ${user.id}`);
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      console.error("Failed to record deposit", e);
    }
  }
}

async function main() {
  console.log(
    `Deposit worker running (every ${POLL_MS / 1000}s, min confs=${MIN_CONF})`
  );
  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error("scanOnce error", e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
