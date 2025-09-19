// src/worker.ts
// Deposit worker – prefers RPC; Explorer optional via env.
// Non-destructive, idempotent inserts + ledger credit.

import "dotenv/config";
import { rpc } from "./rpc.js";
import { query, withClient } from "./db.js";
import { ensureUser, creditWithClient } from "./ledger.js";
import { scanOnceExplorer } from "./scan_explorer.js";

const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS ?? "6");
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? "30000");

// EXPLORER_ENABLED accepts EXPLORER_ENABLED / LKY_USE_EXPLORER / USE_EXPLORER
const EXPLORER_ENABLED = /^(1|true|yes)$/i.test(
  (process.env.EXPLORER_ENABLED ??
    process.env.LKY_USE_EXPLORER ??
    process.env.USE_EXPLORER ??
    "false") as string
);

// ---------- Types ----------
type TxItem = {
  address: string;
  category: string; // "receive" | "send" | ...
  amount: number | string;
  label?: string;
  confirmations: number;
  txid: string;
  vout: number;
  time?: number;
};

// ---------- RPC scan ----------
async function scanOnceRpc() {
  // Pull enough history so we don’t miss late confirmations
  const txs = await rpc<TxItem[]>("listtransactions", ["*", 1000, 0, true]);

  const receives = txs.filter(
    (t) =>
      t.category === "receive" &&
      (Number(t.confirmations) || 0) >= MIN_CONF &&
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

    // Idempotency guard (txid,vout)
    const exists = await query(
      "SELECT 1 FROM public.deposits WHERE txid=$1 AND vout=$2",
      [t.txid, t.vout]
    );
    if (exists.rows.length) continue;

    const tgId = Number(t.label);
    const user = await ensureUser({ id: tgId });
    const amountLites = BigInt(Math.round(Number(t.amount) * 1e8));

    await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO public.deposits
             (user_id, txid, vout, amount_lites, confirmations, credited, created_at)
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

        // ledger ref = txid:vout → idempotent on ledger side too
        await creditWithClient(
          c,
          user.id,
          amountLites,
          "deposit",
          `${t.txid}:${t.vout}`
        );

        await c.query("COMMIT");
        console.log(
          `Credited deposit ${t.txid}:${t.vout} to user ${user.id} (RPC)`
        );
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        console.error("Failed to record deposit (RPC path)", e);
      }
    });
  }
}

// ---------- Orchestrator ----------
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let stopping = false;
process.on("SIGTERM", () => {
  if (!stopping)
    console.log("[worker] SIGTERM received; shutting down after current loop…");
  stopping = true;
});
process.on("SIGINT", () => {
  if (!stopping)
    console.log("[worker] SIGINT received; shutting down after current loop…");
  stopping = true;
});

async function loop() {
  console.log(
    `Deposit worker running (every ${Math.round(
      POLL_MS / 1000
    )}s, min confs=${MIN_CONF}, explorer=${EXPLORER_ENABLED})`
  );
  while (!stopping) {
    const start = Date.now();
    try {
      // Prefer RPC; keep Explorer optional and isolated so it never blocks RPC progress
      await scanOnceRpc();
    } catch (e) {
      console.error("scanOnceRpc error", (e as Error)?.message ?? e);
    }

    if (EXPLORER_ENABLED) {
      try {
        await scanOnceExplorer();
      } catch (e) {
        console.error("scanOnceExplorer error", (e as Error)?.message ?? e);
      }
    }

    const elapsed = Date.now() - start;
    const wait = Math.max(0, POLL_MS - elapsed);
    await sleep(wait);
  }
  console.log("[worker] exit.");
}

loop().catch((err) => {
  console.error("worker fatal", err);
  process.exit(1);
});
