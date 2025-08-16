export const LITES_PER_LKY = 100000000n;

export function parseLkyToLites(input: string): bigint {
  const s0 = input.trim();
  if (!s0) throw new Error("amount is empty");
  const neg = s0.startsWith('-');
  const s = neg ? s0.slice(1) : s0;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid amount format");
  const [i, f0 = ""] = s.split('.');
  if (f0.length > 8) throw new Error("too many decimals (max 8)");
  const f = f0.padEnd(8, '0');
  const bi = BigInt(i);
  const bf = BigInt(f || "0");
  let total = bi * LITES_PER_LKY + bf;
  if (neg) total = -total;
  return total;
}

export function formatLky(lites: bigint, decimals = 8): string {
  const neg = lites < 0n;
  const v = neg ? -lites : lites;
  const i = v / LITES_PER_LKY;
  const f = (v % LITES_PER_LKY).toString().padStart(8, '0');
  const trimmed = f.replace(/0+$/, '');
  const frac = trimmed.slice(0, Math.min(decimals, 8));
  return (neg ? "-" : "") + i.toString() + (frac ? "." + frac : "");
}

export function isValidTipAmount(l: bigint): boolean {
  return l >= 1n; // >= 0.00000001 LKY; adjust to avoid dust
}
