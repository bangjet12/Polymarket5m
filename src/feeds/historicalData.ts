import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import {
  HistoricalTrade,
  PriceCandle,
  MarketHistory,
  VolumeProfile,
} from '../types';
import { logger } from '../utils/logger';

/**
 * Historical Trade Data Feed
 * 
 * Fetches and analyzes historical trade data from Polymarket:
 * - Recent trades per market/token
 * - OHLCV candles (5m, 15m, 1h, 1d)
 * - VWAP calculation
 * - Volume profile analysis
 * - 24h statistics (volume, price change, high/low)
 * 
 * Used by InefficiencyDetector to improve confidence scoring
 * and validate signals against historical patterns.
 */
export class HistoricalDataFeed {
  private client: AxiosInstance;
  private clobClient: AxiosInstance;
  private marketHistories: Map<string, MarketHistory> = new Map();
  private readonly maxTradesCache = 500;

  constructor() {
    // Gamma API for market-level data
    this.client = axios.create({
      baseURL: config.polymarket.gammaUrl,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    // CLOB API for trade-level data
    this.clobClient = axios.create({
      baseURL: config.polymarket.clobUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'POLY_API_KEY': config.polymarket.apiKey,
        'POLY_API_SECRET': config.polymarket.apiSecret,
        'POLY_PASSPHRASE': config.polymarket.apiPassphrase,
      },
    });
  }

  /**
   * Fetch recent trades for a market token
   */
  async fetchRecentTrades(tokenId: string, limit: number = 100): Promise<HistoricalTrade[]> {
    try {
      const response = await this.clobClient.get('/trades', {
        params: {
          asset_id: tokenId,
          limit,
        },
      });

      const rawTrades = response.data || [];
      const trades: HistoricalTrade[] = rawTrades.map((t: any) => ({
        id: t.id || t.trade_id || `${t.timestamp}_${Math.random().toString(36).slice(2)}`,
        marketId: t.market || t.condition_id || '',
        tokenId: tokenId,
        side: t.side === 'BUY' || t.side === 0 ? 'BUY' : 'SELL',
        price: parseFloat(t.price || '0'),
        size: parseFloat(t.size || t.amount || '0'),
        timestamp: t.timestamp ? new Date(t.timestamp).getTime() : Date.now(),
        maker: t.maker || '',
        taker: t.taker || '',
      }));

      logger.debug(`Fetched ${trades.length} historical trades for token ${tokenId.slice(0, 8)}...`);
      return trades;
    } catch (error: any) {
      logger.warn(`Failed to fetch trades for ${tokenId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch trade history from Gamma API (market-level)
   */
  async fetchMarketTradeHistory(marketId: string): Promise<HistoricalTrade[]> {
    try {
      const response = await this.client.get(`/markets/${marketId}/trades`, {
        params: { limit: 200 },
      });

      const rawTrades = response.data || [];
      return rawTrades.map((t: any) => ({
        id: t.id || '',
        marketId: marketId,
        tokenId: t.asset_id || t.token_id || '',
        side: t.side === 'buy' || t.side === 'BUY' ? 'BUY' : 'SELL',
        price: parseFloat(t.price || '0'),
        size: parseFloat(t.size || t.amount || '0'),
        timestamp: t.created_at ? new Date(t.created_at).getTime() : parseInt(t.timestamp) || Date.now(),
        maker: t.maker_address || '',
        taker: t.taker_address || '',
      }));
    } catch (error: any) {
      logger.warn(`Failed to fetch market trade history for ${marketId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Build OHLCV candles from raw trade data
   */
  buildCandles(trades: HistoricalTrade[], period: '1m' | '5m' | '15m' | '1h' | '1d'): PriceCandle[] {
    if (trades.length === 0) return [];

    const periodMs: Record<string, number> = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
    };

    const interval = periodMs[period];
    const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    const candles: PriceCandle[] = [];

    let candleStart = Math.floor(sortedTrades[0].timestamp / interval) * interval;
    let currentCandle: PriceCandle | null = null;

    for (const trade of sortedTrades) {
      const tradeCandle = Math.floor(trade.timestamp / interval) * interval;

      if (tradeCandle !== candleStart || !currentCandle) {
        // Save previous candle
        if (currentCandle) candles.push(currentCandle);

        // Start new candle
        candleStart = tradeCandle;
        currentCandle = {
          tokenId: trade.tokenId,
          open: trade.price,
          high: trade.price,
          low: trade.price,
          close: trade.price,
          volume: trade.size * trade.price,
          timestamp: candleStart,
          period,
        };
      } else {
        // Update current candle
        currentCandle.high = Math.max(currentCandle.high, trade.price);
        currentCandle.low = Math.min(currentCandle.low, trade.price);
        currentCandle.close = trade.price;
        currentCandle.volume += trade.size * trade.price;
      }
    }

    // Push last candle
    if (currentCandle) candles.push(currentCandle);

    return candles;
  }

  /**
   * Calculate VWAP (Volume-Weighted Average Price)
   */
  calculateVWAP(trades: HistoricalTrade[]): number {
    if (trades.length === 0) return 0;

    let totalVolumePrice = 0;
    let totalVolume = 0;

    for (const trade of trades) {
      totalVolumePrice += trade.price * trade.size;
      totalVolume += trade.size;
    }

    return totalVolume > 0 ? totalVolumePrice / totalVolume : 0;
  }

  /**
   * Build volume profile (volume at each price level)
   */
  buildVolumeProfile(trades: HistoricalTrade[], bucketSize: number = 0.01): VolumeProfile[] {
    if (trades.length === 0) return [];

    const buckets: Map<number, VolumeProfile> = new Map();

    for (const trade of trades) {
      // Round price to bucket
      const level = Math.round(trade.price / bucketSize) * bucketSize;
      const key = parseFloat(level.toFixed(4));

      if (!buckets.has(key)) {
        buckets.set(key, {
          priceLevel: key,
          volume: 0,
          buyVolume: 0,
          sellVolume: 0,
        });
      }

      const bucket = buckets.get(key)!;
      const tradeVolume = trade.size * trade.price;
      bucket.volume += tradeVolume;

      if (trade.side === 'BUY') {
        bucket.buyVolume += tradeVolume;
      } else {
        bucket.sellVolume += tradeVolume;
      }
    }

    // Sort by price level
    return Array.from(buckets.values()).sort((a, b) => a.priceLevel - b.priceLevel);
  }

  /**
   * Get full market history (trades + candles + stats)
   */
  async getMarketHistory(marketId: string, tokenId: string): Promise<MarketHistory> {
    // Check cache (refresh every 5 minutes)
    const cached = this.marketHistories.get(marketId);
    if (cached && Date.now() - cached.lastUpdated < 5 * 60 * 1000) {
      return cached;
    }

    // Fetch fresh trades
    const trades = await this.fetchRecentTrades(tokenId, 200);

    // Build 5m candles
    const candles = this.buildCandles(trades, '5m');

    // Calculate VWAP
    const vwap = this.calculateVWAP(trades);

    // 24h stats
    const now = Date.now();
    const trades24h = trades.filter(t => now - t.timestamp < 24 * 60 * 60 * 1000);
    const totalVolume24h = trades24h.reduce((sum, t) => sum + t.size * t.price, 0);
    const tradeCount24h = trades24h.length;

    let priceChange24h = 0;
    let highPrice24h = 0;
    let lowPrice24h = 1;

    if (trades24h.length >= 2) {
      const oldest = trades24h[0].price;
      const newest = trades24h[trades24h.length - 1].price;
      priceChange24h = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;
      highPrice24h = Math.max(...trades24h.map(t => t.price));
      lowPrice24h = Math.min(...trades24h.map(t => t.price));
    }

    const history: MarketHistory = {
      marketId,
      trades: trades.slice(0, this.maxTradesCache),
      candles,
      vwap,
      totalVolume24h,
      tradeCount24h,
      priceChange24h,
      highPrice24h,
      lowPrice24h,
      lastUpdated: Date.now(),
    };

    this.marketHistories.set(marketId, history);
    logger.info(`📈 Market history updated: ${marketId.slice(0, 8)}... | ` +
                `Trades: ${tradeCount24h} (24h) | Vol: $${totalVolume24h.toFixed(0)} | ` +
                `VWAP: ${vwap.toFixed(4)} | Change: ${priceChange24h.toFixed(1)}%`);

    return history;
  }

  /**
   * Get price momentum indicator
   * Returns: -1 (strong down), 0 (neutral), +1 (strong up)
   */
  getPriceMomentum(marketId: string): number {
    const history = this.marketHistories.get(marketId);
    if (!history || history.candles.length < 3) return 0;

    const recent = history.candles.slice(-5);
    let upCandles = 0;
    let downCandles = 0;

    for (const candle of recent) {
      if (candle.close > candle.open) upCandles++;
      else if (candle.close < candle.open) downCandles++;
    }

    if (upCandles >= 4) return 1;
    if (downCandles >= 4) return -1;
    return 0;
  }

  /**
   * Detect unusual volume spike (potential signal amplifier)
   */
  hasVolumeSpike(marketId: string, threshold: number = 3.0): boolean {
    const history = this.marketHistories.get(marketId);
    if (!history || history.candles.length < 10) return false;

    const candles = history.candles;
    const lastCandle = candles[candles.length - 1];

    // Calculate average volume of previous candles
    const prevCandles = candles.slice(-11, -1);
    const avgVolume = prevCandles.reduce((sum, c) => sum + c.volume, 0) / prevCandles.length;

    // Check if last candle has significantly higher volume
    return avgVolume > 0 && lastCandle.volume > avgVolume * threshold;
  }

  /**
   * Get support/resistance levels from volume profile
   */
  getSupportResistance(marketId: string): { support: number; resistance: number } | null {
    const history = this.marketHistories.get(marketId);
    if (!history || history.trades.length < 20) return null;

    const profile = this.buildVolumeProfile(history.trades);
    if (profile.length < 3) return null;

    // Find highest volume level (POC - Point of Control)
    const poc = profile.reduce((max, p) => p.volume > max.volume ? p : max, profile[0]);

    // Current price approximation
    const lastTrade = history.trades[history.trades.length - 1];
    const currentPrice = lastTrade ? lastTrade.price : poc.priceLevel;

    // Support = highest volume level below current price
    const supportLevels = profile.filter(p => p.priceLevel < currentPrice);
    const support = supportLevels.length > 0
      ? supportLevels.reduce((max, p) => p.volume > max.volume ? p : max, supportLevels[0]).priceLevel
      : currentPrice * 0.95;

    // Resistance = highest volume level above current price
    const resistanceLevels = profile.filter(p => p.priceLevel > currentPrice);
    const resistance = resistanceLevels.length > 0
      ? resistanceLevels.reduce((max, p) => p.volume > max.volume ? p : max, resistanceLevels[0]).priceLevel
      : currentPrice * 1.05;

    return { support, resistance };
  }

  /**
   * Get cached market history without fetching
   */
  getCachedHistory(marketId: string): MarketHistory | null {
    return this.marketHistories.get(marketId) || null;
  }

  /**
   * Clear old cache entries
   */
  cleanCache(maxAgeMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [key, history] of this.marketHistories) {
      if (now - history.lastUpdated > maxAgeMs) {
        this.marketHistories.delete(key);
      }
    }
  }
}
