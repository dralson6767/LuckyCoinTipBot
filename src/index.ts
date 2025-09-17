// src/index.ts
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { rpc } from "./rpc.js";
import { query } from "./db.js";
import { ensureUser, transfer, findUserByUsername, debit } from "./ledger.js";
import { parseLkyToLites, formatLky, isValidTipAmount } from "./util.js";

// ---------- bot init ----------
const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");
const bot = new Telegraf(botToken);

// ---------- perf knobs ----------
const RESOLVE_USERNAME_TIMEOUT_MS = Number(
  process.env.RESOLVE_USERNAME_TIMEOUT_MS ?? "1500"
);
const USERNAME_CACHE_MS = Number(process.env.USERNAME_CACHE_MS ?? "1200000"); // 20 min
const BAL_CACHE_MS = Number(process.env.BALANCE_CACHE_MS ?? "5000"); // 5s default
const ENSURE_USER_CACHE_MS = Number(
  process.env.ENSURE_USER_CACHE_MS ?? "300000"
); // 5 min
const MAX_RPC_INFLIGHT = Number(process.env.MAX_RPC_INFLIGHT ?? "4");
const decimals = Number(process.env.DEFAULT_DISPLAY_DECIMALS ?? "8");

// tiny cache for @username → tg id
type CacheHit = { id: number; ts: number };
const unameCache = new Map<string, CacheHit>();

// --- ensureUser (hot-path) cache ---
const ensureUserCache = new Map<
  number,
  { id: number; uname?: string; ts: number }
>();
async function ensureUserCached(tg: any) {
  const id = Number(tg?.id);
  const uname = tg?.username || undefined;
  const now = Date.now();
  const hit = ensureUserCache.get(id);
  if (
    hit &&
    now - hit.ts < ENSURE_USER_CACHE_MS &&
    (!uname || uname === hit.uname)
  ) {
    return { id: hit.id };
  }
  const u = await ensureUser(tg);
  ensureUserCache.set(id, { id: u.id, uname, ts: now });
  return u;
}

// ---------- helpers ----------
const isGroup = (ctx: any) =>
  ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");

// delete the user's command only AFTER we replied (so it never “vanishes”)
const deleteAfter = (ctx: any) => {
  try {
    if (isGroup(ctx) && ctx.message) ctx.deleteMessage().catch(() => {});
  } catch {}
};

const ephemeralReply = async (
  ctx: any,
  text: string,
  ms = 8000,
  extra: any = {}
) => {
  try {
    const m = await ctx.reply(text, extra);
    if (isGroup(ctx))
      setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), ms);
  } catch {}
};

const dm = async (ctx: any, text: string, extra: any = {}) => {
  try {
    await ctx.telegram.sendMessage(ctx.from.id, text, extra);
    return true;
  } catch (e: any) {
    console.error("[dm] failed:", e?.message || e);
    return false;
  }
};

// background DM with flood-wait retry + logging (never blocks handlers)
async function dmLater(
  ctx: any,
  chatId: number,
  text: string,
  extra: any = {}
) {
  (async () => {
    try {
      await ctx.telegram.sendMessage(chatId, text, extra);
      console.log("[dmLater] delivered", chatId);
    } catch (e: any) {
      const retry = e?.parameters?.retry_after;
      if (retry) {
        console.warn("[dmLater] flood-wait", retry, "s; chat", chatId);
        setTimeout(() => {
          ctx.telegram
            .sendMessage(chatId, text, extra)
            .catch((err: unknown) => {
              const msg = (err as any)?.message ?? err;
              console.error("[dmLater] retry failed", chatId, msg);
            });
        }, (retry + 1) * 1000);
      } else {
        console.error("[dmLater] failed", chatId, e?.message || e);
      }
    }
  })();
}

// Resolve bot username reliably (fallback to env BOT_USERNAME)
let BOT_USER = "";
async function getBotUsernameEnsured(ctx?: any): Promise<string> {
  if (BOT_USER) return BOT_USER;
  try {
    const me = await bot.telegram.getMe();
    BOT_USER = me?.username || "";
  } catch {}
  if (!BOT_USER && (ctx as any)?.me?.username)
    BOT_USER = (ctx as any).me.username;
  if (!BOT_USER && process.env.BOT_USERNAME)
    BOT_USER = String(process.env.BOT_USERNAME).replace(/^@/, "");
  return BOT_USER;
}
async function botMention(ctx?: any) {
  const u = await getBotUsernameEnsured(ctx);
  return u ? `@${u}` : "@";
}
async function botDeepLink(ctx?: any, payload = "") {
  const u = await getBotUsernameEnsured(ctx);
  return u
    ? `https://t.me/${u}${
        payload ? `?start=${encodeURIComponent(payload)}` : ""
      }`
    : "";
}

// ---- HTML-safety for messages that include usernames etc. ----
const esc = (s: any) =>
  String(s ?? "").replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)
  );

// Inline keyboard builder for the START button
const startKb = (url?: string) =>
  url
    ? Markup.inlineKeyboard([[Markup.button.url("START LKY TIPBOT", url)]])
    : undefined;

// ---------- RPC helpers ----------
type RpcErr = { code?: number; message?: string };

const isWalletBusy = (e: any) => {
  const msg = String(e?.message || e || "");
  return (
    /rescanning|loading wallet|loading block|resource busy|database is locked|rewinding blocks|reindex/i.test(
      msg
    ) ||
    e?.code === -4 ||
    e?.code === -28
  );
};

async function rpcTry<T>(
  method: string,
  params: any[],
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false; err: RpcErr | any }> {
  try {
    const v = await rpc<T>(method, params, timeoutMs);
    return { ok: true, value: v };
  } catch (e: any) {
    return { ok: false, err: e };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("TIMEOUT")), ms);
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

// ---- RPC concurrency gate (prevents thundering herd on the node) ----
let rpcInflight = 0;
const rpcWaiters: Array<() => void> = [];
async function withRpcGate<T>(fn: () => Promise<T>): Promise<T> {
  if (rpcInflight >= MAX_RPC_INFLIGHT) {
    await new Promise<void>((res) => rpcWaiters.push(res));
  }
  rpcInflight++;
  try {
    return await fn();
  } finally {
    rpcInflight--;
    const next = rpcWaiters.shift();
    if (next) next();
  }
}

// ---------- one-time setup: schema + indexes for speed ----------
async function ensureSetup() {
  await query(
    `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS has_started boolean DEFAULT false NOT NULL;`
  );
  await query(
    `CREATE INDEX IF NOT EXISTS idx_users_has_started ON public.users(has_started);`
  );

  // balance speed indexes
  await query(
    `CREATE INDEX IF NOT EXISTS idx_ledger_user_reason ON public.ledger(user_id, reason);`
  ).catch(() => {});
  try {
    await query(
      `CREATE INDEX IF NOT EXISTS idx_ledger_bal_fast
         ON public.ledger(user_id) INCLUDE (delta_lites)
       WHERE reason IN ('deposit','withdrawal');`
    );
  } catch {
    await query(
      `CREATE INDEX IF NOT EXISTS idx_ledger_bal_fast_fb
         ON public.ledger(user_id, reason, delta_lites)
       WHERE reason IN ('deposit','withdrawal');`
    );
  }
  await query(`ANALYZE public.ledger;`).catch(() => {});
}

// ---------- FAST BALANCE ----------
async function getBalanceLitesFast(userId: number): Promise<bigint> {
  const sql = `
    SELECT
      u.transferred_tip_lites
      + COALESCE(r.dw_sum_lites, 0) AS balance_lites
    FROM public.users u
    LEFT JOIN public.ledger_dw_rollup r
      ON r.user_id = u.id
    WHERE u.id = $1
    LIMIT 1;
  `;
  const r = await query<{ balance_lites: string }>(sql, [userId]);
  const v = r.rows[0]?.balance_lites ?? "0";
  return BigInt(v);
}

// ===== Small balance cache (instant /balance + write-through updates) =====
const balanceCache = new Map<number, { bal: bigint; ts: number }>();

async function getBalanceCached(userId: number): Promise<bigint> {
  const hit = balanceCache.get(userId);
  if (hit && Date.now() - hit.ts < BAL_CACHE_MS) return hit.bal;
  const bal = await getBalanceLitesFast(userId);
  balanceCache.set(userId, { bal, ts: Date.now() });
  return bal;
}
function invalidateBalance(...userIds: number[]) {
  for (const id of userIds) balanceCache.delete(id);
}
function adjustBalanceCache(userId: number, delta: bigint) {
  const h = balanceCache.get(userId);
  if (h) balanceCache.set(userId, { bal: h.bal + delta, ts: Date.now() });
}

// ---------- deposit address (reuse) ----------
async function getOrAssignDepositAddress(
  userId: number,
  tgUserId: number
): Promise<string> {
  const existing = await query<{ deposit_address: string | null }>(
    "SELECT deposit_address FROM public.users WHERE id = $1",
    [userId]
  );
  const saved = existing.rows[0]?.deposit_address;
  if (saved) return saved;

  const label = String(tgUserId);
  let addr: string | undefined;

  const r1 = await withRpcGate(() =>
    rpcTry<Record<string, any>>("getaddressesbylabel", [label], 3000)
  );
  if (r1.ok && r1.value && typeof r1.value === "object") {
    const keys = Object.keys(r1.value);
    if (keys.length > 0) addr = keys[0];
  }
  if (!addr) {
    const r2 = await withRpcGate(() =>
      rpcTry<string>("getnewaddress", [label], 3000)
    );
    if (r2.ok && r2.value) addr = r2.value;
  }
  if (!addr) throw new Error("DEPOSIT_ADDR_FAILED");

  await query(
    "UPDATE public.users SET deposit_address = COALESCE(deposit_address, $1) WHERE id = $2",
    [addr, userId]
  );
  return addr;
}

// ---------- health ----------
bot.command("health", async (ctx) => {
  const out: string[] = [];
  try {
    const r = await query<{ now: string }>("select now()::text as now");
    out.push(`DB: ok (${r.rows[0]?.now})`);
  } catch (e: any) {
    out.push(`DB: ERR ${e?.message || e}`);
  }

  try {
    const h = await rpc<number>("getblockcount", [], 3000);
    out.push(`RPC: ok (height ${h})`);
  } catch (e: any) {
    out.push(`RPC: ERR ${e?.message || e}`);
  }

  await ctx.reply(out.join("\n"));
});

// ---------- commands ----------
bot.start(async (ctx) => {
  // ensure user exists (hot-path cached)
  const u = await ensureUserCached(ctx.from);
  const newUname = ctx.from.username || null;

  // one round-trip: read previous + update only if needed
  const sql = `
    WITH prev AS (
      SELECT id, has_started, username
      FROM public.users
      WHERE id = $1
    ),
    upd AS (
      UPDATE public.users AS uu
      SET has_started = TRUE,
          username    = COALESCE($2, uu.username)
      FROM prev
      WHERE uu.id = prev.id
        AND (
          prev.has_started IS DISTINCT FROM TRUE OR
          COALESCE($2, prev.username) IS DISTINCT FROM prev.username
        )
      RETURNING 1
    )
    SELECT prev.has_started AS was_started,
           EXISTS(SELECT 1 FROM upd) AS changed
    FROM prev
    LIMIT 1;
  `;
  const r = await query<{ was_started: boolean; changed: boolean }>(sql, [
    u.id,
    newUname,
  ]);
  const wasStarted = r.rows[0]?.was_started === true;

  // Deep-link payload when user came from ?start=...
  const payload =
    (ctx as any).startPayload || (ctx.message?.text?.split(/\s+/, 2)[1] ?? "");
  if (payload) {
    const m = /^claim-(\d+)-(\d+)$/.exec(payload);
    if (m && Number(m[1]) === Number(ctx.from.id)) {
      const first = ctx.from.first_name || "friend";
      await ctx.reply(
        `Welcome, ${esc(
          first
        )}! 🎉\nYour wallet is now activated and the pending tip was credited.\nSend /balance to check it.`
      );
      if (isGroup(ctx)) deleteAfter(ctx); // <- delete /start command in groups
      return;
    }
  }

  const msg = wasStarted
    ? `Welcome back to LuckyCoin Tipbot.\nType /help for commands.`
    : `Welcome to LuckyCoin Tipbot.\nType /help for commands.`;

  if (isGroup(ctx)) {
    await dm(ctx, msg); // reply in DM for privacy
    deleteAfter(ctx); // <- always delete the /start in group
  } else {
    await ctx.reply(msg); // normal DM chat
  }
});

bot.help(async (ctx) => {
  const mention = await botMention(ctx);
  const link = await botDeepLink(ctx);
  const text = [
    "*Commands*",
    "/deposit — get your LKY deposit address",
    "/balance — show your internal balance",
    "/tip — reply with `/tip 1.23` or `/tip @username 1.23`",
    "/withdraw <address> <amount> — withdraw on-chain",
    isGroup(ctx) && link ? `\n*Tip:* Use me in DM for privacy: ${mention}` : "",
  ].join("\n");
  if (isGroup(ctx)) {
    const ok = await dm(ctx, text, { parse_mode: "Markdown" });
    if (!ok)
      await ephemeralReply(
        ctx,
        link ? `Please DM me first: ${mention}` : "Please DM me first.",
        6000
      );
  } else {
    await ctx.reply(text, { parse_mode: "Markdown" });
  }
});

// ---------- fast @username resolution ----------
type TgChatMinimal = { id?: number; username?: string };

async function resolveUserIdByUsername(ctx: any, unameRaw: string) {
  const uname = unameRaw.replace(/^@/, "");
  const key = uname.toLowerCase();

  // 1) tiny cache
  const hit = unameCache.get(key);
  if (hit && Date.now() - hit.ts < USERNAME_CACHE_MS) return hit.id;

  // 2) DB first (use stored function)
  const inDb = await findUserByUsername(uname);
  if (inDb) {
    const id = Number(inDb.tg_user_id);
    unameCache.set(key, { id, ts: Date.now() });
    return id;
  }

  // 3) Telegram getChat with short timeout (avoid long stalls)
  try {
    const chat = (await withTimeout(
      ctx.telegram.getChat("@" + uname) as Promise<any>,
      RESOLVE_USERNAME_TIMEOUT_MS
    )) as TgChatMinimal;

    if (chat?.id != null) {
      await ensureUserCached({ id: chat.id, username: uname } as any); // persist minimal
      const id = Number(chat.id);
      unameCache.set(key, { id, ts: Date.now() });
      return id;
    }
  } catch {
    // timeout or error → fall through
  }

  return null;
}

// ===== /deposit (instant reply + cache; DM in background) =====
const depositAddrCache = new Map<number, { addr: string; ts: number }>();
const CACHE_MS = 10 * 60 * 1000; // 10 minutes

bot.command("deposit", async (ctx) => {
  console.log("[/deposit] start", ctx.from?.id, ctx.chat?.id);
  const user = await ensureUserCached(ctx.from);

  const replyAddr = async (addr: string) => {
    const msg = `Your LKY deposit address:\n\`${addr}\``;
    if (isGroup(ctx)) {
      await ephemeralReply(ctx, msg, 12000, { parse_mode: "Markdown" });
      dmLater(ctx, ctx.from.id, msg, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(msg, { parse_mode: "Markdown" });
    }
  };

  try {
    const hit = depositAddrCache.get(user.id);
    if (hit && Date.now() - hit.ts < CACHE_MS) {
      await replyAddr(hit.addr);
      console.log("[/deposit] cache hit");
      return;
    }

    const r1 = await query<{ deposit_address: string | null }>(
      "SELECT deposit_address FROM public.users WHERE id = $1",
      [user.id]
    );
    const saved = r1.rows[0]?.deposit_address;
    if (saved) {
      depositAddrCache.set(user.id, { addr: saved, ts: Date.now() });
      await replyAddr(saved);
      console.log("[/deposit] db hit");
      return;
    }

    const addr = await withTimeout(
      getOrAssignDepositAddress(user.id, ctx.from.id),
      6000
    );
    depositAddrCache.set(user.id, { addr, ts: Date.now() });
    await replyAddr(addr);
    console.log("[/deposit] assigned");
  } catch (e: any) {
    console.error("[/deposit] ERR", e?.message || e);
    const mention = await botMention(ctx);
    const link = await botDeepLink(ctx);
    const msg = isWalletBusy(e)
      ? "Wallet is busy. Try /deposit again in a minute."
      : "Wallet temporarily unavailable. Try /deposit again shortly.";
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(
          ctx,
          link ? `Please DM me first: ${mention}` : "Please DM me first.",
          6000
        );
    } else {
      await ctx.reply(msg);
    }
  }
});

// ----- /balance ----- (compact + fast)
bot.command("balance", async (ctx) => {
  console.log("[/balance] start", ctx.from?.id, ctx.chat?.id);
  try {
    const user = await ensureUserCached(ctx.from);
    const bal = await getBalanceCached(user.id); // <- cached
    const text = `Balance: ${formatLky(bal, decimals)} LKY`;
    if (isGroup(ctx)) {
      const ok = await dm(ctx, text);
      if (!ok) {
        const mention = await botMention(ctx);
        const link = await botDeepLink(ctx);
        await ephemeralReply(
          ctx,
          link ? `Please DM me first: ${mention}` : "Please DM me first.",
          6000
        );
      }
    } else {
      await ctx.reply(text);
    }
    console.log("[/balance] ok]");
  } catch (e: any) {
    console.error("[/balance] ERR", e?.message || e);
    await ephemeralReply(
      ctx,
      "Balance temporarily unavailable, try again shortly.",
      6000
    );
  }
});

// ----- /tip ----- (optimized: fewer sequential awaits; fast username resolve)
bot.command("tip", async (ctx) => {
  console.log("[/tip] start");

  const from = await ensureUserCached(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  const replyTo =
    "reply_to_message" in (ctx.message ?? {})
      ? ctx.message!.reply_to_message?.from
      : undefined;

  // amount (last token)
  const amountStr = parts[parts.length - 1];
  if (!amountStr) {
    await ephemeralReply(
      ctx,
      "Usage: reply `/tip 1.23` OR `/tip @username 1.23`",
      6000,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let amount: bigint;
  try {
    amount = parseLkyToLites(amountStr);
  } catch (e: any) {
    await ephemeralReply(ctx, `Invalid amount: ${e.message}`, 6000);
    return;
  }
  if (!isValidTipAmount(amount)) {
    await ephemeralReply(ctx, "Amount too small.", 6000);
    return;
  }

  // resolve recipient (fast path for reply, otherwise cached username resolve)
  let targetUserId: number | null = null;
  let unameFromCmd: string | null = null;

  if (replyTo?.id) {
    targetUserId = Number(replyTo.id);
    await ensureUserCached(replyTo);
  } else if (parts.length >= 2 && parts[0].startsWith("@")) {
    unameFromCmd = parts[0];
    targetUserId = await resolveUserIdByUsername(ctx, unameFromCmd);
    if (!targetUserId) {
      const mention = await botMention(ctx);
      const link = await botDeepLink(ctx, `claim-${Date.now()}`);
      const unameClean = (unameFromCmd || "").replace(/^@/, "");
      const msg = link
        ? `User @${esc(
            unameClean
          )} hasn’t started the bot. Ask them to tap: ${link}`
        : `User @${esc(
            unameClean
          )} hasn’t started the bot yet. Find me at ${mention}.`;
      if (isGroup(ctx)) {
        const ok = await dm(ctx, msg);
        if (!ok) await ephemeralReply(ctx, msg, 8000);
      } else {
        await ctx.reply(msg);
      }
      return;
    }
  }

  if (targetUserId === ctx.from.id) {
    await ephemeralReply(ctx, "You can't tip yourself 🙂", 6000);
    return;
  }

  // ensure recipient exists (if not from replyTo branch)
  const to = replyTo
    ? await ensureUserCached(replyTo)
    : await ensureUserCached({
        id: targetUserId!,
        username: unameFromCmd?.replace(/^@/, "") || undefined,
      });

  // --- perform transfer & fetch has_started in parallel ---
  let needsStart = false;
  try {
    const xferP = transfer(from.id, to.id, amount);
    const startedP = query<{ has_started: boolean }>(
      "SELECT has_started FROM public.users WHERE id = $1",
      [to.id]
    );

    const [xferRes, startedRes] = await Promise.allSettled([xferP, startedP]);

    if (xferRes.status === "rejected") {
      const e = xferRes.reason as any;
      console.error("[/tip] ERR", e?.message || e);
      await ephemeralReply(ctx, `Tip failed: ${e?.message || e}`, 6000);
      return;
    }

    // write-through: keep cached balances hot
    adjustBalanceCache(from.id, -amount);
    adjustBalanceCache(to.id, amount);

    if (startedRes.status === "fulfilled") {
      needsStart =
        startedRes.value.rows[0]?.has_started === true ? false : true;
    } else {
      needsStart = false;
    }
  } catch (e: any) {
    console.error("[/tip] ERR", e?.message || e);
    await ephemeralReply(ctx, `Tip failed: ${e.message}`, 6000);
    return;
  }

  const pretty = formatLky(amount, decimals);
  const fromName =
    (ctx.from?.username && `@${ctx.from.username}`) ||
    ctx.from?.first_name ||
    "Someone";
  const toDisplay =
    (replyTo?.username && `@${replyTo.username}`) ||
    ((to as any).username && `@${(to as any).username}`) ||
    (unameFromCmd ? unameFromCmd : `user ${to.id}`);

  // Deep link encodes the intended recipient's Telegram ID if they haven't started yet
  const recipientTgId = replyTo?.id ?? targetUserId!;
  const deepLink = needsStart
    ? await botDeepLink(ctx, `claim-${recipientTgId}-${Date.now()}`)
    : "";

  // 1) reply to chat immediately (with optional START button) — HTML parse mode
  const lines = [
    `💸 ${esc(fromName)} tipped ${esc(pretty)} LKY to ${esc(toDisplay)}`,
    `HODL LuckyCoin for eternal good luck! 🍀`,
  ];
  if (needsStart) {
    lines.push(
      `👉 Credit is reserved. Press <b>START LKY TIPBOT</b> to activate your wallet and auto-claim.\n` +
        `After opening the chat, tap the big <b>Start</b> button.`
    );
  }

  const kb = needsStart && deepLink ? startKb(deepLink) : undefined;
  const extra: any = { parse_mode: "HTML" };
  if (kb) extra.reply_markup = kb.reply_markup;
  await ctx.reply(lines.join("\n"), extra);
  deleteAfter(ctx);

  // 2) background DM (non-blocking)
  const dmText = [
    `🎉 You’ve been tipped ${esc(pretty)} LKY by ${esc(fromName)}.`,
    needsStart
      ? `Tap <b>START LKY TIPBOT</b> below, then press <b>Start</b> in the chat to activate your wallet and auto-claim.`
      : `Check your holdings with /balance.`,
  ].join("\n");
  const dmExtra: any = { parse_mode: "HTML" };
  if (kb) dmExtra.reply_markup = kb.reply_markup;
  dmLater(ctx, recipientTgId, dmText, dmExtra);

  console.log("[/tip] ok (non-blocking DM)");
});

// ----- /withdraw -----
bot.command("withdraw", async (ctx) => {
  console.log("[/withdraw] start");
  const sender = await ensureUserCached(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  if (parts.length < 2) {
    const mention = await botMention(ctx);
    const link = await botDeepLink(ctx);
    const msg = "Usage: /withdraw <address> <amount>";
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(
          ctx,
          link ? `Please DM me first: ${mention}` : "Please DM me first.",
          6000
        );
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const toAddress = parts[0];
  let amount: bigint;
  try {
    amount = parseLkyToLites(parts[1]);
  } catch (e: any) {
    const msg = `Invalid amount: ${e.message}`;
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok) await ephemeralReply(ctx, "Please DM me first.", 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }
  if (!isValidTipAmount(amount)) {
    const msg = "Amount too small.";
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok) await ephemeralReply(ctx, "Please DM me first.", 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const bal = await getBalanceCached(sender.id); // cached read is fine
  if (bal < amount) {
    const msg = `Insufficient balance. You have ${formatLky(
      bal,
      decimals
    )} LKY.`;
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok) await ephemeralReply(ctx, "Please DM me first.", 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const v = await rpcTry<any>("validateaddress", [toAddress], 5000);
  if (v.ok && v.value && v.value.isvalid === false) {
    const msg = "Invalid address.";
    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok) await ephemeralReply(ctx, "Please DM me first.", 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const amtStr = formatLky(amount, 8);
  const send = await withRpcGate(() =>
    rpcTry<string>("sendtoaddress", [toAddress, Number(amtStr)], 15000)
  );

  if (!send.ok) {
    const errStr = String(send.err?.message || send.err || "unknown error");
    console.error("[/withdraw] RPC ERR:", errStr);

    const msg = isWalletBusy(send.err)
      ? "Wallet is busy. Try /withdraw again in a minute."
      : /invalid|address/i.test(errStr)
      ? "Invalid address."
      : /insufficient|fund/i.test(errStr)
      ? "Node wallet has insufficient funds."
      : `Withdraw failed: ${errStr}`;

    if (isGroup(ctx)) {
      const ok = await dm(ctx, msg);
      if (!ok) await ephemeralReply(ctx, "Please DM me first.", 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const txid = send.value;

  try {
    await query(
      `INSERT INTO public.withdrawals (user_id, to_address, amount_lites, txid, status, created_at)
       VALUES ($1,$2,$3,$4,'sent', NOW())
       ON CONFLICT (txid) DO NOTHING`,
      [sender.id, toAddress, amount.toString(), txid]
    );
  } catch (e: any) {
    console.error("[/withdraw] insert withdrawals ERR:", e?.message || e);
  }

  try {
    await debit(sender.id, amount, "withdrawal", txid);
    // write-through cache (sender spent funds)
    adjustBalanceCache(sender.id, -amount);
  } catch (e: any) {
    console.error("[/withdraw] debit ledger ERR:", e?.message || e);
  }

  const okMsg = `Withdrawal sent.\nAmount: ${amtStr} LKY\nAddress: \`${toAddress}\`\nTXID: \`${txid}\``;
  if (isGroup(ctx)) {
    await dm(ctx, okMsg, { parse_mode: "Markdown" });
  } else {
    await ctx.reply(okMsg, { parse_mode: "Markdown" });
  }

  console.log("[/withdraw] ok", txid);
});

// ---------- error & launch ----------
bot.catch((err) => console.error("Bot error", err));

bot.launch().then(async () => {
  await ensureSetup(); // indexes + has_started
  await getBotUsernameEnsured();
  console.log("Tipbot is running.");
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
