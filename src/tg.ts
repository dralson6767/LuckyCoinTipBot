// src/tg.ts
import type { Context } from "telegraf";

/** Race a Telegram call with a timer; don't block handler forever. */
function timeout(ms: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("tg_timeout")), ms)
  );
}

/** Reply but stop awaiting after N ms (message may still arrive later). */
export async function replyFast(
  ctx: Context,
  text: string,
  extra?: Parameters<Context["reply"]>[1],
  timeoutMs = Number(process.env.TG_REPLY_TIMEOUT_MS ?? "5000")
) {
  try {
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

/* -------------------- QUEUED SENDER -------------------- */
/* Serializes sends and handles flood-wait (HTTP 429 retry_after). */

type Job = () => Promise<void>;
const queue: Job[] = [];
let running = false;

const SPACING_MS = Number(process.env.TG_SEND_SPACING_MS ?? "250"); // gap between sends

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await job();
      } catch (e: any) {
        const retry = e?.parameters?.retry_after;
        if (retry) {
          console.warn(`[tg] flood-wait ${retry}s; rescheduling`);
          await sleep((retry + 1) * 1000);
          // re-queue at the front so it goes next
          queue.unshift(job);
          continue;
        } else {
          console.warn("[tg] send error:", e?.message || e);
        }
      }
      await sleep(SPACING_MS);
    }
  } finally {
    running = false;
  }
}

export function queueSend(
  telegram: any,
  chatId: number,
  text: string,
  extra?: any
) {
  queue.push(async () => {
    await telegram.sendMessage(chatId, text, extra);
  });
  void runQueue();
}

export function queueReply(ctx: Context, text: string, extra?: any) {
  // @ts-ignore
  const chatId: number = (ctx.chat as any)?.id;
  // @ts-ignore
  queueSend((ctx as any).telegram, chatId, text, extra);
}
