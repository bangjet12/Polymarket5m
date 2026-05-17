import { PolymarketMarket, TradeSignal } from '../types';
import { HistoricalDataFeed } from '../feeds/historicalData';
import { logger } from '../utils/logger';

/**
 * Multi-Timeframe Confirmation Module
 * 
 * Tracks divergence across multiple time snapshots to confirm signals.
 * A divergence that is GROWING (widening) is more reliable than one that
 * is shrinking (market already correcting).
 * 
 * Logic:
 * - Store divergence readings over last 3-5 cycles (15-25 minutes)
 * - If divergence is consistently widening → STRONG signal (market hasn't noticed)
 * - If divergence is stable → MODERATE signal (market is slow to correct)
 * - If divergence is shrinking → WEAK signal (market already correcting, we're late)
 * 
 * Also checks price momentum on the Polymarket token itself across candles.
 */

interface DivergenceSnapshot {
  marketId: string;
  divergence: number;
  confidence: number;
  spotPrice: number;
  marketPrice: number;
  timestamp: number;
}

interface MultiTimeframeResult {
  trend: 'WIDENING' | 'STABLE' | 'SHRINKING';
  confidenceMultiplier: number;
  snapshots: number;
  avgDivergence: number;
  divergenceSlope: number;    // positive = widening, negative = shrinking
  reason: string;
}

export class MultiTimeframeConfirmation {
  private divergenceHistory: Map<string, DivergenceSnapshot[]> = new Map();
  private readonly maxSnapshots = 10;       // keep last 10 readings per market
  private readonly minSnapshots = 3;        // need at least 3 to confirm
  private readonly wideningThreshold = 0.2; // divergence growing by 0.2%+ per cycle
  private readonly shrinkingThreshold = -0.2;

  /**
   * Record a new divergence snapshot for a market
   */
  recordSnapshot(signal: TradeSignal, marketPrice: number): void {
    const marketId = signal.market.id;

    if (!this.divergenceHistory.has(marketId)) {
      this.divergenceHistory.set(marketId, []);
    }

    const history = this.divergenceHistory.get(marketId)!;
    history.push({
      marketId,
      divergence: signal.divergence,
      confidence: signal.confidence,
      spotPrice: signal.spotPrice,
      marketPrice,
      timestamp: Date.now(),
    });

    // Trim old entries
    if (history.length > this.maxSnapshots) {
      history.shift();
    }
  }

  /**
   * Analyze divergence trend for a market
   * Returns confidence multiplier based on whether divergence is growing or shrinking
   */
  analyzeSignal(signal: TradeSignal): MultiTimeframeResult {
    const marketId = signal.market.id;
    const history = this.divergenceHistory.get(marketId);

    if (!history || history.length < this.minSnapshots) {
      // Not enough data yet - record and return neutral
      return {
        trend: 'STABLE',
        confidenceMultiplier: 1.0,
        snapshots: history?.length || 0,
        avgDivergence: signal.divergence,
        divergenceSlope: 0,
        reason: `Insufficient history (${history?.length || 0}/${this.minSnapshots} snapshots)`,
      };
    }

    // Calculate divergence slope (linear regression)
    const slope = this.calculateSlope(history);
    const avgDivergence = history.reduce((sum, s) => sum + s.divergence, 0) / history.length;

    // Determine trend
    let trend: 'WIDENING' | 'STABLE' | 'SHRINKING';
    let confidenceMultiplier: number;

    if (slope > this.wideningThreshold) {
      trend = 'WIDENING';
      // Widening divergence = market hasn't corrected yet = strong opportunity
      confidenceMultiplier = 1.1 + Math.min(0.15, slope * 0.1);
    } else if (slope < this.shrinkingThreshold) {
      trend = 'SHRINKING';
      // Shrinking = market is correcting = we might be too late
      confidenceMultiplier = 0.75 + Math.max(0, (slope + 1) * 0.1);
    } else {
      trend = 'STABLE';
      // Stable divergence = persistent mispricing = decent opportunity
      confidenceMultiplier = 1.05;
    }

    // Additional check: consistency of divergence direction
    const consistent = this.checkConsistency(history);
    if (consistent > 0.8) {
      confidenceMultiplier += 0.05; // bonus for consistent signal
    }

    const reason = `MTF: ${trend} (slope=${slope.toFixed(2)}/cycle) | ` +
                   `Avg div: ${avgDivergence.toFixed(1)}% | ` +
                   `Snapshots: ${history.length} | ` +
                   `Consistency: ${(consistent * 100).toFixed(0)}%`;

    logger.debug(`📐 ${reason}`);

    return {
      trend,
      confidenceMultiplier: Math.max(0.6, Math.min(1.3, confidenceMultiplier)),
      snapshots: history.length,
      avgDivergence,
      divergenceSlope: slope,
      reason,
    };
  }

  /**
   * Calculate the slope of divergence over time using linear regression
   */
  private calculateSlope(history: DivergenceSnapshot[]): number {
    const n = history.length;
    if (n < 2) return 0;

    // Simple linear regression: y = divergence, x = index (cycle number)
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += history[i].divergence;
      sumXY += i * history[i].divergence;
      sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  /**
   * Check how consistent the divergence direction has been
   * Returns 0-1 (1 = all snapshots have same sign divergence)
   */
  private checkConsistency(history: DivergenceSnapshot[]): number {
    if (history.length < 2) return 0;

    const lastSign = history[history.length - 1].divergence > 0 ? 1 : -1;
    let consistent = 0;

    for (const snap of history) {
      const sign = snap.divergence > 0 ? 1 : -1;
      if (sign === lastSign) consistent++;
    }

    return consistent / history.length;
  }

  /**
   * Check if divergence is accelerating (second derivative > 0)
   */
  isDivergenceAccelerating(marketId: string): boolean {
    const history = this.divergenceHistory.get(marketId);
    if (!history || history.length < 4) return false;

    const recent = history.slice(-4);
    const diff1 = recent[1].divergence - recent[0].divergence;
    const diff2 = recent[2].divergence - recent[1].divergence;
    const diff3 = recent[3].divergence - recent[2].divergence;

    // Acceleration = second differences are positive
    return (diff2 - diff1 > 0) && (diff3 - diff2 > 0);
  }

  /**
   * Get time since first divergence was detected for this market
   */
  getSignalAge(marketId: string): number | null {
    const history = this.divergenceHistory.get(marketId);
    if (!history || history.length === 0) return null;
    return Date.now() - history[0].timestamp;
  }

  /**
   * Clean up old market histories (markets no longer active)
   */
  cleanup(activeMarketIds: Set<string>): void {
    for (const [marketId] of this.divergenceHistory) {
      if (!activeMarketIds.has(marketId)) {
        this.divergenceHistory.delete(marketId);
      }
    }
  }
}
