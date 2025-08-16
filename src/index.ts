import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { ensureUser, balanceLites, transfer, findUserByUsername } from './ledger.js';
import { rpc } from './rpc.js';
import { parseLkyToLites, formatLky, isValidTipAmount } from './util.js';
import { query } from './db.js';

const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");

const bot = new Telegraf(botToken);

bot.start(async (ctx) => {
  await ensureUser(ctx.from);
  await ctx.reply(`Welcome, ${ctx.from.first_name || "friend"}!\nUse /help for commands.`);
});

bot.help(async (ctx) => {
  await ctx.reply([
    "*Commands*",
    "/deposit — get your LKY deposit address",
    "/balance — show your internal balance",
    "/tip — reply with `/tip 1.23` or `/tip @username 1.23`",
    "/withdraw <address> <amount> — withdraw on-chain"
  ].join("\n"), { parse_mode: "Markdown" });
});

bot.command("deposit", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const prev = await query<{address: string}>(
    "SELECT address FROM wallet_addresses WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [user.id]
  );
  if (prev.rows.length) {
    await ctx.reply(`Your LKY deposit address:\n${prev.rows[0].address}\n(Reusing your last address)`);
    return;
  }
  const label = String(ctx.from.id);
  const addr = await rpc<string>("getnewaddress", [label]);
  await query("INSERT INTO wallet_addresses (user_id, address, label) VALUES ($1,$2,$3)", [user.id, addr, label]);
  await ctx.reply(`Your LKY deposit address:\n${addr}`);
});

bot.command("balance", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const bal = await balanceLites(user.id);
  const decimals = Number(process.env.DEFAULT_DISPLAY_DECIMALS ?? "8");
  await ctx.reply(`Balance: ${formatLky(bal, decimals)} LKY`);
});

bot.command("tip", async (ctx) => {
  await ensureUser(ctx.from);
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  parts.shift();

  let targetUserId: number | null = null;

  if ("reply_to_message" in ctx.message && ctx.message.reply_to_message?.from?.id) {
    targetUserId = ctx.message.reply_to_message.from.id;
  } else if (parts.length >= 2 && parts[0].startsWith("@")) {
    const uname = parts[0].slice(1);
    const target = await findUserByUsername(uname);
    if (target) targetUserId = Number(target.tg_user_id);
  }

  const amountStr = parts[parts.length - 1];
  if (!amountStr) {
    await ctx.reply("Usage: reply `/tip 1.23` OR `/tip @username 1.23`", { parse_mode: "Markdown" });
    return;
  }

  let amount: bigint;
  try {
    amount = parseLkyToLites(amountStr);
  } catch (e: any) {
    await ctx.reply(`Invalid amount: ${e.message}`);
    return;
  }
  if (!isValidTipAmount(amount)) {
    await ctx.reply("Amount too small.");
    return;
  }
  if (!targetUserId) {
    await ctx.reply("Who are you tipping? Reply to someone or use @username (they must have used the bot before).");
    return;
  }
  if (targetUserId === ctx.from.id) {
    await ctx.reply("You can't tip yourself 🙂");
    return;
  }

  const from = await ensureUser(ctx.from);
  const to = await ensureUser({ id: targetUserId });

  try {
    await transfer(from.id, to.id, amount);
  } catch (e: any) {
    await ctx.reply(`Tip failed: ${e.message}`);
    return;
  }

  const decimals = Number(process.env.DEFAULT_DISPLAY_DECIMALS ?? "8");
  await ctx.reply(`Sent ${formatLky(amount, decimals)} LKY to ${to.username ? "@"+to.username : "user " + to.id}`);
});

bot.command("withdraw", async (ctx) => {
  const user = await ensureUser(ctx.from);
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  if (parts.length < 3) {
    await ctx.reply("Usage: /withdraw <address> <amount>");
    return;
  }
  const [, address, amountStr] = parts;

  let amount: bigint;
  try {
    amount = parseLkyToLites(amountStr);
  } catch (e: any) {
    await ctx.reply(`Invalid amount: ${e.message}`);
    return;
  }
  const bal = await balanceLites(user.id);
  if (bal < amount) {
    await ctx.reply("Insufficient balance.");
    return;
  }

  try {
    const txid = await rpc<string>("sendtoaddress", [address, Number(amount) / 1e8]);
    await query("BEGIN");
    await query("INSERT INTO withdrawals (user_id, to_address, amount_lites, status, txid) VALUES ($1,$2,$3,$4,$5)",
      [user.id, address, String(amount), "sent", txid]);
    await query("INSERT INTO ledger (user_id, delta_lites, reason, ref) VALUES ($1,$2,$3,$4)",
      [user.id, String(-amount), "withdrawal", txid]);
    await query("COMMIT");
    await ctx.reply(`Withdrawal sent. txid: ${txid}`);
  } catch (e: any) {
    await query("ROLLBACK").catch(() => {});
    await ctx.reply(`Withdrawal failed: ${e.message}`);
  }
});

bot.catch((err, ctx) => {
  console.error("Bot error", err);
});

bot.launch().then(() => {
  console.log("Tipbot is running.");
});
