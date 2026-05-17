// ============================================
// Core Types for Polymarket BTC 5M Trader
// ============================================

export interface SpotPrice {
  source: 'binance' | 'coinbase' | 'aggregate';
  price: number;
  timestamp: number;
}

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  tokens: MarketToken[];
  active: boolean;
  closed: boolean;
  endDate: string;
  volume: number;
  liquidity: number;
}

export interface MarketToken {
  tokenId: string;
  outcome: string; // "Yes" or "No"
  price: number;   // 0 to 1
  winner: boolean;
}

export interface OrderbookEntry {
  price: number;
  size: number;
}

export interface Orderbook {
  market: string;
  assetId: string;
  bids: OrderbookEntry[];
  asks: OrderbookEntry[];
  timestamp: number;
}

export interface TradeSignal {
  market: PolymarketMarket;
  side: 'BUY' | 'SELL';
  tokenId: string;
  outcome: string;
  spotPrice: number;
  impliedPrice: number;
  divergence: number;        // percentage divergence
  confidence: number;        // 0-1 confidence score
  suggestedSize: number;     // USDC
  suggestedPrice: number;    // limit price
  reason: string;
  timestamp: number;
}

export interface Order {
  id?: string;
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  type: 'LIMIT' | 'MARKET';
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
}

export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'FAILED';

export interface Position {
  market: string;
  tokenId: string;
  outcome: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: number;
}

export interface RiskState {
  totalExposure: number;
  openPositions: number;
  dailyPnl: number;
  dailyTradeCount: number;
  isHalted: boolean;
  haltReason?: string;
}

export interface TradeLog {
  id: string;
  signal: TradeSignal;
  order: Order;
  executedAt: number;
  result: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  pnl?: number;
  notes?: string;
}

export interface BotStatus {
  running: boolean;
  uptime: number;
  lastCycle: number;
  lastTrade?: TradeLog;
  riskState: RiskState;
  spotPrice: SpotPrice;
  activeMarkets: number;
  openOrders: number;
}
