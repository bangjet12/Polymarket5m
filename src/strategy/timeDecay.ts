import { PolymarketMarket } from '../types';
import { logger } from '../utils/logger';

/**
 * Time Decay Weighting Module
 * 
 * Markets closer to expiry are MORE predictable because:
 * - Less time for BTC to move dramatically
 * - If BTC is already well above/below threshold, outcome is nearly certain
 * - Reduced uncertainty = higher confidence in fair value estimate
 * 
 * This module adjusts confidence and position sizing based on:
 * 1. Time remaining until resolution
 * 2. Distance from spot to strike (moneyness)
 * 3. Implied volatility over remaining time
 * 
 * Key insight: A market "BTC above $60K by tomorrow" with BTC at $68K 
 * should be trading at ~0.99. If it's at 0.90, that's a HIGH confidence signal.
 */
export class TimeDecayEngine {
  /**
   * Calculate time decay multiplier for confidence adjustment
   * 
   * Returns a multiplier (0.5 - 2.0):
   * - < 1.0: far from expiry, reduce confidence (more uncertainty)
   * - = 1.0: neutral (about 7 days to expiry)
   * - > 1.0: close to expiry, increase confidence (less uncertainty)
   * - 2.0: very close to expiry with clear moneyness (highest confidence)
   */
  getTimeDecayMultiplier(
    market: PolymarketMarket,
    spotPrice: number,
    strikePrice: number
  ): number {
    const timeRemaining = this.getTimeRemainingHours(market);
    if (timeRemaining === null) return 1.0; // no expiry data

    const moneyness = this.getMoneyness(spotPrice, strikePrice);

    // Base time factor: closer to expiry = more predictable
    let timeMultiplier: number;

    if (timeRemaining <= 1) {
      // Less than 1 hour - extremely predictable if in-the-money
      timeMultiplier = moneyness > 0.03 ? 2.0 : 1.5;
    } else if (timeRemaining <= 6) {
      // 1-6 hours - very predictable
      timeMultiplier = 1.0 + (moneyness > 0.02 ? 0.8 : 0.4);
    } else if (timeRemaining <= 24) {
      // 6-24 hours - high confidence for deep ITM
      timeMultiplier = 1.0 + (moneyness > 0.05 ? 0.5 : 0.2);
    } else if (timeRemaining <= 72) {
      // 1-3 days - moderate confidence boost
      timeMultiplier = 1.0 + (moneyness > 0.08 ? 0.3 : 0.1);
    } else if (timeRemaining <= 168) {
      // 3-7 days - neutral
      timeMultiplier = 1.0;
    } else if (timeRemaining <= 720) {
      // 7-30 days - slightly reduced (more uncertainty)
      timeMultiplier = 0.85;
    } else {
      // > 30 days - significant uncertainty discount
      timeMultiplier = 0.7;
    }

    return timeMultiplier;
  }

  /**
   * Calculate adjusted fair value with time decay
   * 
   * Uses Black-Scholes-like approach for binary options:
   * - Deep ITM near expiry → fair value approaches 1.0
   * - Deep OTM near expiry → fair value approaches 0.0
   * - ATM with lots of time → fair value stays near 0.5
   */
  getTimeAdjustedFairValue(
    spotPrice: number,
    strikePrice: number,
    market: PolymarketMarket,
    dailyVolatility: number // as percentage (e.g., 2.5 for 2.5%)
  ): number {
    const timeRemaining = this.getTimeRemainingHours(market);
    if (timeRemaining === null) return 0.5;

    const daysRemaining = timeRemaining / 24;

    // Annualized volatility from daily
    const annualVol = dailyVolatility * Math.sqrt(365);

    // Standard deviation of price over remaining time
    const timeVol = (annualVol / 100) * Math.sqrt(daysRemaining / 365);

    // Distance from spot to strike (as ratio)
    const distance = (spotPrice - strikePrice) / spotPrice;

    // Z-score: how many standard deviations away is the strike?
    const zScore = timeVol > 0 ? distance / timeVol : (distance > 0 ? 10 : -10);

    // Cumulative normal distribution approximation (probit)
    const fairValue = this.normalCDF(zScore);

    // Near-expiry acceleration: sharpen the curve as time decays
    if (daysRemaining < 1) {
      // With < 24 hours, use sharper sigmoid
      const sharpened = 1 / (1 + Math.exp(-zScore * 8));
      // Blend: 70% sharpened, 30% normal for very short term
      return Math.max(0.01, Math.min(0.99, 0.7 * sharpened + 0.3 * fairValue));
    }

    return Math.max(0.02, Math.min(0.98, fairValue));
  }

  /**
   * Determine optimal position holding time
   * Suggests how long to hold before market resolution
   */
  getOptimalHoldingPeriod(market: PolymarketMarket): {
    holdUntilResolution: boolean;
    suggestedExitHoursBeforeExpiry: number;
    reason: string;
  } {
    const timeRemaining = this.getTimeRemainingHours(market);
    if (timeRemaining === null) {
      return { holdUntilResolution: false, suggestedExitHoursBeforeExpiry: 0, reason: 'No expiry data' };
    }

    if (timeRemaining <= 2) {
      return {
        holdUntilResolution: true,
        suggestedExitHoursBeforeExpiry: 0,
        reason: 'Very close to expiry - hold to resolution for max payout',
      };
    }

    if (timeRemaining <= 24) {
      return {
        holdUntilResolution: true,
        suggestedExitHoursBeforeExpiry: 0,
        reason: 'Within 24h of expiry - theta decay accelerating in our favor',
      };
    }

    if (timeRemaining <= 72) {
      return {
        holdUntilResolution: false,
        suggestedExitHoursBeforeExpiry: 6,
        reason: 'Medium-term - exit 6h before expiry to avoid resolution risk',
      };
    }

    return {
      holdUntilResolution: false,
      suggestedExitHoursBeforeExpiry: 24,
      reason: 'Long-term - target exit at higher confidence level before expiry',
    };
  }

  /**
   * Calculate theta (time value decay rate)
   * How much value does the position lose/gain per hour purely from time passing
   */
  calculateTheta(
    currentPrice: number,
    fairValue: number,
    market: PolymarketMarket
  ): number {
    const timeRemaining = this.getTimeRemainingHours(market);
    if (timeRemaining === null || timeRemaining <= 0) return 0;

    // Theta = rate of convergence to fair value
    // Positive theta = position gains from time decay (favorable)
    // Negative theta = position loses from time decay (unfavorable)
    const gap = fairValue - currentPrice;
    const thetaPerHour = gap / timeRemaining;

    return thetaPerHour;
  }

  /**
   * Score a market based on time-decay opportunity
   * Higher score = better opportunity from time decay perspective
   */
  scoreTimeDecayOpportunity(
    market: PolymarketMarket,
    spotPrice: number,
    strikePrice: number,
    currentMarketPrice: number,
    dailyVolatility: number
  ): {
    score: number;
    reason: string;
    timeAdjustedFair: number;
    thetaPerHour: number;
  } {
    const fairValue = this.getTimeAdjustedFairValue(spotPrice, strikePrice, market, dailyVolatility);
    const theta = this.calculateTheta(currentMarketPrice, fairValue, market);
    const timeRemaining = this.getTimeRemainingHours(market) || 999;
    const moneyness = this.getMoneyness(spotPrice, strikePrice);

    let score = 0;
    let reason = '';

    // High theta = strong time decay in our favor
    if (Math.abs(theta) > 0.01) score += 30;
    if (Math.abs(theta) > 0.03) score += 20;

    // Deep ITM near expiry = near-certain outcome
    if (moneyness > 0.05 && timeRemaining < 24) {
      score += 40;
      reason = 'Deep ITM near expiry - time decay strongly favorable';
    } else if (moneyness > 0.03 && timeRemaining < 48) {
      score += 25;
      reason = 'ITM with accelerating theta decay';
    } else if (timeRemaining < 6 && Math.abs(fairValue - currentMarketPrice) > 0.05) {
      score += 35;
      reason = 'Near-expiry mispricing - market has not converged';
    } else {
      reason = `Time decay neutral (${timeRemaining.toFixed(0)}h remaining)`;
    }

    // Penalize very long-dated markets (too much uncertainty)
    if (timeRemaining > 720) score -= 20;

    return {
      score: Math.max(0, Math.min(100, score)),
      reason,
      timeAdjustedFair: fairValue,
      thetaPerHour: theta,
    };
  }

  // ──────────────── Helper Methods ────────────────

  private getTimeRemainingHours(market: PolymarketMarket): number | null {
    if (!market.endDate) return null;
    const expiry = new Date(market.endDate).getTime();
    const remaining = (expiry - Date.now()) / (1000 * 60 * 60);
    return remaining > 0 ? remaining : 0;
  }

  private getMoneyness(spotPrice: number, strikePrice: number): number {
    // Positive = spot above strike (ITM for YES), Negative = below (OTM for YES)
    return (spotPrice - strikePrice) / strikePrice;
  }

  /**
   * Cumulative Normal Distribution (approximation)
   * Abramowitz & Stegun formula 7.1.26
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.SQRT2;

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }
}
