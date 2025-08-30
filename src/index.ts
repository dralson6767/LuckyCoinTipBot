import "dotenv/config";
import { Telegraf } from "telegraf";
import { rpc } from "./rpc.js";
import { query } from "./db.js";
import {
  ensureUser,
  balanceLites,
  transfer,
  findUserByUsername,
} from "./ledger.js";
import { parseLkyToLites, formatLky, isValidTipAmount } from "./util.js";

const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");

// IMPORTANT: no handlerTimeout here (we want real errors, not p-timeout wrappers)
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
  } catch {
    return false;
  }
};

const decimals = Number(process.env.DEFAULT_DISPLAY_DECIMALS ?? "8");
let BOT_AT = "@";
const getBotAt = () => BOT_AT;

// ---------- fast /deposit address resolution ----------
async function getFastDepositAddress(
  userId: number,
  tgUserId: number
): Promise<string> {
  // 1) reuse from DB
  const prev = await query<{ address: string }>(
    "SELECT address FROM public.wallet_addresses WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (prev.rows[0]?.address) return prev.rows[0].address;

  const label = String(tgUserId);

  // 2) cheap lookup by label (4s)
  try {
    const map = await rpc<Record<string, unknown>>(
      "getaddressesbylabel",
      [label],
      4000
    );
    const found = Object.keys(map || {})[0];
    if (found) {
      await query(
        `INSERT INTO public.wallet_addresses (user_id, address, label)
         VALUES ($1,$2,$3) ON CONFLICT (address) DO NOTHING`,
        [userId, found, label]
      );
      return found;
    }
  } catch {
    // ignore → mint
  }

  // 3) mint (8s)
  const addr = await rpc<string>("getnewaddress", [label], 8000);
  await query(
    `INSERT INTO public.wallet_addresses (user_id, address, label)
     VALUES ($1,$2,$3) ON CONFLICT (address) DO NOTHING`,
    [userId, addr, label]
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
    const msg = "Wallet is busy. Try /deposit again in a minute.";
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

bot.command("balance", async (ctx) => {
  console.log("[/balance] start", ctx.from?.id, ctx.chat?.id);
  try {
    const user = await ensureUser(ctx.from);
    const bal = await balanceLites(user.id); // pure DB
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

bot.command("tip", async (ctx) => {
  console.log("[/tip] start");
  await ensureUser(ctx.from);

  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  let targetUserId: number | null = null;
  if (
    "reply_to_message" in ctx.message &&
    ctx.message.reply_to_message?.from?.id
  ) {
    targetUserId = ctx.message.reply_to_message.from.id;
  } else if (parts.length >= 2 && parts[0].startsWith("@")) {
    const uname = parts[0].slice(1);
    const target = await findUserByUsername(uname);
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

  const from = await ensureUser(ctx.from);
  const to = await ensureUser({ id: targetUserId });

  try {
    await transfer(from.id, to.id, amount);
  } catch (e: any) {
    console.error("[/tip] ERR", e?.message || e);
    await ephemeralReply(ctx, `Tip failed: ${e.message}`, 6000);
    return;
  }

  const pretty = formatLky(amount, decimals);
  if (isGroup(ctx)) {
    await tryDelete(ctx);
    const fromName = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "Someone";
    const toName = to.username ? `@${to.username}` : `user ${to.id}`;
    await ctx.reply(
      `💸 ${fromName} tipped ${pretty} LKY to ${toName}\nHODL LuckyCoin for eternal good luck! 🍀`
    );
  } else {
    await ctx.reply(
      `Sent ${pretty} LKY to ${
        to.username ? "@" + to.username : "user " + to.id
      }`
    );
  }
  console.log("[/tip] ok");
});

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
