import type { Context } from "telegraf";

function timeout(ms: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("tg_timeout")), ms)
  );
}

/** Reply but stop waiting after N ms (message may still arrive later). */
export async function replyFast(
  ctx: Context,
  text: string,
  extra?: Parameters<Context["reply"]>[1],
  timeoutMs = Number(process.env.TG_REPLY_TIMEOUT_MS ?? "5000")
) {
  try {
    // race the network call vs a timer; we don't abort the HTTP, we just stop awaiting it
    return await Promise.race([
      ctx.reply(text, extra as any),
      timeout(timeoutMs),
    ]);
  } catch (e: any) {
    if (e?.message === "tg_timeout") {
      console.warn(`[tg] reply timed out after ${timeoutMs}ms (continuing)`);
      return undefined;
    }
    throw e;
  }
}

/** Fire-and-forget alternative (never blocks). */
export function replyFireAndForget(
  ctx: Context,
  text: string,
  extra?: Parameters<Context["reply"]>[1]
) {
  void ctx
    .reply(text, extra as any)
    .catch((e) => console.warn("[tg] reply error:", e?.message || e));
}
