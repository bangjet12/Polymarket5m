# ⚡ Polymarket BTC 5-Minute Trading Terminal

> Fully automated trading bot that detects BTC spot price vs Polymarket prediction market inefficiencies and executes trades instantly — 24/7, no emotion, no hesitation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TRADING ENGINE (5m loop)                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌────────────────────┐                │
│  │ SPOT PRICE   │    │ POLYMARKET CLIENT   │                │
│  │ FEED         │    │                    │                │
│  │              │    │ • Gamma API        │                │
│  │ • Binance    │    │ • CLOB Orderbook   │                │
│  │ • Coinbase   │    │ • WebSocket Stream │                │
│  │ • Aggregate  │    │                    │                │
│  └──────┬───────┘    └────────┬───────────┘                │
│         │                     │                             │
│         ▼                     ▼                             │
│  ┌─────────────────────────────────────┐                   │
│  │     INEFFICIENCY DETECTOR           │                   │
│  │                                     │                   │
│  │  spot_price vs implied_price        │                   │
│  │  → divergence calculation           │                   │
│  │  → fair value model (logistic)      │                   │
│  │  → confidence scoring               │                   │
│  └──────────────┬──────────────────────┘                   │
│                 │                                           │
│                 ▼                                           │
│  ┌──────────────────────────┐  ┌─────────────────────┐    │
│  │    RISK MANAGER          │  │   ORDER EXECUTOR    │    │
│  │                          │  │                     │    │
│  │  • Position limits       │──▶  • EIP-712 signing  │    │
│  │  • Daily loss limit      │  │  • CLOB submission  │    │
│  │  • Exposure control      │  │  • Order tracking   │    │
│  │  • Circuit breakers      │  │                     │    │
│  └──────────────────────────┘  └─────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────┐                   │
│  │     ALERTS & MONITORING             │                   │
│  │  • Telegram notifications           │                   │
│  │  • Trade logs (Winston)             │                   │
│  │  • P&L tracking                     │                   │
│  └─────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/bangjet12/Polymarket5m.git
cd Polymarket5m
npm install
```

### 2. Configure

```bash
cp .env.example .env
nano .env  # Fill in your API keys and wallet
```

**Required:**
- Polymarket API credentials (get from https://docs.polymarket.com)
- Ethereum wallet private key (funded on Polygon)
- USDC balance on Polygon for trading

### 3. Build & Run

```bash
npm run build
npm start
```

### 4. Deploy to VPS (24/7)

```bash
# Option A: PM2 (recommended)
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup

# Option B: Run full setup script
sudo bash deploy/setup-vps.sh
```

## How It Works

### Strategy

1. **Price Feed**: Fetches BTC/USD from Binance + Coinbase every 5 minutes
2. **Market Scan**: Finds active BTC prediction markets on Polymarket (e.g., "Will BTC be above $70,000 by June 30?")
3. **Fair Value**: Calculates theoretical probability using:
   - Distance from spot to strike
   - Time remaining until expiry
   - Recent BTC volatility
4. **Divergence**: Compares fair value vs market price
5. **Execute**: If divergence > threshold AND confidence > minimum → place order

### Example

```
BTC Spot:     $68,500
Market:       "BTC above $65,000 by June 30?"
Market Price: YES @ $0.72
Fair Value:   YES @ $0.88 (based on distance + time + vol)
Divergence:   16 percentage points
Action:       BUY YES @ $0.73 (limit)
```

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MIN_DIVERGENCE_THRESHOLD` | 2.0% | Minimum divergence to trigger trade |
| `MAX_DIVERGENCE_THRESHOLD` | 15.0% | Maximum (avoid stale data) |
| `TRADING_INTERVAL_MS` | 300000 | 5-minute cycle |
| `MAX_POSITION_SIZE` | $100 | Max USDC per trade |
| `MAX_TOTAL_EXPOSURE` | $1000 | Total max open exposure |
| `DAILY_LOSS_LIMIT` | $200 | Auto-halt if daily loss exceeds |
| `MIN_CONFIDENCE` | 0.7 | Minimum confidence to execute |

## Risk Management

- **Position Limits**: Max size per trade and total exposure cap
- **Daily Loss Circuit Breaker**: Auto-halts trading if daily loss exceeds limit
- **Max Open Positions**: Limits concurrent market exposure
- **Confidence Gating**: Only trades above minimum confidence threshold
- **Size Scaling**: Reduces position size when losing (conservative mode)
- **Auto-Resume**: Resets daily after day rollover

## Monitoring

### Telegram Alerts
Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` for:
- Trade execution notifications
- Risk alerts and circuit breaker events
- Hourly status updates
- Startup/shutdown notifications

### Logs
```bash
# Live logs
pm2 logs polymarket-btc-5m

# Log files
tail -f logs/trader.log
```

## Project Structure

```
src/
├── index.ts                    # Entry point
├── config/index.ts             # Configuration
├── types/index.ts              # TypeScript types
├── core/
│   └── tradingEngine.ts        # Main trading loop
├── feeds/
│   ├── spotPrice.ts            # BTC price from exchanges
│   └── polymarket.ts           # Polymarket API client
├── strategy/
│   └── inefficiencyDetector.ts # Divergence detection
├── execution/
│   └── orderExecutor.ts        # Order placement & signing
├── risk/
│   └── riskManager.ts          # Risk controls
└── utils/
    ├── logger.ts               # Winston logger
    └── alerts.ts               # Telegram notifications
```

## VPS Requirements

- **OS**: Ubuntu 22.04+ / Debian 12+
- **RAM**: 512MB minimum
- **CPU**: 1 vCPU sufficient
- **Network**: Stable internet (low latency to APIs)
- **Cost**: ~$5/month (DigitalOcean, Vultr, etc.)

## Disclaimer

⚠️ **This is experimental trading software. Use at your own risk.**
- Only trade with funds you can afford to lose
- Start with small position sizes
- Monitor the bot closely during initial operation
- Prediction markets carry unique risks including resolution uncertainty

## License

MIT
