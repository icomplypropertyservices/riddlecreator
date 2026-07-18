# RiddleCreator — pump.fun-style launcher for XRPL (mainnet, production)

Bonding curve token launcher with per-trade creator fees, Xaman signing, and automatic graduation to the XRPL native AMM. Defaults to **mainnet** (wss://xrplcluster.com).

## Architecture
XRPL mainnet has no smart contracts, so (like every live XRPL launcher) the curve runs server-side and every movement of value settles on-ledger:
- Each launch gets an issuer wallet + curve wallet, funded by your platform wallet after the creator pays the launch fee
- Users sign their own payments (Xaman or any wallet + tx hash) — the server never touches user keys
- Buys/sells verified on-ledger by tx hash, settled from the curve wallet, creator fee (1%) + platform fee (1%) paid on-ledger per trade
- At 5,000 XRP raised: AMMCreate (raised XRP + 200M tokens, 0.5% fee), issuer blackholed — supply fixed forever
- Wallet seeds AES-256-GCM encrypted at rest; SQLite (WAL); per-token mutex; idempotent payment processing; slippage protection with automatic on-ledger refunds; rate limiting + helmet

## Setup
```
npm install
cp .env.example .env   # fill MASTER_KEY and PLATFORM_SEED (see comments)
node server.js
```
Platform wallet needs enough XRP to fund launches (~7 XRP each, recovered from the 20 XRP launch fee). For Xaman signing, add XUMM_API_KEY/SECRET from apps.xumm.dev.

## Flows
**Launch**: POST /api/launch/invoice → creator pays fee to platform address with destination tag → POST /api/launch/:id/confirm with tx hash → wallets funded, supply minted, token live.

**Trade (Xaman)**: POST /api/tokens/:id/xaman/payload → user scans QR/signs → poll /xaman/confirm → server verifies txid, settles.

**Trade (any wallet)**: user sends XRP (buy) or tokens (sell) to the curve wallet, POST /api/tokens/:id/trade with the tx hash and optional minOut. Wrong/late payments (graduated, no trustline, slippage) are refunded on-ledger automatically.

## Deploy checklist
- Run behind HTTPS (nginx/Caddy reverse proxy), keep .env out of git, back up riddlecreator.db + MASTER_KEY together
- Never set TESTNET=1 in production (it enables faucet demo endpoints)
- To test first: TESTNET=1 XRPL_WSS=wss://s.altnet.rippletest.net:51233 node server.js
- Curve wallets custody raised XRP until graduation — treat the server + MASTER_KEY like a hot wallet
- Tune economics in curve.js (fees, graduation target, virtual reserves)
