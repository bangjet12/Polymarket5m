import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { PolymarketMarket, HistoricalTrade, TradeSignal } from '../types';
import { logger } from '../utils/logger';

/**
 * Whale / Smart Money Tracker
 * 
 * Monitors large transactions on Polymarket markets to detect
 * "smart money" activity that often precedes price movements.
 * 
 * Tracks:
 * - Large single trades (>$500 or top 5% by size)
 * - Whale address accumulation patterns
 * - Sudden volume spikes from single addresses
 * - Institutional-size positioning
 * 
 * When whales are buying the same direction as our signal → HIGH confidence
 * When whales are selling against our signal → REDUCE confidence
 */

interface WhaleActivity {
  marketId: string;
  tokenId: string;
  direction: 'BUY' | 'SELL';
  totalVolume: number;       // total whale volume in last window
  tradeCount: number;        // number of whale trades
  avgSize: number;           // average whale trade size
  largestTrade: number;      // single largest trade
  dominantSide: 'BUY' | 'SELL' | 'NEUTRAL';
  buyVolume: number;
  sellVolume: number;
  imbalance: number;         // buy_vol / total_vol (>0.5 = whale buying)
  timestamp: number;
}

interface WhaleSignal {
  aligned: boolean;          // do whales agree with our signal?
  confidenceMultiplier: number;
  whaleActivity: WhaleActivity | null;
  reason: string;
}

export class WhaleTracker {
  private client: AxiosInstance;
  private clobClient: AxiosInstance;
  private activityCache: Map<string, WhaleActivity> = new Map();
  private readonly cacheLifetimeMs = 3 * 60 * 1000; // 3 min cache
  private readonly whaleThresholdUsd = 500;          // $500+ = whale trade
  private readonly lookbackMinutes = 30;             // look at last 30 min

  constructor() {
    this.client = axios.create({
      baseURL: config.polymarket.gammaUrl,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.clobClient = axios.create({
      baseURL: config.polymarket.clobUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'POLY_API_KEY': config.polymarket.apiKey,
        'POLY_API_SECRET': config.polymarket.apiSecret,
        'POLY_PASSPHRASE': config.polymarket.apiPassphrase,
      },
    });
  }

  /**
   * Analyze whale activity for a trade signal
   * Returns confidence multiplier based on whale alignment
   */
  async analyzeWhaleActivity(signal: TradeSignal): Promise<WhaleSignal> {
    const tokenId = signal.tokenId;
    const marketId = signal.market.id;

    // Check cache
    const cached = this.activityCache.get(tokenId);
    if (cached && Date.now() - cached.timestamp < this.cacheLifetimeMs) {
      return this.evaluateAlignment(cached, signal);
    }

    try {
      // Fetch recent trades for this token
      const trades = await this.fetchRecentTrades(tokenId);

      if (trades.length === 0) {
        return { aligned: true, confidenceMultiplier: 1.0, whaleActivity: null, reason: 'No recent trade data' };
      }

      // Identify whale trades (top percentile by size)
      const whaleTrades = this.identifyWhaleTrades(trades);

      if (whaleTrades.length === 0) {
        return { aligned: true, confidenceMultiplier: 1.0, whaleActivity: null, reason: 'No whale activity detected' };
      }

      // Aggregate whale activity
      const activity = this.aggregateWhaleActivity(whaleTrades, marketId, tokenId);
      this.activityCache.set(tokenId, activity);

      return this.evaluateAlignment(activity, signal);
    } catch (error: any) {
      logger.debug(`Whale analysis failed for ${tokenId}: ${error.message}`);
      return { aligned: true, confidenceMultiplier: 1.0, whaleActivity: null, reason: `Analysis failed: ${error.message}` };
    }
  }

  /**
   * Fetch recent trades from CLOB API
   */
  private async fetchRecentTrades(tokenId: string): Promise<HistoricalTrade[]> {
    try {
      const response = await this.clobClient.get('/trades', {
        params: {
          asset_id: tokenId,
          limit: 200,
        },
      });

      const rawTrades = response.data || [];
      const cutoffTime = Date.now() - (this.lookbackMinutes * 60 * 1000);

      return rawTrades
        .map((t: any) => ({
          id: t.id || '',
          marketId: '',
          tokenId,
          side: t.side === 'BUY' || t.side === 0 ? 'BUY' as const : 'SELL' as const,
          price: parseFloat(t.price || '0'),
          size: parseFloat(t.size || t.amount || '0'),
          timestamp: t.timestamp ? new Date(t.timestamp).getTime() : Date.now(),
          maker: t.maker || t.maker_address || '',
          taker: t.taker || t.taker_address || '',
        }))
        .filter((t: HistoricalTrade) => t.timestamp > cutoffTime);
    } catch (error: any) {
      return [];
    }
  }

  /**
   * Identify whale trades from recent activity
   * Whale = trade size > $500 OR top 5% by volume
   */
  private identifyWhaleTrades(trades: HistoricalTrade[]): HistoricalTrade[] {
    if (trades.length === 0) return [];

    // Calculate trade values
    const tradeValues = trades.map(t => t.price * t.size);
    const sortedValues = [...tradeValues].sort((a, b) => b - a);

    // Dynamic threshold: max of fixed threshold OR top 5th percentile
    const percentileIndex = Math.floor(sortedValues.length * 0.05);
    const percentileThreshold = sortedValues[percentileIndex] || 0;
    const threshold = Math.max(this.whaleThresholdUsd, percentileThreshold);

    // Filter whale trades
    return trades.filter(t => (t.price * t.size) >= threshold);
  }

  /**
   * Aggregate whale trades into a summary
   */
  private aggregateWhaleActivity(
    whaleTrades: HistoricalTrade[],
    marketId: string,
    tokenId: string
  ): WhaleActivity {
    let buyVolume = 0;
    let sellVolume = 0;
    let buyCount = 0;
    let sellCount = 0;
    let largestTrade = 0;

    for (const trade of whaleTrades) {
      const value = trade.price * trade.size;
      largestTrade = Math.max(largestTrade, value);

      if (trade.side === 'BUY') {
        buyVolume += value;
        buyCount++;
      } else {
        sellVolume += value;
        sellCount++;
      }
    }

    const totalVolume = buyVolume + sellVolume;
    const imbalance = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

    let dominantSide: 'BUY' | 'SELL' | 'NEUTRAL';
    if (imbalance > 0.6) dominantSide = 'BUY';
    else if (imbalance < 0.4) dominantSide = 'SELL';
    else dominantSide = 'NEUTRAL';

    return {
      marketId,
      tokenId,
      direction: dominantSide === 'NEUTRAL' ? 'BUY' : dominantSide,
      totalVolume,
      tradeCount: whaleTrades.length,
      avgSize: totalVolume / whaleTrades.length,
      largestTrade,
      dominantSide,
      buyVolume,
      sellVolume,
      imbalance,
      timestamp: Date.now(),
    };
  }

  /**
   * Evaluate if whale activity aligns with our signal
   */
  private evaluateAlignment(activity: WhaleActivity, signal: TradeSignal): WhaleSignal {
    // No significant whale activity
    if (activity.tradeCount < 2 || activity.totalVolume < this.whaleThresholdUsd) {
      return {
        aligned: true,
        confidenceMultiplier: 1.0,
        whaleActivity: activity,
        reason: `Low whale activity: ${activity.tradeCount} trades, $${activity.totalVolume.toFixed(0)}`,
      };
    }

    // Check alignment: does whale dominant side match our signal?
    const signalBullish = signal.side === 'BUY';
    const whalesBullish = activity.dominantSide === 'BUY';
    const whalesNeutral = activity.dominantSide === 'NEUTRAL';

    let aligned: boolean;
    let confidenceMultiplier: number;
    let reason: string;

    if (whalesNeutral) {
      aligned = true;
      confidenceMultiplier = 1.0;
      reason = `Whale neutral: buy=$${activity.buyVolume.toFixed(0)} vs sell=$${activity.sellVolume.toFixed(0)}`;
    } else if (signalBullish === whalesBullish) {
      // Whales agree with us!
      aligned = true;
      const strength = Math.abs(activity.imbalance - 0.5) * 2; // 0-1
      confidenceMultiplier = 1.1 + (strength * 0.15); // up to 1.25x
      reason = `Whale CONFIRMS signal: ${activity.dominantSide} $${activity.totalVolume.toFixed(0)} (${activity.tradeCount} trades, imbalance: ${(activity.imbalance * 100).toFixed(0)}%)`;
    } else {
      // Whales disagree!
      aligned = false;
      const strength = Math.abs(activity.imbalance - 0.5) * 2;
      confidenceMultiplier = 0.8 - (strength * 0.15); // down to 0.65x
      reason = `Whale OPPOSES signal: ${activity.dominantSide} $${activity.totalVolume.toFixed(0)} (${activity.tradeCount} trades, imbalance: ${(activity.imbalance * 100).toFixed(0)}%)`;
    }

    logger.info(`🐋 Whale: ${reason}`);

    return {
      aligned,
      confidenceMultiplier: Math.max(0.6, Math.min(1.3, confidenceMultiplier)),
      whaleActivity: activity,
      reason,
    };
  }

  /**
   * Get cached whale activity for a token
   */
  getCachedActivity(tokenId: string): WhaleActivity | null {
    return this.activityCache.get(tokenId) || null;
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.activityCache.clear();
  }
}
