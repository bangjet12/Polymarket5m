import axios from 'axios';
import { config } from '../config';
import { SpotPrice, TradeSignal } from '../types';
import { SpotPriceFeed } from '../feeds/spotPrice';
import { logger } from '../utils/logger';

/**
 * Momentum Filter Module
 * 
 * Only allows trades that align with BTC's current momentum direction.
 * Checks 1H and 4H timeframe trends from Binance klines.
 * 
 * Logic:
 * - BUY YES signals require BTC uptrend (bullish momentum)
 * - SELL YES / BUY NO signals require BTC downtrend (bearish momentum)
 * - Neutral momentum = allow trade with reduced confidence
 * 
 * This prevents counter-trend trades that have lower win probability.
 */

interface MomentumData {
  trend1H: TrendDirection;
  trend4H: TrendDirection;
  strength: number;          // 0-1, how strong is the trend
  rsi14: number;             // RSI 14-period
  ema9: number;              // 9-period EMA
  ema21: number;             // 21-period EMA
  priceChange1H: number;     // % change in 1 hour
  priceChange4H: number;     // % change in 4 hours
  lastUpdated: number;
}

type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MomentumFilter {
  private cachedMomentum: MomentumData | null = null;
  private readonly cacheLifetimeMs = 60 * 1000; // refresh every 1 minute

  /**
   * Check if a trade signal aligns with current momentum
   * Returns { allowed, multiplier, reason }
   */
  async checkMomentumAlignment(signal: TradeSignal): Promise<{
    allowed: boolean;
    confidenceMultiplier: number;
    reason: string;
  }> {
    const momentum = await this.getMomentum();

    // Determine required trend direction based on signal
    const requiredTrend: TrendDirection = signal.side === 'BUY' && signal.outcome === 'Yes'
      ? 'BULLISH'
      : signal.side === 'BUY' && signal.outcome === 'No'
        ? 'BEARISH'
        : signal.side === 'SELL'
          ? 'BEARISH'
          : 'BULLISH';

    // Check alignment
    const is1HAligned = momentum.trend1H === requiredTrend;
    const is4HAligned = momentum.trend4H === requiredTrend;
    const isNeutral1H = momentum.trend1H === 'NEUTRAL';
    const isNeutral4H = momentum.trend4H === 'NEUTRAL';

    // Both timeframes aligned = strong signal
    if (is1HAligned && is4HAligned) {
      return {
        allowed: true,
        confidenceMultiplier: 1.15 + (momentum.strength * 0.1), // up to 1.25x
        reason: `Strong momentum alignment: 1H=${momentum.trend1H}, 4H=${momentum.trend4H} (strength: ${(momentum.strength * 100).toFixed(0)}%)`,
      };
    }

    // One timeframe aligned, one neutral = moderate signal
    if ((is1HAligned && isNeutral4H) || (isNeutral1H && is4HAligned)) {
      return {
        allowed: true,
        confidenceMultiplier: 1.05,
        reason: `Partial momentum alignment: 1H=${momentum.trend1H}, 4H=${momentum.trend4H}`,
      };
    }

    // Both neutral = allow with no boost
    if (isNeutral1H && isNeutral4H) {
      return {
        allowed: true,
        confidenceMultiplier: 1.0,
        reason: 'Momentum neutral - no directional bias',
      };
    }

    // One aligned, one opposed = risky but allow with penalty
    if (is1HAligned && !is4HAligned && !isNeutral4H) {
      return {
        allowed: true,
        confidenceMultiplier: 0.85,
        reason: `Mixed signals: 1H aligned but 4H opposed (${momentum.trend4H})`,
      };
    }

    // Both opposed = REJECT trade
    if (!is1HAligned && !isNeutral1H && !is4HAligned && !isNeutral4H) {
      return {
        allowed: false,
        confidenceMultiplier: 0,
        reason: `Counter-trend trade blocked: 1H=${momentum.trend1H}, 4H=${momentum.trend4H} vs required ${requiredTrend}`,
      };
    }

    // Default: allow with slight penalty
    return {
      allowed: true,
      confidenceMultiplier: 0.9,
      reason: `Weak momentum alignment: 1H=${momentum.trend1H}, 4H=${momentum.trend4H}`,
    };
  }

  /**
   * Get current BTC momentum data
   */
  async getMomentum(): Promise<MomentumData> {
    // Return cached if fresh
    if (this.cachedMomentum && Date.now() - this.cachedMomentum.lastUpdated < this.cacheLifetimeMs) {
      return this.cachedMomentum;
    }

    try {
      // Fetch 1H and 4H klines from Binance
      const [klines1H, klines4H] = await Promise.all([
        this.fetchKlines('1h', 25),
        this.fetchKlines('4h', 25),
      ]);

      // Calculate indicators
      const trend1H = this.calculateTrend(klines1H);
      const trend4H = this.calculateTrend(klines4H);
      const rsi14 = this.calculateRSI(klines1H, 14);
      const ema9 = this.calculateEMA(klines1H.map(k => k.close), 9);
      const ema21 = this.calculateEMA(klines1H.map(k => k.close), 21);

      // Price changes
      const currentPrice = klines1H[klines1H.length - 1].close;
      const price1HAgo = klines1H[klines1H.length - 2]?.open || currentPrice;
      const price4HAgo = klines4H[klines4H.length - 2]?.open || currentPrice;
      const priceChange1H = ((currentPrice - price1HAgo) / price1HAgo) * 100;
      const priceChange4H = ((currentPrice - price4HAgo) / price4HAgo) * 100;

      // Trend strength (0-1)
      const strength = this.calculateTrendStrength(klines1H, klines4H);

      this.cachedMomentum = {
        trend1H,
        trend4H,
        strength,
        rsi14,
        ema9,
        ema21,
        priceChange1H,
        priceChange4H,
        lastUpdated: Date.now(),
      };

      logger.debug(`📈 Momentum: 1H=${trend1H} | 4H=${trend4H} | Strength=${(strength * 100).toFixed(0)}% | ` +
                   `RSI=${rsi14.toFixed(0)} | 1H Chg=${priceChange1H.toFixed(2)}%`);

      return this.cachedMomentum;
    } catch (error: any) {
      logger.warn(`Momentum fetch failed: ${error.message}`);
      // Return neutral fallback
      return this.cachedMomentum || {
        trend1H: 'NEUTRAL',
        trend4H: 'NEUTRAL',
        strength: 0,
        rsi14: 50,
        ema9: 0,
        ema21: 0,
        priceChange1H: 0,
        priceChange4H: 0,
        lastUpdated: Date.now(),
      };
    }
  }

  /**
   * Fetch klines from Binance
   */
  private async fetchKlines(interval: string, limit: number): Promise<Kline[]> {
    const response = await axios.get(`${config.feeds.binanceUrl}/klines`, {
      params: {
        symbol: 'BTCUSDT',
        interval,
        limit,
      },
      timeout: 5000,
    });

    return response.data.map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  /**
   * Determine trend direction from klines
   */
  private calculateTrend(klines: Kline[]): TrendDirection {
    if (klines.length < 5) return 'NEUTRAL';

    const closes = klines.map(k => k.close);
    const ema9 = this.calculateEMA(closes, 9);
    const ema21 = this.calculateEMA(closes, 21);
    const currentPrice = closes[closes.length - 1];

    // EMA crossover + price position
    const emaSpread = ((ema9 - ema21) / ema21) * 100;

    // Count higher highs and higher lows (last 5 candles)
    const recent = klines.slice(-5);
    let higherHighs = 0;
    let lowerLows = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].high > recent[i - 1].high) higherHighs++;
      if (recent[i].low < recent[i - 1].low) lowerLows++;
    }

    // Price above both EMAs + higher highs = bullish
    if (currentPrice > ema9 && ema9 > ema21 && emaSpread > 0.05) {
      return 'BULLISH';
    }

    // Price below both EMAs + lower lows = bearish
    if (currentPrice < ema9 && ema9 < ema21 && emaSpread < -0.05) {
      return 'BEARISH';
    }

    // Additional checks with higher highs/lows
    if (higherHighs >= 3 && emaSpread > 0) return 'BULLISH';
    if (lowerLows >= 3 && emaSpread < 0) return 'BEARISH';

    return 'NEUTRAL';
  }

  /**
   * Calculate trend strength (0-1) based on agreement between timeframes
   */
  private calculateTrendStrength(klines1H: Kline[], klines4H: Kline[]): number {
    const closes1H = klines1H.slice(-10).map(k => k.close);
    const closes4H = klines4H.slice(-5).map(k => k.close);

    // Measure consistency: how many candles are in the same direction
    let consistent1H = 0;
    for (let i = 1; i < closes1H.length; i++) {
      if ((closes1H[i] > closes1H[i - 1] && closes1H[closes1H.length - 1] > closes1H[0]) ||
          (closes1H[i] < closes1H[i - 1] && closes1H[closes1H.length - 1] < closes1H[0])) {
        consistent1H++;
      }
    }

    let consistent4H = 0;
    for (let i = 1; i < closes4H.length; i++) {
      if ((closes4H[i] > closes4H[i - 1] && closes4H[closes4H.length - 1] > closes4H[0]) ||
          (closes4H[i] < closes4H[i - 1] && closes4H[closes4H.length - 1] < closes4H[0])) {
        consistent4H++;
      }
    }

    const strength1H = consistent1H / (closes1H.length - 1);
    const strength4H = consistent4H / (closes4H.length - 1);

    return (strength1H * 0.4 + strength4H * 0.6); // weight 4H more
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  private calculateRSI(klines: Kline[], period: number): number {
    if (klines.length < period + 1) return 50;

    const closes = klines.map(k => k.close);
    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate Exponential Moving Average
   */
  private calculateEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return ema;
  }

  /**
   * Get RSI-based overbought/oversold signal
   */
  isOverbought(): boolean {
    return (this.cachedMomentum?.rsi14 || 50) > 70;
  }

  isOversold(): boolean {
    return (this.cachedMomentum?.rsi14 || 50) < 30;
  }

  getCachedMomentum(): MomentumData | null {
    return this.cachedMomentum;
  }
}
