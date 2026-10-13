# PF Sizer (`pf-sizer`)

> High-performance order sizing, deduplication, and conditional cancellation bot for **Predict.fun** prediction markets on **BNB Chain**.

Auto-cancels duplicate orders, cleans up expired/cancelled markets, cancels orders right before expiry (`CANCEL_BEFORE_END_SECONDS`), cancels orders when live price TWAP breaches percentage delta thresholds (`CANCEL_THRES_<ASSET>`), and cancels opposite orders on fill (`CANCEL_OPPOSITE_ON_FILL`). Runs continuously in the background.

---

## Features

- **Predict.fun Native Integration**: Connects to Predict.fun REST API (`https://api.predict.fun/v1`) and WebSocket API (`wss://ws.predict.fun/ws`).
- **ZeroDev Kernel Smart Account & EOA Support**: Fully compatible with Privy exported wallets on BNB Chain (ZeroDev Kernel v0.3.1 EIP-712 wrapped digest authentication) as well as standard EOA wallets.
- **Proactive Sizing & Deduplication**: Discovers upcoming rolling 5m and 15m Up/Down contracts (`btc`, `eth`, `bnb`, `sol`, `xrp`, `doge`), groups resting orders by `(marketId, outcomeToken, price)`, keeps the oldest order, and cancels excess duplicate orders.
- **Conditional Bulk Cancellations**:
  - `DELETE_ALL_ORDERS`: Instantly cancel all orders for upcoming markets.
  - `DELETE_ALL_SLUGS`: Pattern-match slugs to delete (e.g. `btc-updown-5m`).
  - `DELETE_ALL_PRICES`: Delete all orders matching specific prices (e.g. `0.01,0.02`).
  - `DELETE_ALL_SIZES`: Delete all orders matching specific share sizes.
  - `POST_HOURS_<ASSET>_<DURATION>`: Restrict trading to specific UTC hours/minutes.
- **Pre-Expiry Auto-Cancel**: `CANCEL_BEFORE_END_SECONDS` automatically cancels orders $T-X$ seconds before market round close.
- **Opposite-Order Cancellation on Fill**: `CANCEL_OPPOSITE_ON_FILL` subscribes to real-time wallet events (`predictWalletEvents/{jwt}` with 15s heartbeat echo) and automatically wipes out opposite-outcome resting orders when an order fills.
- **TWAP / Price Deviation Watcher**: Real-time reference spot price feed synchronized with Binance Spot WebSocket (`data-stream.binance.vision`) with Cloudflare DoH. Cancels orders when market price moves beyond `CANCEL_THRES_<ASSET>` (e.g. $\pm 0.3\%$).
- **CLI Order Inspector**: `npm run fetch` quickly displays all open resting orders across markets with price, shares, USDT value, and outcome names.

---

## Architecture Overview

```
                                      ┌────────────────────────────────┐
                                      │       Predict.fun API          │
                                      │   (BNB Chain / CTF Exchange)   │
                                      └──────▲──────────────────▲──────┘
                                             │ REST             │ WebSocket
                                             │                  │
               ┌─────────────────────────────┴──────────────────┴─────────────────────────────┐
               │                                                                              │
               │                                 PF SIZER                                     │
               │                                                                              │
               │  ┌──────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐  │
               │  │      cleanup.js      │  │    fill-watcher.js   │  │   twap-watcher.js  │  │
               │  │  • 5m Loop Sizing    │  │  • predictWallet-    │  │  • Binance Spot    │  │
               │  │  • Deduplication     │  │    Events/{jwt}      │  │    Tick Stream     │  │
               │  │  • Pre-Expiry Cancel │  │  • Cancel opposite   │  │  • Rolling TWAP    │  │
               │  │  • POST_HOURS check  │  │    outcome on fill   │  │  • Delta Threshold │  │
               │  └──────────────────────┘  └──────────────────────┘  └────────────────────┘  │
               │                                                                              │
               └──────────────────────────────────────┬───────────────────────────────────────┘
                                                      │ EIP-712 Auth
                                      ┌───────────────▼────────────────┐
                                      │     ZeroDev Kernel Account     │
                                      │   (0xAe59... / Signer 0x34b...)│
                                      └────────────────────────────────┘
```

---

## Configuration (`.env`)

Create a `.env` file in the project root:

```env
# ─── Predict.fun Authentication ──────────────────────────────────────────────
# Private key of the signer EOA (exported from Privy or standalone wallet)
PREDICT_PRIVATE_KEY=0x...
# ZeroDev Kernel Smart Account address (Maker / Privy Account address)
# If maker != signer, ZeroDev Kernel wrapping is automatically enabled.
PREDICT_ACCOUNT_ADDRESS=0x...
# Predict.fun API Key (obtain from docs.predict.fun or dashboard)
PREDICT_API_KEY=your_predict_api_key

# ─── Target Markets (Active Timestamp Only) ──────────────────────────────────
# Targets the currently running candle round (e.g. btc-updown-5m, or btc-updown-15m)
ASSETS=btc-updown-5m
CANCEL_OPPOSITE_ON_FILL=true

# ─── Bulk & Precautionary Cancellations ──────────────────────────────────────
DELETE_ALL_ORDERS=false
DELETE_ALL_SLUGS=
DELETE_ALL_PRICES=
DELETE_ALL_SIZES=

# ─── Pre-Expiry Cancellation (Seconds Before Round End) ──────────────────────
# Example: 15 cancels all orders exactly 15 seconds before round expiry
CANCEL_BEFORE_END_SECONDS=15

# ─── TWAP Deviation Thresholds (% delta from round open price) ───────────────
CANCEL_THRES_BTC=0.3
CANCEL_THRES_ETH=0.4
CANCEL_THRES_BNB=0.5
CANCEL_THRES_SOL=0.6
CANCEL_THRES_XRP=0.6
CANCEL_THRES_DOGE=0.8

# ─── Allowed Trading Hours (UTC) ─────────────────────────────────────────────
# Format: comma-separated HH:MM. If empty/unset, all hours are allowed.
# POST_HOURS_BTC_5M=00:00,00:05,00:10
```

---

## Quick Start (Local Run)

### 1. Install Dependencies

```bash
npm install
```

### 2. Inspect Open Orders

Fetch and format all live resting orders currently on your Predict.fun account:

```bash
npm run fetch
```

### 3. Run the Sizer Bot

Starts proactive sizing, pre-expiry cancellation, TWAP monitoring, and fill watcher:

```bash
npm run start
```

### 4. Run Dedicated Watchers (Optional)

```bash
# Standalone opposite-order on fill watcher
npm run watch

# Standalone Binance spot TWAP deviation watcher
npm run twap-watch
```

---

## Deployment Guides

### Deploy on Fly.io (Single Machine)

1. **Install Flyctl**:
   ```bash
   # Windows (PowerShell)
   iwr https://fly.io/install.ps1 -useb | iex

   # macOS / Linux
   curl -L https://fly.io/install.sh | sh
   ```

2. **Authenticate & Launch**:
   ```bash
   fly auth login
   fly launch --no-deploy
   ```

3. **Set Secrets**:
   ```bash
   fly secrets set PREDICT_PRIVATE_KEY=0x... PREDICT_ACCOUNT_ADDRESS=0x... PREDICT_API_KEY=...
   ```

4. **Deploy**:
   ```bash
   fly deploy
   ```

---

### Deploy with PM2 (Linux VPS / Oracle Cloud / EC2)

1. **Install PM2**:
   ```bash
   sudo npm install -g pm2
   ```

2. **Start pf-sizer**:
   ```bash
   pm2 start src/cleanup.js --name "pf-sizer" --time
   ```

3. **Monitor Logs**:
   ```bash
   pm2 logs pf-sizer
   ```

4. **Save PM2 Startup**:
   ```bash
   pm2 save
   pm2 startup
   ```

---

## License

MIT
