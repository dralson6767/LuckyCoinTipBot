// src/index.ts
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { rpc } from "./rpc.js";
import { query, getBalanceLites } from "./db.js";
import { ensureUser, transfer, findUserByUsername, debit } from "./ledger.js";
import { parseLkyToLites, formatLky, isValidTipAmount } from "./util.js";

// ---------- bot init ----------
const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");
const bot = new Telegraf(botToken);

// ---------- helpers ----------
const isGroup = (ctx: any) =>
  ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup");

const tryDelete = async (ctx: any) => {
  try {
    if (isGroup(ctx) && ctx.message) await ctx.deleteMessage();
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

const dmUser = async (
  ctx: any,
  tgUserId: number,
  text: string,
  extra: any = {}
) => {
  try {
    await ctx.telegram.sendMessage(tgUserId, text, extra);
    return true;
  } catch (e: any) {
    console.error("[dmUser] failed:", e?.message || e);
    return false;
  }
};

const decimals = Number(process.env.DEFAULT_DISPLAY_DECIMALS ?? "8");
let BOT_AT = "@";
const getBotAt = () => BOT_AT;
const getBotUsername = () => (BOT_AT.startsWith("@") ? BOT_AT.slice(1) : "");

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hard timeout wrapper so /deposit always answers
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("DEPOSIT_TIMEOUT")), ms);
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

// ---------- /deposit address fast path (simplified + logged) ----------
async function getFastDepositAddress(
  userId: number,
  tgUserId: number
): Promise<string> {
  console.log("[deposit] start", { userId, tgUserId });

  // 0) reuse last address from DB if any
  const prev = await query<{ address: string }>(
    "SELECT address FROM public.wallet_addresses WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (prev.rows[0]?.address) {
    console.log("[deposit] reuse db addr");
    return prev.rows[0].address;
  }

  const label = String(tgUserId);
  const remember = async (addr: string) => {
    try {
      await query(
        `INSERT INTO public.wallet_addresses (user_id, address, label)
         VALUES ($1,$2,$3)
         ON CONFLICT (address) DO NOTHING`,
        [userId, addr, label]
      );
    } catch (e: any) {
      console.warn("[deposit] remember insert warn:", e?.message || e);
    }
    return addr;
  };

  // Prefer straight getnewaddress with label (fast path)
  console.log("[deposit] try getnewaddress(label)");
  {
    const r = await rpcTry<string>("getnewaddress", [label], 2500);
    if (r.ok && r.value) {
      console.log("[deposit] got address via label");
      return remember(r.value);
    }
    if (!r.ok)
      console.warn(
        "[deposit] getnewaddress(label) ERR:",
        r.err?.message || r.err
      );
  }

  // Fallback: getnewaddress without label (older daemons)
  console.log("[deposit] try getnewaddress()");
  {
    const r = await rpcTry<string>("getnewaddress", [], 2000);
    if (r.ok && r.value) {
      console.log("[deposit] got address via no-arg");
      return remember(r.value);
    }
    if (!r.ok)
      console.warn("[deposit] getnewaddress() ERR:", r.err?.message || r.err);
  }

  console.log("[deposit] failed all variants");
  throw new Error("DEPOSIT_ADDR_FAILED");
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
  await ensureUser(ctx.from);
  const msg = `Welcome, ${
    ctx.from.first_name || "friend"
  }!\nUse /help for commands.`;
  if (isGroup(ctx)) {
    await tryDelete(ctx);
    await dm(ctx, msg);
  } else {
    await ctx.reply(msg);
  }
});

bot.help(async (ctx) => {
  const text = [
    "*Commands*",
    "/deposit — get your LKY deposit address",
    "/balance — show your internal balance",
    "/tip — reply with `/tip 1.23` or `/tip @username 1.23`",
    "/withdraw <address> <amount> — withdraw on-chain",
    isGroup(ctx)
      ? "\n*Tip:* Use /deposit, /balance, /withdraw in DM for privacy."
      : "",
  ].join("\n");
  if (isGroup(ctx)) {
    await tryDelete(ctx);
    const ok = await dm(ctx, text, { parse_mode: "Markdown" });
    if (!ok)
      await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
  } else {
    await ctx.reply(text, { parse_mode: "Markdown" });
  }
});

// ---------- resolve @username not in DB ----------
async function resolveUserIdByUsername(ctx: any, unameRaw: string) {
  const uname = unameRaw.replace(/^@/, "");
  const inDb = await findUserByUsername(uname);
  if (inDb) return Number(inDb.tg_user_id);
  try {
    const chat = await ctx.telegram.getChat("@" + uname);
    if (chat?.id) {
      await ensureUser({ id: chat.id, username: uname }); // persist
      return Number(chat.id);
    }
  } catch {}
  return null;
}

// ----- /deposit -----
bot.command("deposit", async (ctx) => {
  console.log("[/deposit] start", ctx.from?.id, ctx.chat?.id);
  const user = await ensureUser(ctx.from);
  try {
    // hard-cap the whole sequence so the command always replies fast
    const addr = await withTimeout(
      getFastDepositAddress(user.id, ctx.from.id),
      6000
    );
    const msg = `Your LKY deposit address:\n\`${addr}\``;
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg, { parse_mode: "Markdown" });
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg, { parse_mode: "Markdown" });
    }
    console.log("[/deposit] ok");
  } catch (e: any) {
    console.error("[/deposit] ERR", e?.message || e);
    const msg = isWalletBusy(e)
      ? "Wallet is busy. Try /deposit again in a minute."
      : "Wallet temporarily unavailable. Try /deposit again shortly.";
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg);
    }
  }
});

// ----- /balance ----- (compact math)
bot.command("balance", async (ctx) => {
  console.log("[/balance] start", ctx.from?.id, ctx.chat?.id);
  try {
    const user = await ensureUser(ctx.from);
    const bal = await getBalanceLites(user.id); // transferred_tip_lites + deposits - withdrawals
    const text = `Balance: ${formatLky(bal, decimals)} LKY`;
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, text);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(text);
    }
    console.log("[/balance] ok");
  } catch (e: any) {
    console.error("[/balance] ERR", e?.message || e);
    await ephemeralReply(
      ctx,
      "Balance temporarily unavailable, try again shortly.",
      6000
    );
  }
});

// ----- /tip -----
bot.command("tip", async (ctx) => {
  console.log("[/tip] start");

  // keep sender fresh (captures username changes)
  const from = await ensureUser(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  const replyTo =
    "reply_to_message" in ctx.message
      ? ctx.message.reply_to_message?.from
      : undefined;

  // parse amount (last token)
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

  // determine recipient
  let targetUserId: number | null = null;
  let unameFromCmd: string | null = null;

  if (replyTo?.id) {
    targetUserId = Number(replyTo.id);
    // keep DB fresh for replied users
    await ensureUser(replyTo);
  } else if (parts.length >= 2 && parts[0].startsWith("@")) {
    unameFromCmd = parts[0].slice(1);
    targetUserId = await resolveUserIdByUsername(ctx, unameFromCmd);
    if (!targetUserId) {
      const botUser = getBotUsername();
      const deepLink = botUser
        ? `https://t.me/${botUser}?start=claim-${Date.now()}`
        : "";
      const msg = deepLink
        ? `User @${unameFromCmd} hasn’t started the bot. Ask them to tap: ${deepLink}`
        : `User @${unameFromCmd} hasn’t started the bot yet.`;
      if (isGroup(ctx)) {
        await tryDelete(ctx);
        const ok = await dm(ctx, msg);
        if (!ok) await ephemeralReply(ctx, msg, 8000);
      } else {
        await ctx.reply(msg);
      }
      return;
    }
  } else {
    await ephemeralReply(
      ctx,
      "Who are you tipping? Reply to someone or use @username.",
      6000
    );
    return;
  }

  if (targetUserId === ctx.from.id) {
    await ephemeralReply(ctx, "You can't tip yourself 🙂", 6000);
    return;
  }

  // ensure recipient exists (update username if we know it)
  const to = await ensureUser(
    replyTo
      ? replyTo
      : { id: targetUserId, username: unameFromCmd || undefined }
  );

  // do the transfer
  try {
    await transfer(from.id, to.id, amount);
  } catch (e: any) {
    console.error("[/tip] ERR", e?.message || e);
    await ephemeralReply(ctx, `Tip failed: ${e.message}`, 6000);
    return;
  }

  const pretty = formatLky(amount, decimals);

  // human display
  const fromName = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.first_name || "Someone";

  // reliable username display (no “user 48” when we have it)
  const toDisplay =
    (replyTo?.username && `@${replyTo.username}`) ||
    ((to as any).username && `@${(to as any).username}`) ||
    (unameFromCmd ? `@${unameFromCmd}` : `user ${to.id}`);

  // build deep link
  const botUser = getBotUsername();
  const deepLink = botUser
    ? `https://t.me/${botUser}?start=claim-${Date.now()}`
    : "";

  // always attempt one DM; if it fails, we show the start line & button
  const tipper = fromName;
  const dmText = [
    `🎉 You’ve been tipped ${pretty} LKY by ${tipper}.`,
    `Tap “Start” to activate your wallet and claim it.`,
  ].join("\n");

  const recipientId = replyTo?.id ?? targetUserId!;
  const dmOk = await dmUser(
    ctx,
    recipientId,
    dmText,
    deepLink
      ? Markup.inlineKeyboard([[Markup.button.url("Start the bot", deepLink)]])
      : undefined
  );

  if (isGroup(ctx)) {
    await tryDelete(ctx);

    const lines = [
      `💸 ${fromName} tipped ${pretty} LKY to ${toDisplay}`,
      `HODL LuckyCoin for eternal good luck! 🍀`,
    ];
    const extra: any = { parse_mode: "Markdown" };
    if (!dmOk && deepLink) {
      lines.push(`🤖 Recipient must *Start* the bot to receive the DM.`);
      extra.reply_markup = Markup.inlineKeyboard([
        [Markup.button.url("Start bot to claim", deepLink)],
      ]);
    }
    await ctx.reply(lines.join("\n"), extra);
  } else {
    await ctx.reply(`Sent ${pretty} LKY to ${toDisplay}`);
    if (!dmOk && deepLink) {
      await dmUser(
        ctx,
        recipientId,
        dmText,
        Markup.inlineKeyboard([[Markup.button.url("Start the bot", deepLink)]])
      );
    }
  }

  console.log("[/tip] ok");
});

// ----- /withdraw ----- (compact balance check)
bot.command("withdraw", async (ctx) => {
  console.log("[/withdraw] start");
  const sender = await ensureUser(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  if (parts.length < 2) {
    const msg = "Usage: /withdraw <address> <amount>";
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
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
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }
  if (!isValidTipAmount(amount)) {
    const msg = "Amount too small.";
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const bal = await getBalanceLites(sender.id);
  if (bal < amount) {
    const msg = `Insufficient balance. You have ${formatLky(
      bal,
      decimals
    )} LKY.`;
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const v = await rpcTry<any>("validateaddress", [toAddress], 5000);
  if (v.ok && v.value && v.value.isvalid === false) {
    const msg = "Invalid address.";
    if (isGroup(ctx)) {
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
    } else {
      await ctx.reply(msg);
    }
    return;
  }

  const amtStr = formatLky(amount, 8);
  const send = await rpcTry<string>(
    "sendtoaddress",
    [toAddress, Number(amtStr)],
    15000
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
      await tryDelete(ctx);
      const ok = await dm(ctx, msg);
      if (!ok)
        await ephemeralReply(ctx, `Please DM me first: ${getBotAt()}`, 6000);
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
  } catch (e: any) {
    console.error("[/withdraw] debit ledger ERR:", e?.message || e);
  }

  const okMsg = `Withdrawal sent.\nAmount: ${amtStr} LKY\nAddress: \`${toAddress}\`\nTXID: \`${txid}\``;
  if (isGroup(ctx)) {
    await tryDelete(ctx);
    await dm(ctx, okMsg, { parse_mode: "Markdown" });
  } else {
    await ctx.reply(okMsg, { parse_mode: "Markdown" });
  }

  console.log("[/withdraw] ok", txid);
});

// ---------- error & launch ----------
bot.catch((err) => console.error("Bot error", err));

bot.launch().then(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_AT = me?.username ? `@${me.username}` : "@";
  } catch {
    BOT_AT = "@";
  }
  console.log("Tipbot is running.");
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));
