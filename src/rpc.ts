// src/rpc.ts
type RpcError = { code?: number; message?: string };

const ENDPOINT =
  process.env.LKY_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:9918";

const ENV_USER = process.env.LKY_RPC_USER || process.env.RPC_USER || "";
const ENV_PASS = process.env.LKY_RPC_PASS || process.env.RPC_PASSWORD || "";

// Parse credentials from URL if present (e.g. http://user:pass@host:9918)
function parseAuthFromUrl(u: string): {
  url: string;
  user: string;
  pass: string;
} {
  try {
    const x = new URL(u);
    const user = x.username || ENV_USER;
    const pass = x.password || ENV_PASS;
    // strip credentials for the request URL (auth is sent via header)
    x.username = "";
    x.password = "";
    return { url: x.toString(), user, pass };
  } catch {
    return { url: u, user: ENV_USER, pass: ENV_PASS };
  }
}

function buildHeaders(user: string, pass: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "text/plain",
    accept: "application/json",
  };
  if (user) {
    h.authorization =
      "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }
  return h;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function rpc<T>(
  method: string,
  params: any[] = [],
  timeoutMs = 5000
): Promise<T> {
  const { url, user, pass } = parseAuthFromUrl(ENDPOINT);
  const headers = buildHeaders(user, pass);
  const body = JSON.stringify({
    jsonrpc: "1.0",
    id: `tipbot:${method}`,
    method,
    params,
  });

  // one tiny retry for transient network errors
  const maxAttempts = 2;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Prefer AbortSignal.timeout when available (Node 18+), else manual controller.
    let signal: AbortSignal;
    let ctrl: AbortController | null = null;

    if (typeof (AbortSignal as any).timeout === "function") {
      signal = (AbortSignal as any).timeout(timeoutMs);
    } else {
      ctrl = new AbortController();
      signal = ctrl.signal;
      setTimeout(() => ctrl?.abort(new Error("rpc_timeout")), timeoutMs);
    }

    try {
      // @ts-ignore node18 global fetch
      const res: Response = await fetch(url, {
        method: "POST",
        headers,
        body,
        // Undici keeps connections alive/pools by default.
        // Keep the request simple to maximize throughput.
        signal,
      } as any);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`RPC HTTP ${res.status}: ${txt.slice(0, 240)}`);
      }

      const data = (await res.json().catch(() => ({}))) as any;
      if (data?.error) {
        const e = new Error(data.error?.message ?? "RPC error");
        (e as any).code = data.error?.code as number | undefined;
        throw e;
      }
      return data.result as T;
    } catch (e: any) {
      lastErr = e;

      // Do not retry JSON-RPC logical errors (e.code exists) or auth errors
      if (e && (typeof e.code === "number" || /401|403/.test(String(e)))) {
        throw e;
      }

      // Retry only on transient network failures / timeouts once
      const msg = String(e?.message || e || "");
      const transient =
        msg.includes("rpc_timeout") ||
        msg.includes("timed out") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("fetch failed") ||
        msg.includes("network");

      if (attempt < maxAttempts && transient) {
        await sleep(150); // tiny backoff
        continue;
      }

      throw e;
    }
  }

  // Should not reach here
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
