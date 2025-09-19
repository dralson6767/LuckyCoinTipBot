// src/explorer.ts
// Esplora-compatible helpers with real abortable timeouts.

const BASE = process.env.LKY_EXPLORER_BASE ?? "https://luckyscan.org/api";
const TIMEOUT_MS = Number(process.env.EXPLORER_TIMEOUT_MS ?? "3000"); // fast default

function abortableFetch(url: string, ms = TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error("explorer_timeout")), ms);
  // @ts-ignore Node18+ global fetch & AbortController
  return fetch(url, { signal: ctrl.signal } as any).finally(() =>
    clearTimeout(t)
  );
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await abortableFetch(BASE + path);
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
}

async function getText(path: string): Promise<string> {
  const res = await abortableFetch(BASE + path);
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status} ${path}`);
  return res.text();
}

// Esplora types
export type TxVout = { scriptpubkey_address?: string; value: number };
export type Tx = {
  txid: string;
  vout: TxVout[];
  status: { confirmed: boolean; block_height?: number; block_time?: number };
};
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
