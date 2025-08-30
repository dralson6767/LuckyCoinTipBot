// src/rpc.ts
type RpcRequest = { jsonrpc: "1.0"; id: string; method: string; params: any[] };

const RPC_URL = process.env.LKY_RPC_URL || "";
const RPC_USER = process.env.LKY_RPC_USER || "";
const RPC_PASS = process.env.LKY_RPC_PASS || "";

const DEFAULT_TIMEOUT = Number(process.env.RPC_TIMEOUT_MS ?? "8000"); // 8s cap

export async function rpc<T>(
  method: string,
  params: any[] = [],
  timeoutMs = DEFAULT_TIMEOUT
): Promise<T> {
  const body: RpcRequest = { jsonrpc: "1.0", id: "lky-tipbot", method, params };
  const ctrl = new AbortController();
  const to = setTimeout(
    () => ctrl.abort(),
    timeoutMs
  ) as unknown as NodeJS.Timeout;
  // @ts-ignore
  to.unref?.();

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization:
          "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
        connection: "keep-alive",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status} ${text}`);
    const json = text ? JSON.parse(text) : {};
    if (json?.error)
      throw new Error(
        `RPC ${method} error: ${json.error?.message ?? "unknown"}`
      );
    return json.result as T;
  } finally {
    clearTimeout(to);
  }
}
