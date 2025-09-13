// src/rpc.ts
export async function rpc<T>(
  method: string,
  params: any[] = [],
  timeoutMs = 5000
): Promise<T> {
  const url =
    process.env.LKY_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:9918";

  const user = process.env.LKY_RPC_USER || process.env.RPC_USER || "";
  const pass = process.env.LKY_RPC_PASS || process.env.RPC_PASSWORD || "";

  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (user) {
    headers.authorization =
      "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  const body = JSON.stringify({
    jsonrpc: "1.0",
    id: "tipbot",
    method,
    params,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error("rpc_timeout")),
    timeoutMs
  );

  let res: Response;
  try {
    // @ts-ignore Node18+ global fetch
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    } as any);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`RPC HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({} as any));
  if (data?.error) {
    const e = new Error(data.error?.message ?? "RPC error");
    (e as any).code = data.error?.code;
    throw e;
  }
  return data.result as T;
}
