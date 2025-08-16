# LuckyCoin (LKY) Telegram Tipbot

A minimal, production-minded **Telegram tipping bot** for **LuckyCoin (scrypt, Litecoin fork)**.

## Features
- `/deposit` — gives a user-specific LKY address (label = Telegram user id).
- `/balance` — shows your internal balance.
- `/tip` — tip someone by replying to their message or using `@username`.
- `/withdraw <address> <amount>` — withdraw to an on-chain address.
- Background **deposit monitor** polls `listtransactions` and credits confirmed deposits.

## Stack
- **Node 20 + TypeScript**
- **Telegraf** for Telegram
- **PostgreSQL** for balances & audit (append-only ledger)
- **LuckyCoin JSON-RPC** for addresses and withdrawals

## Quickstart (Windows)
1. Install Node (includes npm):
   - PowerShell: `winget install OpenJS.NodeJS.LTS` (or download from nodejs.org)
2. Restart VS Code (so PATH updates).
3. Copy `.env.example` → `.env` and fill values.
4. In VS Code Terminal:
   ```powershell
   cd "<repo path>"
   npm install
   npm run db:migrate
   npm run dev:bot
   npm run dev:worker
   ```

If PowerShell blocks npm (`npm.ps1 cannot be loaded`), either:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```
or use the CMD shim:
```powershell
npm.cmd install
```

## Docker (optional)
This repo includes a `docker-compose.yml` for Postgres + (bot, worker). It assumes your LuckyCoin node runs outside the compose network and is reachable via `LKY_RPC_URL`.
```sh
docker compose up --build -d
```

## Environment (.env)
```
# Telegram
BOT_TOKEN=123456:ABC-xyz

# Postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/tipbot

# LuckyCoin RPC
LKY_RPC_URL=http://127.0.0.1:9918/
LKY_RPC_USER=botrpc
LKY_RPC_PASS=superlongrandom

# Deposit confirmations
MIN_CONFIRMATIONS=6

# Display decimals
DEFAULT_DISPLAY_DECIMALS=8
```

## LuckyCoin node (example `luckycoin.conf`)
```
server=1
rpcuser=botrpc
rpcpassword=superlongrandom
rpcallowip=127.0.0.1
rpcport=9918
txindex=1
```

## Commands
- **/start**, **/help**
- **/deposit**
- **/balance**
- **/tip** — reply `/tip 1.23` or `/tip @username 1.23`
- **/withdraw <address> <amount>**

---

**Have fun and tip responsibly 🤝**
