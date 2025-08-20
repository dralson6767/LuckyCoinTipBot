// scripts/rebuild_withdrawals.ts
import "dotenv/config";
import { rpc } from "../src/rpc.js";
import { query } from "../src/db.js";
import { ensureUser } from "../src/ledger.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || "6");

type TxItem = {
  category: string; // 'send' | 'receive' ...
  amount: number; // negative for 'send'
  address?: string;
  label?: string;
  confirmations?: number;
  txid: string;
  vout?: number;
  comment?: string;
};

function extractTgIdMaybe(t: any): number | null {
  if (t?.label && /^\d+$/.test(String(t.label))) return Number(t.label);
  const s = String(t?.comment ?? "");
  const m1 = s.match(/tg:?(\d{5,})/i);
  if (m1) return Number(m1[1]);
  const m2 = s.match(/\b(\d{5,})\b/);
  if (m2) return Number(m2[1]);
  return null;
}

async function main() {
  console.log("Rebuilding withdrawals from node wallet…");

  // Pull a lot of history; adjust if needed
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 100000, 0, true]);

  let added = 0,
    skipped = 0,
    unknown = 0;

  for (const t of txs) {
    if (t.category !== "send") continue;
    const confs = t.confirmations ?? 0;
    if (confs < MIN_CONF) {
      skipped++;
      continue;
    }

    const full = await rpc<any>("gettransaction", [t.txid]);

    let tgId = extractTgIdMaybe(t) ?? extractTgIdMaybe(full);
    if (!tgId && Array.isArray(full?.details)) {
      for (const d of full.details) {
        tgId = extractTgIdMaybe(d);
        if (tgId) break;
      }
    }
    if (!tgId) {
      unknown++;
      console.warn("skip send with no tg id:", t.txid);
      continue;
    }

    const vout = t.vout ?? 0;
    const amtLites = BigInt(Math.round(Math.abs(Number(t.amount)) * 1e8));
    const feeLites = BigInt(Math.round(Math.abs(Number(full?.fee ?? 0)) * 1e8));

    const user = await ensureUser({ id: tgId });

    const ref = `wd:${t.txid}:${vout}`;

    await query("BEGIN");
    try {
      await query(
        `INSERT INTO withdrawals (user_id, txid, vout, amount_lites, fee_lites)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (txid, vout) DO NOTHING`,
        [user.id, t.txid, vout, String(amtLites), String(feeLites)]
      );

      await query(
        `INSERT INTO ledger (user_id, delta_lites, reason, ref)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (ref) DO NOTHING`,
        [user.id, String(-amtLites), "withdraw", ref]
      );

      await query("COMMIT");
      added++;
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      console.error("failed withdrawal insert", t.txid, e);
    }
  }

  console.log(
    `Done. Added ${added}, skipped ${skipped}, unknown_owner ${unknown}.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
