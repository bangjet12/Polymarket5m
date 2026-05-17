import { config } from '../config';
import { TradeSignal, TradeLog } from '../types';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * Kelly Criterion Position Sizing
 * 
 * Mathematically optimal position sizing that maximizes long-term growth rate.
 * 
 * Formula: Kelly% = (p * b - q) / b
 * Where:
 *   p = win probability (from confidence score + historical WR)
 *   q = loss probability (1 - p)
 *   b = win/loss ratio (avg win size / avg loss size)
 * 
 * We use FRACTIONAL Kelly (25-50%) for safety:
 * - Full Kelly = maximum growth but high variance (account can drop 50%+)
 * - Half Kelly = 75% of max growth, much smoother equity curve
 * - Quarter Kelly = safest, best for small accounts ($5-15)
 * 
 * For small accounts ($5-15):
 * - Uses quarter-Kelly (25%) to prevent blowup
 * - Minimum trade size: $1
 * - Maximum trade size: 40% of balance
 * - Adapts based on recent win streak / loss streak
 */

interface KellyStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinAmount: number;
  avgLossAmount: number;
  winLossRatio: number;      // avg_win / avg_loss
  kellyFraction: number;     // optimal kelly %
  adjustedKelly: number;     // fractional kelly we actually use
  consecutiveWins: number;
  consecutiveLosses: number;
  lastUpdated: number;
}

interface SizeRecommendation {
  size: number;              // USDC amount to trade
  kellyPercent: number;      // Kelly % of bankroll
  reason: string;
  riskLevel: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
}

export class KellyCriterion {
  private stats: KellyStats;
  private tradeResults: { win: boolean; amount: number; timestamp: number }[] = [];
  private readonly dataPath: string;
  private readonly maxHistory = 200;

  // Fractional Kelly multipliers based on account size
  private readonly kellyFraction: number;
  private readonly minTradeSize = 1;      // $1 minimum
  private readonly maxBankrollPercent = 0.40; // never risk more than 40%

  constructor(accountSize: number = 15) {
    this.dataPath = path.resolve(__dirname, '../../data/kelly_stats.json');

    // Determine Kelly fraction based on account size
    if (accountSize <= 15) {
      this.kellyFraction = 0.25; // Quarter Kelly for tiny accounts
    } else if (accountSize <= 50) {
      this.kellyFraction = 0.33; // Third Kelly for small accounts
    } else if (accountSize <= 200) {
      this.kellyFraction = 0.40; // 40% Kelly for medium accounts
    } else {
      this.kellyFraction = 0.50; // Half Kelly for larger accounts
    }

    // Load or initialize stats
    this.stats = this.loadStats() || this.initializeStats();
    logger.info(`📐 Kelly Criterion initialized: fraction=${(this.kellyFraction * 100).toFixed(0)}% | ` +
                `WR=${(this.stats.winRate * 100).toFixed(0)}% | ` +
                `W/L ratio=${this.stats.winLossRatio.toFixed(2)} | ` +
                `Optimal Kelly=${(this.stats.kellyFraction * 100).toFixed(1)}%`);
  }

  /**
   * Calculate optimal position size for a trade signal
   */
  calculateSize(signal: TradeSignal, currentBalance: number): SizeRecommendation {
    // Use signal confidence as win probability estimate
    // Blend with historical win rate (70% signal confidence + 30% historical WR)
    const historicalWeight = Math.min(0.4, this.stats.totalTrades / 100); // grows with more data
    const signalWeight = 1 - historicalWeight;
    const winProb = signalWeight * signal.confidence + historicalWeight * this.stats.winRate;

    const lossProb = 1 - winProb;

    // Win/loss ratio from historical data (or estimate from divergence)
    const winLossRatio = this.stats.winLossRatio > 0
      ? this.stats.winLossRatio
      : this.estimateWinLossRatio(signal);

    // Kelly formula: (p * b - q) / b
    let kellyPercent = 0;
    if (winLossRatio > 0) {
      kellyPercent = (winProb * winLossRatio - lossProb) / winLossRatio;
    }

    // Clamp Kelly between 0 and max
    kellyPercent = Math.max(0, Math.min(kellyPercent, this.maxBankrollPercent));

    // Apply fractional Kelly
    let adjustedKelly = kellyPercent * this.kellyFraction;

    // Streak adjustment
    adjustedKelly = this.applyStreakAdjustment(adjustedKelly);

    // Confidence-based scaling
    adjustedKelly = this.applyConfidenceScaling(adjustedKelly, signal.confidence);

    // Calculate actual size
    let size = currentBalance * adjustedKelly;

    // Apply bounds
    size = Math.max(this.minTradeSize, size);
    size = Math.min(size, currentBalance * this.maxBankrollPercent);
    size = Math.min(size, config.risk.maxPositionSize);
    size = Math.round(size * 100) / 100;

    // Determine risk level
    let riskLevel: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
    const percentOfBalance = size / currentBalance;
    if (percentOfBalance < 0.15) riskLevel = 'CONSERVATIVE';
    else if (percentOfBalance < 0.30) riskLevel = 'MODERATE';
    else riskLevel = 'AGGRESSIVE';

    const reason = `Kelly: ${(kellyPercent * 100).toFixed(1)}% → ${(adjustedKelly * 100).toFixed(1)}% (×${this.kellyFraction}) | ` +
                   `WP=${(winProb * 100).toFixed(0)}% | W/L=${winLossRatio.toFixed(2)} | ` +
                   `Size: $${size.toFixed(2)} (${(percentOfBalance * 100).toFixed(0)}% of $${currentBalance.toFixed(0)})`;

    logger.debug(`📐 ${reason}`);

    return {
      size,
      kellyPercent: adjustedKelly,
      reason,
      riskLevel,
    };
  }

  /**
   * Record a trade result for updating Kelly statistics
   */
  recordResult(win: boolean, pnlAmount: number): void {
    this.tradeResults.push({
      win,
      amount: Math.abs(pnlAmount),
      timestamp: Date.now(),
    });

    if (this.tradeResults.length > this.maxHistory) {
      this.tradeResults.shift();
    }

    // Update consecutive streaks
    if (win) {
      this.stats.consecutiveWins++;
      this.stats.consecutiveLosses = 0;
    } else {
      this.stats.consecutiveLosses++;
      this.stats.consecutiveWins = 0;
    }

    // Recalculate stats
    this.recalculateStats();
    this.saveStats();
  }

  /**
   * Recalculate Kelly statistics from trade history
   */
  private recalculateStats(): void {
    if (this.tradeResults.length === 0) return;

    const wins = this.tradeResults.filter(t => t.win);
    const losses = this.tradeResults.filter(t => !t.win);

    this.stats.totalTrades = this.tradeResults.length;
    this.stats.wins = wins.length;
    this.stats.losses = losses.length;
    this.stats.winRate = wins.length / this.tradeResults.length;

    // Calculate average win and loss amounts
    this.stats.avgWinAmount = wins.length > 0
      ? wins.reduce((sum, t) => sum + t.amount, 0) / wins.length
      : 0;
    this.stats.avgLossAmount = losses.length > 0
      ? losses.reduce((sum, t) => sum + t.amount, 0) / losses.length
      : 1; // prevent division by zero

    // Win/Loss ratio
    this.stats.winLossRatio = this.stats.avgLossAmount > 0
      ? this.stats.avgWinAmount / this.stats.avgLossAmount
      : 1;

    // Calculate optimal Kelly
    const p = this.stats.winRate;
    const q = 1 - p;
    const b = this.stats.winLossRatio;

    this.stats.kellyFraction = b > 0 ? (p * b - q) / b : 0;
    this.stats.kellyFraction = Math.max(0, this.stats.kellyFraction);

    this.stats.adjustedKelly = this.stats.kellyFraction * this.kellyFraction;
    this.stats.lastUpdated = Date.now();

    if (this.stats.totalTrades % 10 === 0) {
      logger.info(`📐 Kelly Stats: WR=${(this.stats.winRate * 100).toFixed(0)}% | ` +
                  `W/L=${this.stats.winLossRatio.toFixed(2)} | ` +
                  `Kelly=${(this.stats.kellyFraction * 100).toFixed(1)}% | ` +
                  `Adjusted=${(this.stats.adjustedKelly * 100).toFixed(1)}% | ` +
                  `Streak: ${this.stats.consecutiveWins}W/${this.stats.consecutiveLosses}L`);
    }
  }

  /**
   * Adjust Kelly based on win/loss streaks (anti-martingale)
   */
  private applyStreakAdjustment(kelly: number): number {
    // Win streak: increase size slightly (momentum)
    if (this.stats.consecutiveWins >= 3) {
      kelly *= 1.15; // +15% after 3 consecutive wins
    } else if (this.stats.consecutiveWins >= 2) {
      kelly *= 1.08; // +8% after 2 consecutive wins
    }

    // Loss streak: decrease size significantly (protect capital)
    if (this.stats.consecutiveLosses >= 3) {
      kelly *= 0.50; // -50% after 3 consecutive losses (cool down)
    } else if (this.stats.consecutiveLosses >= 2) {
      kelly *= 0.70; // -30% after 2 consecutive losses
    } else if (this.stats.consecutiveLosses >= 1) {
      kelly *= 0.85; // -15% after 1 loss
    }

    return kelly;
  }

  /**
   * Scale position size by confidence level
   * Higher confidence = closer to full Kelly
   * Lower confidence = more conservative
   */
  private applyConfidenceScaling(kelly: number, confidence: number): number {
    // Map confidence 0.7-0.95 to multiplier 0.6-1.2
    if (confidence >= 0.90) return kelly * 1.2;
    if (confidence >= 0.85) return kelly * 1.1;
    if (confidence >= 0.80) return kelly * 1.0;
    if (confidence >= 0.75) return kelly * 0.85;
    return kelly * 0.7; // low confidence = very conservative
  }

  /**
   * Estimate win/loss ratio from signal characteristics when no history exists
   */
  private estimateWinLossRatio(signal: TradeSignal): number {
    // Near-expiry deep ITM = high W/L ratio
    const divergence = signal.divergence;
    if (divergence > 8) return 2.0;  // large divergence = big win potential
    if (divergence > 5) return 1.5;
    if (divergence > 3) return 1.2;
    return 1.0;
  }

  /**
   * Get current Kelly statistics
   */
  getStats(): KellyStats {
    return { ...this.stats };
  }

  /**
   * Check if we should skip trading entirely (drawdown protection)
   */
  shouldPause(): { pause: boolean; reason?: string } {
    // Pause after 4+ consecutive losses
    if (this.stats.consecutiveLosses >= 4) {
      return { pause: true, reason: `4+ consecutive losses - cooling down` };
    }

    // Pause if Kelly is effectively zero (edge is gone)
    if (this.stats.totalTrades > 20 && this.stats.kellyFraction <= 0) {
      return { pause: true, reason: `No statistical edge detected (Kelly ≤ 0)` };
    }

    return { pause: false };
  }

  private initializeStats(): KellyStats {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0.65, // optimistic default
      avgWinAmount: 0.10,
      avgLossAmount: 0.08,
      winLossRatio: 1.25,
      kellyFraction: 0.15,
      adjustedKelly: 0.15 * this.kellyFraction,
      consecutiveWins: 0,
      consecutiveLosses: 0,
      lastUpdated: Date.now(),
    };
  }

  private saveStats(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify({
        stats: this.stats,
        results: this.tradeResults.slice(-100),
      }, null, 2));
    } catch (e) { /* silent */ }
  }

  private loadStats(): KellyStats | null {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        if (data.results) this.tradeResults = data.results;
        return data.stats;
      }
    } catch (e) { /* start fresh */ }
    return null;
  }
}
