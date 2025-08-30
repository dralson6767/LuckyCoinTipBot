// src/rpc.ts
type RpcRequest = { jsonrpc: "1.0"; id: string; method: string; params: any[] };

const RPC_URL = process.env.LKY_RPC_URL || "";
const RPC_USER = process.env.LKY_RPC_USER || "";
const RPC_PASS = process.env.LKY_RPC_PASS || "";

if (!RPC_URL || !RPC_USER || !RPC_PASS) {
  console.warn(
    "[rpc] Missing RPC env vars: LKY_RPC_URL / LKY_RPC_USER / LKY_RPC_PASS"
  );
}

const DEFAULT_TIMEOUT = Number(process.env.RPC_TIMEOUT_MS ?? "8000"); // 8s

export async function rpc<T>(
  method: string,
  params: any[] = [],
  timeoutMs = DEFAULT_TIMEOUT
): Promise<T> {
  const body: RpcRequest = { jsonrpc: "1.0", id: "lky-tipbot", method, params };

  const ctrl = new AbortController();
  const t = setTimeout(
    () => ctrl.abort(),
    timeoutMs
  ) as unknown as NodeJS.Timeout;
  // @ts-ignore - not all runtimes have unref
  t.unref?.();

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

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RPC ${method} failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);

    return json.result as T;
  } finally {
    clearTimeout(t);
  }
}
