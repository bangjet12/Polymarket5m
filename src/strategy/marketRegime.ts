import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Market Regime Detection
 * 
 * Classifies current BTC market conditions into regimes:
 * - TRENDING_UP:   Strong uptrend, ADX>25, higher highs
 * - TRENDING_DOWN: Strong downtrend, ADX>25, lower lows
 * - RANGING:       Sideways chop, ADX<20, price in tight band
 * - VOLATILE:      High volatility, wide ATR, unpredictable
 * - QUIET:         Very low volatility, tight Bollinger Bands
 * 
 * Each regime has different trading rules:
 * - TRENDING_UP:   Trade momentum (BUY YES for above-threshold markets)
 * - TRENDING_DOWN: Trade momentum (BUY NO / SELL YES)
 * - RANGING:       Trade mean-reversion (divergence closes)
 * - VOLATILE:      STOP trading (too random, high loss probability)
 * - QUIET:         Trade near-expiry only (low risk, predictable)
 * 
 * Uses Binance 1H klines to calculate:
 * - ADX (Average Directional Index) for trend strength
 * - ATR (Average True Range) for volatility
 * - Bollinger Band width for squeeze detection
 * - Rate of Change (ROC) for momentum
 */

export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'QUIET';

export interface RegimeAnalysis {
  regime: MarketRegime;
  confidence: number;         // 0-1, how confident in regime classification
  adx: number;                // 0-100, trend strength
  atr: number;                // absolute ATR value
  atrPercent: number;         // ATR as % of price
  bbWidth: number;            // Bollinger Band width (% of price)
  roc: number;                // Rate of change (%)
  tradingAllowed: boolean;    // should we trade in this regime?
  confidenceMultiplier: number; // apply to signal confidence
  maxPositionPercent: number;   // max % of capital per trade
  reason: string;
}

interface Kline {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export class MarketRegimeDetector {
  private cachedRegime: RegimeAnalysis | null = null;
  private readonly cacheLifetimeMs = 5 * 60 * 1000; // refresh every 5 min
  private regimeHistory: { regime: MarketRegime; timestamp: number }[] = [];

  /**
   * Get current market regime
   */
  async detectRegime(): Promise<RegimeAnalysis> {
    // Return cached if fresh
    if (this.cachedRegime && Date.now() - this.cachedRegime.confidence > 0 &&
        Date.now() - (this.regimeHistory[this.regimeHistory.length - 1]?.timestamp || 0) < this.cacheLifetimeMs) {
      return this.cachedRegime;
    }

    try {
      // Fetch 1H klines (50 candles = ~2 days)
      const klines = await this.fetchKlines('1h', 50);

      if (klines.length < 20) {
        return this.defaultRegime('Insufficient data');
      }

      // Calculate indicators
      const adx = this.calculateADX(klines, 14);
      const atr = this.calculateATR(klines, 14);
      const currentPrice = klines[klines.length - 1].close;
      const atrPercent = (atr / currentPrice) * 100;
      const bbWidth = this.calculateBBWidth(klines, 20, 2);
      const roc = this.calculateROC(klines, 12);

      // Classify regime
      const regime = this.classifyRegime(adx, atrPercent, bbWidth, roc);

      // Determine trading parameters for this regime
      const { tradingAllowed, confidenceMultiplier, maxPositionPercent, reason } =
        this.getRegimeRules(regime, adx, atrPercent);

      const analysis: RegimeAnalysis = {
        regime,
        confidence: this.calculateRegimeConfidence(adx, atrPercent, bbWidth),
        adx,
        atr,
        atrPercent,
        bbWidth,
        roc,
        tradingAllowed,
        confidenceMultiplier,
        maxPositionPercent,
        reason,
      };

      // Cache and record
      this.cachedRegime = analysis;
      this.regimeHistory.push({ regime, timestamp: Date.now() });
      if (this.regimeHistory.length > 100) this.regimeHistory.shift();

      logger.info(`🌡️ Market Regime: ${regime} | ADX=${adx.toFixed(0)} | ` +
                  `ATR=${atrPercent.toFixed(2)}% | BB=${bbWidth.toFixed(2)}% | ` +
                  `ROC=${roc.toFixed(2)}% | Trading: ${tradingAllowed ? 'YES' : 'BLOCKED'}`);

      return analysis;
    } catch (error: any) {
      logger.warn(`Regime detection failed: ${error.message}`);
      return this.cachedRegime || this.defaultRegime('Detection failed');
    }
  }

  /**
   * Classify market into regime based on indicators
   */
  private classifyRegime(adx: number, atrPercent: number, bbWidth: number, roc: number): MarketRegime {
    // VOLATILE: Very high ATR (>3%) regardless of trend
    if (atrPercent > 3.0) {
      return 'VOLATILE';
    }

    // QUIET: Very tight Bollinger Bands (<1.5%) and low ATR
    if (bbWidth < 1.5 && atrPercent < 1.0) {
      return 'QUIET';
    }

    // TRENDING: ADX > 25 indicates strong trend
    if (adx > 25) {
      if (roc > 0.5) return 'TRENDING_UP';
      if (roc < -0.5) return 'TRENDING_DOWN';
    }

    // Strong directional move even with moderate ADX
    if (adx > 20 && Math.abs(roc) > 1.5) {
      return roc > 0 ? 'TRENDING_UP' : 'TRENDING_DOWN';
    }

    // RANGING: Low ADX, moderate volatility
    if (adx < 20 && atrPercent < 2.5) {
      return 'RANGING';
    }

    // Default to RANGING if no clear signal
    return 'RANGING';
  }

  /**
   * Get trading rules for each regime
   */
  private getRegimeRules(regime: MarketRegime, adx: number, atrPercent: number): {
    tradingAllowed: boolean;
    confidenceMultiplier: number;
    maxPositionPercent: number;
    reason: string;
  } {
    switch (regime) {
      case 'TRENDING_UP':
        return {
          tradingAllowed: true,
          confidenceMultiplier: 1.15,  // boost for trending markets
          maxPositionPercent: 0.35,
          reason: `Uptrend (ADX=${adx.toFixed(0)}) - trade with momentum, boost BUY YES signals`,
        };

      case 'TRENDING_DOWN':
        return {
          tradingAllowed: true,
          confidenceMultiplier: 1.15,
          maxPositionPercent: 0.35,
          reason: `Downtrend (ADX=${adx.toFixed(0)}) - trade with momentum, boost BUY NO signals`,
        };

      case 'RANGING':
        return {
          tradingAllowed: true,
          confidenceMultiplier: 1.0,   // neutral
          maxPositionPercent: 0.25,
          reason: `Ranging market (ADX=${adx.toFixed(0)}) - mean-reversion trades, normal sizing`,
        };

      case 'VOLATILE':
        return {
          tradingAllowed: false,        // STOP trading!
          confidenceMultiplier: 0,
          maxPositionPercent: 0,
          reason: `HIGH VOLATILITY (ATR=${atrPercent.toFixed(1)}%) - trading PAUSED, too unpredictable`,
        };

      case 'QUIET':
        return {
          tradingAllowed: true,
          confidenceMultiplier: 1.05,
          maxPositionPercent: 0.20,     // smaller size in quiet markets
          reason: `Quiet market (BB=${atrPercent.toFixed(1)}%) - only near-expiry trades, small size`,
        };
    }
  }

  /**
   * Check if a signal direction aligns with the current regime
   */
  isSignalAlignedWithRegime(side: 'BUY' | 'SELL', outcome: string): {
    aligned: boolean;
    multiplier: number;
    reason: string;
  } {
    if (!this.cachedRegime) {
      return { aligned: true, multiplier: 1.0, reason: 'No regime data' };
    }

    const regime = this.cachedRegime.regime;
    const isBullishSignal = (side === 'BUY' && outcome === 'Yes') || (side === 'SELL' && outcome === 'No');

    switch (regime) {
      case 'TRENDING_UP':
        if (isBullishSignal) {
          return { aligned: true, multiplier: 1.15, reason: 'Signal aligned with uptrend' };
        } else {
          return { aligned: false, multiplier: 0.7, reason: 'Signal OPPOSES uptrend - penalized' };
        }

      case 'TRENDING_DOWN':
        if (!isBullishSignal) {
          return { aligned: true, multiplier: 1.15, reason: 'Signal aligned with downtrend' };
        } else {
          return { aligned: false, multiplier: 0.7, reason: 'Signal OPPOSES downtrend - penalized' };
        }

      case 'RANGING':
        return { aligned: true, multiplier: 1.0, reason: 'Ranging - all directions valid' };

      case 'VOLATILE':
        return { aligned: false, multiplier: 0, reason: 'Volatile regime - no trading' };

      case 'QUIET':
        return { aligned: true, multiplier: 0.9, reason: 'Quiet - small trades only' };
    }
  }

  /**
   * Get regime transition signal (potential regime change)
   */
  isRegimeChanging(): boolean {
    if (this.regimeHistory.length < 3) return false;
    const recent = this.regimeHistory.slice(-3);
    // If last 3 readings are different = unstable = changing
    const uniqueRegimes = new Set(recent.map(r => r.regime));
    return uniqueRegimes.size >= 2;
  }

  // ═══════════ Technical Indicators ═══════════

  /**
   * Calculate ADX (Average Directional Index)
   */
  private calculateADX(klines: Kline[], period: number): number {
    if (klines.length < period + 1) return 0;

    const trueRanges: number[] = [];
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = klines[i].high;
      const low = klines[i].low;
      const prevHigh = klines[i - 1].high;
      const prevLow = klines[i - 1].low;
      const prevClose = klines[i - 1].close;

      // True Range
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);

      // +DM and -DM
      const plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
      const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }

    // Smoothed averages
    const smoothTR = this.wilder(trueRanges, period);
    const smoothPlusDM = this.wilder(plusDMs, period);
    const smoothMinusDM = this.wilder(minusDMs, period);

    if (smoothTR === 0) return 0;

    const plusDI = (smoothPlusDM / smoothTR) * 100;
    const minusDI = (smoothMinusDM / smoothTR) * 100;
    const diSum = plusDI + minusDI;

    if (diSum === 0) return 0;

    const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;
    return dx; // Simplified ADX (single DX value)
  }

  /**
   * Calculate ATR (Average True Range)
   */
  private calculateATR(klines: Kline[], period: number): number {
    if (klines.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = 1; i < klines.length; i++) {
      const tr = Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)
      );
      trueRanges.push(tr);
    }

    // EMA of true ranges
    return this.ema(trueRanges, period);
  }

  /**
   * Calculate Bollinger Band Width (as % of price)
   */
  private calculateBBWidth(klines: Kline[], period: number, stdDevMultiplier: number): number {
    const closes = klines.slice(-period).map(k => k.close);
    if (closes.length < period) return 0;

    const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / closes.length;
    const stdDev = Math.sqrt(variance);

    const upperBand = mean + stdDevMultiplier * stdDev;
    const lowerBand = mean - stdDevMultiplier * stdDev;
    const width = ((upperBand - lowerBand) / mean) * 100;

    return width;
  }

  /**
   * Calculate Rate of Change (ROC) - percentage change over N periods
   */
  private calculateROC(klines: Kline[], period: number): number {
    if (klines.length < period + 1) return 0;
    const current = klines[klines.length - 1].close;
    const past = klines[klines.length - 1 - period].close;
    return past > 0 ? ((current - past) / past) * 100 : 0;
  }

  /**
   * Calculate regime classification confidence
   */
  private calculateRegimeConfidence(adx: number, atrPercent: number, bbWidth: number): number {
    // Higher ADX = more confident in trend classification
    // More extreme values = more confident
    let confidence = 0.5;

    if (adx > 35) confidence += 0.2;
    else if (adx > 25) confidence += 0.1;

    if (atrPercent > 3.5 || atrPercent < 0.8) confidence += 0.15;
    if (bbWidth < 1.0 || bbWidth > 5.0) confidence += 0.1;

    return Math.min(0.95, confidence);
  }

  // ═══════════ Helper Functions ═══════════

  private wilder(values: number[], period: number): number {
    if (values.length < period) return 0;
    let avg = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      avg = (avg * (period - 1) + values[i]) / period;
    }
    return avg;
  }

  private ema(values: number[], period: number): number {
    if (values.length === 0) return 0;
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(values.length, period);
    for (let i = period; i < values.length; i++) {
      ema = (values[i] - ema) * multiplier + ema;
    }
    return ema;
  }

  private async fetchKlines(interval: string, limit: number): Promise<Kline[]> {
    const response = await axios.get(`${config.feeds.binanceUrl}/klines`, {
      params: { symbol: 'BTCUSDT', interval, limit },
      timeout: 5000,
    });

    return response.data.map((k: any[]) => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      timestamp: k[0],
    }));
  }

  private defaultRegime(reason: string): RegimeAnalysis {
    return {
      regime: 'RANGING',
      confidence: 0.3,
      adx: 0, atr: 0, atrPercent: 0, bbWidth: 0, roc: 0,
      tradingAllowed: true,
      confidenceMultiplier: 0.9,
      maxPositionPercent: 0.20,
      reason: `Default (${reason})`,
    };
  }

  getCachedRegime(): RegimeAnalysis | null {
    return this.cachedRegime;
  }
}
