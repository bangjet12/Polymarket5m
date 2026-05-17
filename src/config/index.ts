import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const config = {
  // Polymarket API
  polymarket: {
    apiKey: process.env.POLYMARKET_API_KEY || '',
    apiSecret: process.env.POLYMARKET_API_SECRET || '',
    apiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
    clobUrl: process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com',
    gammaUrl: process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
    wsUrl: process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  },

  // Wallet
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
    address: process.env.WALLET_ADDRESS || '',
  },

  // Spot Price Feeds
  feeds: {
    binanceUrl: process.env.BINANCE_API_URL || 'https://api.binance.com/api/v3',
    coinbaseUrl: process.env.COINBASE_API_URL || 'https://api.coinbase.com/v2',
  },

  // Strategy
  strategy: {
    minDivergence: parseFloat(process.env.MIN_DIVERGENCE_THRESHOLD || '2.0'),
    maxDivergence: parseFloat(process.env.MAX_DIVERGENCE_THRESHOLD || '15.0'),
    tradingIntervalMs: parseInt(process.env.TRADING_INTERVAL_MS || '300000'),
    orderType: (process.env.ORDER_TYPE || 'LIMIT') as 'LIMIT' | 'MARKET',
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.5'),
  },

  // Risk Management
  risk: {
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '100'),
    maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE || '1000'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '5'),
    dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT || '200'),
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.7'),
  },

  // Alerts
  alerts: {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/trader.log',
  },

  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
};
