// src/explorer.ts
const BASE = process.env.LKY_EXPLORER_BASE ?? "https://luckyscan.org/api";
const TIMEOUT_MS = Number(process.env.EXPLORER_TIMEOUT_MS ?? "8000");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("explorer timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await withTimeout(fetch(BASE + path), TIMEOUT_MS);
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} ${path}`);
  return res.json() as Promise<T>;
}
async function getText(path: string): Promise<string> {
  const res = await withTimeout(fetch(BASE + path), TIMEOUT_MS);
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} ${path}`);
  return res.text();
}

// Minimal types based on Esplora (mempool) API
export type AddressStats = {
  address: string;
  chain_stats: {
    funded_txo_sum: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_sum: number;
    spent_txo_sum: number;
    tx_count: number;
  };
};
export type TxVout = { scriptpubkey_address?: string; value: number };
export type Tx = {
  txid: string;
  vout: TxVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
};

export async function getTipHeight(): Promise<number> {
  const txt = await getText("/blocks/tip/height");
  return Number(txt);
}

export function getAddressStats(address: string): Promise<AddressStats> {
  return getJSON(`/address/${address}`);
}

export function getAddressTxs(
  address: string,
  lastSeenTxid?: string
): Promise<Tx[]> {
  return lastSeenTxid
    ? getJSON(`/address/${address}/txs/chain/${lastSeenTxid}`)
    : getJSON(`/address/${address}/txs`);
}
