// src/worker.ts
// Deposit worker – RPC or Explorer (Luckyscan), selectable via env
import "dotenv/config";
import { rpc } from "./rpc.js";
import { query } from "./db.js";
import { ensureUser, credit } from "./ledger.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || "6");
const POLL_MS = 30_000;
const USE_EXPLORER = process.env.LKY_USE_EXPLORER === "true";
const EXPLORER_BASE =
  process.env.LKY_EXPLORER_BASE || "https://luckyscan.org/api";

// ---------- Types ----------
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

type ExplorerVout = { scriptpubkey_address?: string; value: number };
type ExplorerTx = {
  txid: string;
  vout: ExplorerVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
};

// ---------- Minimal HTTP helpers (built-in fetch) ----------
async function httpGetJSON<T>(path: string): Promise<T> {
  const res = await fetch(EXPLORER_BASE + path, { method: "GET" });
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}
async function httpGetText(path: string): Promise<string> {
  const res = await fetch(EXPLORER_BASE + path, { method: "GET" });
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} for ${path}`);
  return await res.text();
}

// ---------- Explorer helpers ----------
async function getTipHeight(): Promise<number> {
  const txt = await httpGetText("/blocks/tip/height");
  return Number(txt);
}
async function getAddressTxs(address: string): Promise<ExplorerTx[]> {
  // First page (newest + mempool)
  return await httpGetJSON<ExplorerTx[]>(`/address/${address}/txs`);
}

// ---------- RPC scan (original logic) ----------
async function scanOnceRpc() {
  // Pull plenty so we don't miss older confirmations
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 1000, 0, true]);

  // Only receives with enough confs AND a numeric label (label == Telegram user id)
  const receives = txs.filter(
    (t) =>
      t.category === "receive" &&
      (t.confirmations ?? 0) >= MIN_CONF &&
      t.label &&
      /^\d+$/.test(String(t.label))
  );

  for (const t of receives) {
    // Ignore wallet change from our own withdrawals
    const full = await rpc<any>("gettransaction", [t.txid]);
    if (
      Array.isArray(full?.details) &&
      full.details.some((d: any) => d.category === "send")
    ) {
      continue;
    }

    // Idempotency via (txid,vout)
    const exists = await query(
      "SELECT 1 FROM deposits WHERE txid = $1 AND vout = $2",
      [t.txid, t.vout]
    );
    if (exists.rows.length) continue;

    const tgId = Number(t.label);
    const user = await ensureUser({ id: tgId });
    const amountLites = BigInt(Math.round(Number(t.amount) * 1e8));

    await query("BEGIN");
    try {
      await query(
        `INSERT INTO deposits (user_id, txid, vout, amount_lites, confirmations, credited, created_at)
         VALUES ($1,$2,$3,$4,$5,$6, to_timestamp(COALESCE($7, extract(epoch from NOW()))))`,
        [
          user.id,
          t.txid,
          t.vout,
          String(amountLites),
          t.confirmations,
          true,
          t.time ?? null,
        ]
      );

      // ledger ref = txid:vout → idempotent at ledger level too
      await credit(user.id, amountLites, "deposit", `${t.txid}:${t.vout}`);

      await query("COMMIT");
      console.log(
        `Credited deposit ${t.txid}:${t.vout} to user ${user.id} (RPC)`
      );
    } catch (e) {
      await query("ROLLBACK").catch(() => {});
      console.error("Failed to record deposit (RPC path)", e);
    }
  }
}

// ---------- Explorer scan (Luckyscan/Esplora) ----------
async function scanOnceExplorer() {
  const tip = await getTipHeight();

  // We scan known deposit addresses; each is already mapped to a user_id
  const addrs = await query(
    "SELECT user_id, address FROM public.wallet_addresses"
  );

  for (const row of addrs.rows as Array<{ user_id: number; address: string }>) {
    const { user_id, address } = row;

    let txs: ExplorerTx[] = [];
    try {
      txs = await getAddressTxs(address);
    } catch (e) {
      console.error(`Explorer fetch error for ${address}`, e);
      continue;
    }

    for (const tx of txs) {
      if (!tx?.status?.confirmed) continue; // only credit confirmed
      const h = tx.status.block_height || 0;
      const conf = h ? Math.max(0, tip - h + 1) : 0;
      if (conf < MIN_CONF) continue;

      for (let vout = 0; vout < tx.vout.length; vout++) {
        const out = tx.vout[vout];
        if (out.scriptpubkey_address !== address) continue;

        // Idempotency guard
        const exists = await query(
          "SELECT 1 FROM deposits WHERE txid=$1 AND vout=$2",
          [tx.txid, vout]
        );
        if (exists.rows.length) continue;

        // value is already in smallest unit (lites)
        const amountLites = BigInt(out.value);
        const createdAt =
          tx.status.block_time != null
            ? new Date(tx.status.block_time * 1000)
            : new Date();

        await query("BEGIN");
        try {
          await query(
            `INSERT INTO deposits (user_id, txid, vout, amount_lites, confirmations, credited, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [user_id, tx.txid, vout, String(amountLites), conf, true, createdAt]
          );

          await credit(user_id, amountLites, "deposit", `${tx.txid}:${vout}`);

          await query("COMMIT");
          console.log(
            `Credited deposit ${tx.txid}:${vout} to user ${user_id} (Explorer)`
          );
        } catch (e) {
          await query("ROLLBACK").catch(() => {});
          console.error("Failed to record deposit (Explorer path)", e);
        }
      }
    }
  }
}

// ---------- Orchestrator ----------
async function scanOnce() {
  if (USE_EXPLORER) {
    return scanOnceExplorer();
  } else {
    return scanOnceRpc();
  }
}

async function main() {
  console.log(
    `Deposit worker running (every ${
      POLL_MS / 1000
    }s, min confs=${MIN_CONF}, explorer=${USE_EXPLORER})`
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
