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

// ============================================
// Historical Trade Data Types
// ============================================

export interface HistoricalTrade {
  id: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
  maker: string;
  taker: string;
}

export interface PriceCandle {
  tokenId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;     // candle start
  period: '1m' | '5m' | '15m' | '1h' | '1d';
}

export interface MarketHistory {
  marketId: string;
  trades: HistoricalTrade[];
  candles: PriceCandle[];
  vwap: number;                    // volume-weighted average price
  totalVolume24h: number;
  tradeCount24h: number;
  priceChange24h: number;          // percentage
  highPrice24h: number;
  lowPrice24h: number;
  lastUpdated: number;
}

export interface VolumeProfile {
  priceLevel: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

// ============================================
// Market Resolution Types
// ============================================

export type ResolutionStatus = 'ACTIVE' | 'PENDING_RESOLUTION' | 'RESOLVED' | 'DISPUTED';

export interface MarketResolution {
  marketId: string;
  conditionId: string;
  question: string;
  status: ResolutionStatus;
  resolvedAt?: number;
  winningOutcome?: string;         // "Yes" or "No"
  winningTokenId?: string;
  payoutPerShare?: number;         // typically 1.0 for winner, 0 for loser
  resolutionSource?: string;
  lastChecked: number;
}

export interface ResolutionEvent {
  marketId: string;
  previousStatus: ResolutionStatus;
  newStatus: ResolutionStatus;
  winningOutcome?: string;
  timestamp: number;
  pnlImpact?: number;             // realized P&L from resolution
}

export interface PositionResolutionResult {
  marketId: string;
  position: Position;
  resolution: MarketResolution;
  realizedPnl: number;
  isWinner: boolean;
}
