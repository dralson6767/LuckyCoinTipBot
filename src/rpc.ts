type RpcRequest = {
  jsonrpc: "1.0",
  id: string,
  method: string,
  params: any[]
};

const RPC_URL = process.env.LKY_RPC_URL || "";
const RPC_USER = process.env.LKY_RPC_USER || "";
const RPC_PASS = process.env.LKY_RPC_PASS || "";

if (!RPC_URL || !RPC_USER || !RPC_PASS) {
  console.warn("[rpc] Missing RPC env vars: LKY_RPC_URL / LKY_RPC_USER / LKY_RPC_PASS");
}

export async function rpc<T=any>(method: string, params: any[] = []): Promise<T> {
  const body: RpcRequest = { jsonrpc: "1.0", id: "lky-tipbot", method, params };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Basic " + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64")
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${method} failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result as T;
}
