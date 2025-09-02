// src/index.ts
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { rpc } from "./rpc.js";
import { query } from "./db.js";
import {
  ensureUser,
  balanceLites,
  transfer,
  findUserByUsername,
  debit, // 👈 used for withdrawal ledger debit
} from "./ledger.js";
import { parseLkyToLites, formatLky, isValidTipAmount } from "./util.js";

// ---------- bot init ----------
const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");
const bot = new Telegraf(botToken);

// ---------- small helpers ----------
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

// DM a specific user id
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

// ---------- robust RPC helpers ----------
type RpcErr = { code?: number; message?: string };
const isWalletBusy = (e: any) =>
  /rescanning|loading wallet|loading block|resource busy|database is locked/i.test(
    String(e?.message || e)
  ) ||
  e?.code === -4 ||
  e?.code === -28;

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

// ---------- fast /deposit address resolution ----------
async function getFastDepositAddress(
  userId: number,
  tgUserId: number
): Promise<string> {
  // 0) reuse from DB if present
  const prev = await query<{ address: string }>(
    "SELECT address FROM public.wallet_addresses WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (prev.rows[0]?.address) return prev.rows[0].address;

  const label = String(tgUserId);
  const remember = async (addr: string) => {
    try {
      await query(
        `INSERT INTO public.wallet_addresses (user_id, address, label)
         VALUES ($1,$2,$3)
         ON CONFLICT (address) DO NOTHING`,
        [userId, addr, label]
      );
    } catch {}
    return addr;
  };

  // 1) Newer (labels)
  {
    const r = await rpcTry<Record<string, unknown>>(
      "getaddressesbylabel",
      [label],
      4000
    );
    if (r.ok) {
      const existing = Object.keys(r.value || {})[0];
      if (existing) return remember(existing);
    }
  }

  // 2) Legacy: list addresses by account
  {
    const r = await rpcTry<string[]>("getaddressesbyaccount", [label], 4000);
    if (r.ok && Array.isArray(r.value) && r.value[0]) {
      return remember(r.value[0]);
    }
  }

  // 3) Legacy: default address for account
  {
    const r = await rpcTry<string>("getaccountaddress", [label], 6000);
    if (r.ok && r.value) return remember(r.value);
  }

  // 4) Fallback: mint new address (retry once if busy)
  {
    const attempt = async () => rpcTry<string>("getnewaddress", [label], 8000);
    let r = await attempt();
    if (!r.ok && isWalletBusy(r.err)) {
      await new Promise((res) => setTimeout(res, 800));
      r = await attempt();
    }
    if (r.ok && r.value) return remember(r.value);
  }

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
      ? "\n_Use /deposit, /balance, /withdraw in DM for privacy._"
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

// ----- /deposit -----
bot.command("deposit", async (ctx) => {
  console.log("[/deposit] start", ctx.from?.id, ctx.chat?.id);
  const user = await ensureUser(ctx.from);
  try {
    const addr = await getFastDepositAddress(user.id, ctx.from.id);
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
    const msg =
      isWalletBusy(e) || /DEPOSIT_ADDR_FAILED/.test(String(e))
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

// ----- /balance -----
bot.command("balance", async (ctx) => {
  console.log("[/balance] start", ctx.from?.id, ctx.chat?.id);
  try {
    const user = await ensureUser(ctx.from);
    const bal = await balanceLites(user.id);
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

  // Ensure sender is up-to-date (captures username changes on every tip)
  const from = await ensureUser(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  // Full Telegram "recipient" if we have a reply
  const replyTo =
    "reply_to_message" in ctx.message
      ? ctx.message.reply_to_message?.from
      : undefined;

  let targetUserId: number | null = null;
  let targetUsernameFromCmd: string | null = null;

  if (replyTo?.id) {
    targetUserId = replyTo.id;
  } else if (parts.length >= 2 && parts[0].startsWith("@")) {
    targetUsernameFromCmd = parts[0].slice(1);
    const target = await findUserByUsername(targetUsernameFromCmd);
    if (target) targetUserId = Number(target.tg_user_id);
  }

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
  if (!targetUserId) {
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

  // Ensure recipient — pass the FULL replyTo object if present (so username updates)
  const to = await ensureUser(
    replyTo
      ? replyTo
      : { id: targetUserId, username: targetUsernameFromCmd || undefined }
  );

  // Execute transfer
  try {
    await transfer(from.id, to.id, amount);
  } catch (e: any) {
    console.error("[/tip] ERR", e?.message || e);
    await ephemeralReply(ctx, `Tip failed: ${e.message}`, 6000);
    return;
  }

  const pretty = formatLky(amount, decimals);

  // Human-friendly names
  const fromName = ctx.from?.username
    ? `@${ctx.from.username}`
    : ctx.from?.first_name || "Someone";

  const toDisplayFromReply = replyTo?.username ? `@${replyTo.username}` : null;
  const toDisplayFromDb = (to as any).username
    ? `@${(to as any).username}`
    : `user ${to.id}`;
  let toDisplay = toDisplayFromReply || toDisplayFromDb;

  // Heuristic: started if we have username in DB; try DM once to confirm
  let hasStarted = !!(to as any).username;

  const botUser = getBotUsername();
  const deepLink = botUser
    ? `https://t.me/${botUser}?start=claim-${Date.now()}`
    : "";

  const tipper = fromName;
  const dmText = [
    `🎉 You’ve been tipped ${pretty} LKY by ${tipper}.`,
    `Tap “Start” to activate your wallet and claim it.`,
  ].join("\n");

  if (isGroup(ctx)) {
    await tryDelete(ctx);

    if (!hasStarted) {
      const dmOk = await dmUser(
        ctx,
        replyTo?.id ?? to.id,
        dmText,
        deepLink
          ? Markup.inlineKeyboard([
              [Markup.button.url("Start the bot", deepLink)],
            ])
          : undefined
      );
      if (dmOk) hasStarted = true;
    }

    const lines = [
      `💸 ${fromName} tipped ${pretty} LKY to ${toDisplay}`,
      `HODL LuckyCoin for eternal good luck! 🍀`,
    ];

    const extra: any = { parse_mode: "Markdown" };
    if (!hasStarted && deepLink) {
      lines.push(`🤖 Recipient must *Start* the bot to receive the DM.`);
      extra.reply_markup = Markup.inlineKeyboard([
        [Markup.button.url("Start bot to claim", deepLink)],
      ]);
    }
    await ctx.reply(lines.join("\n"), extra);
  } else {
    await ctx.reply(`Sent ${pretty} LKY to ${toDisplay}`);
    if (!hasStarted && deepLink) {
      await dmUser(
        ctx,
        replyTo?.id ?? to.id,
        dmText,
        Markup.inlineKeyboard([[Markup.button.url("Start the bot", deepLink)]])
      );
    }
  }
  console.log("[/tip] ok");
});

// ----- /withdraw -----
// Usage: /withdraw <address> <amount>
bot.command("withdraw", async (ctx) => {
  console.log("[/withdraw] start");
  const sender = await ensureUser(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift(); // remove '/withdraw'

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

  // Check balance
  const bal = await balanceLites(sender.id);
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

  // Validate address (best-effort; if node lacks the method, continue)
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

  // Send on-chain (LuckyCoin nodes expect amount in LKY float)
  const amtStr = formatLky(amount, 8); // "1.23456789"
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

  // Record withdrawal row + debit ledger (idempotent via UNIQUE + our ledger constraint)
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
