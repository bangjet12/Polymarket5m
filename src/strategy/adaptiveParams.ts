import { config } from '../config';
import { TradeLog } from '../types';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * Adaptive Parameter Tuning
 * 
 * Automatically adjusts trading parameters based on recent performance.
 * The bot "learns" what works and adapts in real-time:
 * 
 * - If winrate drops → increase MIN_CONFIDENCE (be more selective)
 * - If winrate rises → decrease MIN_CONFIDENCE (take more trades)
 * - If avg loss grows → tighten stop loss, reduce position size
 * - If a specific regime underperforms → adjust rules for that regime
 * - If time-of-day shows patterns → weight certain hours more
 * 
 * Review Window: evaluates last 20 trades (rolling)
 * Adjustment Frequency: every 10 trades
 * 
 * This creates a self-improving system that adapts to changing market conditions.
 */

interface AdaptiveState {
  // Current adaptive parameters
  minConfidence: number;
  minDivergence: number;
  maxPositionPercent: number;
  slippageTolerance: number;

  // Performance tracking
  rollingWinRate: number;
  rollingAvgPnl: number;
  rollingProfitFactor: number;

  // Regime-specific adjustments
  regimeMultipliers: Record<string, number>;

  // Time-of-day performance (hour 0-23)
  hourlyWinRate: number[];
  hourlyTradeCount: number[];

  // Meta
  totalAdjustments: number;
  lastAdjustedAt: number;
  version: number;
}

interface PerformanceSnapshot {
  winRate: number;
  avgPnl: number;
  profitFactor: number;
  totalTrades: number;
  bestHour: number;
  worstHour: number;
}

export class AdaptiveParameterTuner {
  private state: AdaptiveState;
  private recentTrades: { win: boolean; pnl: number; confidence: number; regime: string; hour: number; timestamp: number }[] = [];
  private readonly dataPath: string;
  private readonly reviewWindow = 20;       // evaluate last 20 trades
  private readonly adjustFrequency = 10;    // adjust every 10 trades
  private tradesSinceLastAdjust = 0;

  // Bounds for adaptive parameters
  private readonly bounds = {
    minConfidence: { min: 0.60, max: 0.90, step: 0.02 },
    minDivergence: { min: 1.5, max: 5.0, step: 0.25 },
    maxPositionPercent: { min: 0.10, max: 0.40, step: 0.05 },
    slippageTolerance: { min: 0.2, max: 1.0, step: 0.1 },
  };

  constructor() {
    this.dataPath = path.resolve(__dirname, '../../data/adaptive_params.json');
    this.state = this.loadState() || this.initializeState();

    logger.info(`🔧 Adaptive Parameters loaded: v${this.state.version} | ` +
                `MinConf=${(this.state.minConfidence * 100).toFixed(0)}% | ` +
                `MinDiv=${this.state.minDivergence.toFixed(1)}% | ` +
                `Adjustments: ${this.state.totalAdjustments}`);
  }

  /**
   * Get current adaptive parameters
   */
  getParams(): {
    minConfidence: number;
    minDivergence: number;
    maxPositionPercent: number;
    slippageTolerance: number;
  } {
    return {
      minConfidence: this.state.minConfidence,
      minDivergence: this.state.minDivergence,
      maxPositionPercent: this.state.maxPositionPercent,
      slippageTolerance: this.state.slippageTolerance,
    };
  }

  /**
   * Get regime-specific confidence multiplier
   */
  getRegimeMultiplier(regime: string): number {
    return this.state.regimeMultipliers[regime] || 1.0;
  }

  /**
   * Get time-of-day multiplier (boost during historically profitable hours)
   */
  getHourlyMultiplier(): number {
    const hour = new Date().getUTCHours();
    const winRate = this.state.hourlyWinRate[hour] || 0;
    const tradeCount = this.state.hourlyTradeCount[hour] || 0;

    // Need at least 5 trades in this hour to have meaningful data
    if (tradeCount < 5) return 1.0;

    // Boost during good hours, penalize during bad hours
    if (winRate > 0.75) return 1.10;
    if (winRate > 0.65) return 1.05;
    if (winRate < 0.45) return 0.80;
    if (winRate < 0.55) return 0.90;
    return 1.0;
  }

  /**
   * Record a new trade result and potentially trigger parameter adjustment
   */
  recordTrade(trade: {
    win: boolean;
    pnl: number;
    confidence: number;
    regime: string;
  }): void {
    const hour = new Date().getUTCHours();

    this.recentTrades.push({
      ...trade,
      hour,
      timestamp: Date.now(),
    });

    // Keep only recent trades
    if (this.recentTrades.length > 100) {
      this.recentTrades.shift();
    }

    // Update hourly stats
    this.state.hourlyTradeCount[hour] = (this.state.hourlyTradeCount[hour] || 0) + 1;
    const hourTrades = this.recentTrades.filter(t => t.hour === hour);
    const hourWins = hourTrades.filter(t => t.win).length;
    this.state.hourlyWinRate[hour] = hourTrades.length > 0 ? hourWins / hourTrades.length : 0;

    // Check if we should adjust
    this.tradesSinceLastAdjust++;
    if (this.tradesSinceLastAdjust >= this.adjustFrequency) {
      this.performAdjustment();
      this.tradesSinceLastAdjust = 0;
    }

    this.saveState();
  }

  /**
   * Perform parameter adjustment based on recent performance
   */
  private performAdjustment(): void {
    const recent = this.recentTrades.slice(-this.reviewWindow);
    if (recent.length < this.reviewWindow * 0.5) return; // not enough data

    const wins = recent.filter(t => t.win);
    const losses = recent.filter(t => !t.win);
    const winRate = wins.length / recent.length;
    const avgPnl = recent.reduce((sum, t) => sum + t.pnl, 0) / recent.length;
    const totalWin = wins.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const totalLoss = losses.reduce((sum, t) => sum + Math.abs(t.pnl), 0);
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 10 : 0;

    // Store rolling metrics
    this.state.rollingWinRate = winRate;
    this.state.rollingAvgPnl = avgPnl;
    this.state.rollingProfitFactor = profitFactor;

    let adjusted = false;

    // ═══ Rule 1: Adjust MIN_CONFIDENCE based on win rate ═══
    if (winRate < 0.55) {
      // Losing too much → be MORE selective
      this.state.minConfidence = Math.min(
        this.bounds.minConfidence.max,
        this.state.minConfidence + this.bounds.minConfidence.step * 2
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] WR=${(winRate * 100).toFixed(0)}% < 55% → ` +
                  `Raised MIN_CONFIDENCE to ${(this.state.minConfidence * 100).toFixed(0)}%`);
    } else if (winRate > 0.75 && this.state.minConfidence > this.bounds.minConfidence.min + 0.05) {
      // Winning consistently → can be slightly less selective (take more trades)
      this.state.minConfidence = Math.max(
        this.bounds.minConfidence.min,
        this.state.minConfidence - this.bounds.minConfidence.step
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] WR=${(winRate * 100).toFixed(0)}% > 75% → ` +
                  `Lowered MIN_CONFIDENCE to ${(this.state.minConfidence * 100).toFixed(0)}%`);
    }

    // ═══ Rule 2: Adjust MIN_DIVERGENCE based on profit factor ═══
    if (profitFactor < 1.2) {
      // Not enough edge → require bigger divergence
      this.state.minDivergence = Math.min(
        this.bounds.minDivergence.max,
        this.state.minDivergence + this.bounds.minDivergence.step
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] PF=${profitFactor.toFixed(2)} < 1.2 → ` +
                  `Raised MIN_DIVERGENCE to ${this.state.minDivergence.toFixed(1)}%`);
    } else if (profitFactor > 2.5 && this.state.minDivergence > this.bounds.minDivergence.min + 0.5) {
      // Strong edge → can take smaller divergences
      this.state.minDivergence = Math.max(
        this.bounds.minDivergence.min,
        this.state.minDivergence - this.bounds.minDivergence.step
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] PF=${profitFactor.toFixed(2)} > 2.5 → ` +
                  `Lowered MIN_DIVERGENCE to ${this.state.minDivergence.toFixed(1)}%`);
    }

    // ═══ Rule 3: Adjust position size based on drawdown ═══
    if (avgPnl < -0.5) {
      // Losing money on average → reduce size
      this.state.maxPositionPercent = Math.max(
        this.bounds.maxPositionPercent.min,
        this.state.maxPositionPercent - this.bounds.maxPositionPercent.step
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] Avg PnL=$${avgPnl.toFixed(2)} < 0 → ` +
                  `Reduced MAX_POSITION to ${(this.state.maxPositionPercent * 100).toFixed(0)}%`);
    } else if (avgPnl > 1.0 && profitFactor > 2.0) {
      // Consistently profitable → can increase size slightly
      this.state.maxPositionPercent = Math.min(
        this.bounds.maxPositionPercent.max,
        this.state.maxPositionPercent + this.bounds.maxPositionPercent.step
      );
      adjusted = true;
      logger.info(`🔧 [Adaptive] Avg PnL=$${avgPnl.toFixed(2)} > 1 → ` +
                  `Increased MAX_POSITION to ${(this.state.maxPositionPercent * 100).toFixed(0)}%`);
    }

    // ═══ Rule 4: Adjust regime multipliers ═══
    this.adjustRegimeMultipliers(recent);

    if (adjusted) {
      this.state.totalAdjustments++;
      this.state.lastAdjustedAt = Date.now();
      this.state.version++;
      logger.info(`🔧 [Adaptive] Adjustment #${this.state.totalAdjustments} complete (v${this.state.version})`);
    }
  }

  /**
   * Adjust multipliers for each market regime based on performance in that regime
   */
  private adjustRegimeMultipliers(
    recent: { win: boolean; pnl: number; regime: string }[]
  ): void {
    const regimes = ['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE', 'QUIET'];

    for (const regime of regimes) {
      const regimeTrades = recent.filter(t => t.regime === regime);
      if (regimeTrades.length < 3) continue; // not enough data

      const regimeWR = regimeTrades.filter(t => t.win).length / regimeTrades.length;
      const currentMultiplier = this.state.regimeMultipliers[regime] || 1.0;

      if (regimeWR < 0.45) {
        // This regime is losing → penalize
        this.state.regimeMultipliers[regime] = Math.max(0.5, currentMultiplier - 0.1);
      } else if (regimeWR > 0.70) {
        // This regime is winning → boost
        this.state.regimeMultipliers[regime] = Math.min(1.3, currentMultiplier + 0.05);
      }
    }
  }

  /**
   * Get performance snapshot for monitoring
   */
  getPerformanceSnapshot(): PerformanceSnapshot {
    const recent = this.recentTrades.slice(-this.reviewWindow);
    const wins = recent.filter(t => t.win).length;

    // Find best and worst hours
    let bestHour = 0, worstHour = 0;
    let bestWR = 0, worstWR = 1;
    for (let h = 0; h < 24; h++) {
      const wr = this.state.hourlyWinRate[h] || 0.5;
      const count = this.state.hourlyTradeCount[h] || 0;
      if (count >= 3) {
        if (wr > bestWR) { bestWR = wr; bestHour = h; }
        if (wr < worstWR) { worstWR = wr; worstHour = h; }
      }
    }

    return {
      winRate: recent.length > 0 ? wins / recent.length : 0,
      avgPnl: recent.length > 0 ? recent.reduce((s, t) => s + t.pnl, 0) / recent.length : 0,
      profitFactor: this.state.rollingProfitFactor,
      totalTrades: this.recentTrades.length,
      bestHour,
      worstHour,
    };
  }

  /**
   * Check if current hour is historically a bad time to trade
   */
  isCurrentHourBad(): boolean {
    const hour = new Date().getUTCHours();
    const wr = this.state.hourlyWinRate[hour] || 0.5;
    const count = this.state.hourlyTradeCount[hour] || 0;
    return count >= 5 && wr < 0.40;
  }

  /**
   * Get adaptive state for display/monitoring
   */
  getState(): AdaptiveState {
    return { ...this.state };
  }

  private initializeState(): AdaptiveState {
    return {
      minConfidence: config.risk.minConfidence,
      minDivergence: config.strategy.minDivergence,
      maxPositionPercent: 0.25,
      slippageTolerance: config.strategy.slippageTolerance,
      rollingWinRate: 0.65,
      rollingAvgPnl: 0,
      rollingProfitFactor: 1.0,
      regimeMultipliers: {
        TRENDING_UP: 1.0,
        TRENDING_DOWN: 1.0,
        RANGING: 1.0,
        VOLATILE: 0.0,
        QUIET: 0.9,
      },
      hourlyWinRate: new Array(24).fill(0.5),
      hourlyTradeCount: new Array(24).fill(0),
      totalAdjustments: 0,
      lastAdjustedAt: Date.now(),
      version: 1,
    };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify({
        state: this.state,
        recentTrades: this.recentTrades.slice(-50),
      }, null, 2));
    } catch (e) { /* silent */ }
  }

  private loadState(): AdaptiveState | null {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        if (data.recentTrades) this.recentTrades = data.recentTrades;
        return data.state;
      }
    } catch (e) { /* start fresh */ }
    return null;
  }
}
