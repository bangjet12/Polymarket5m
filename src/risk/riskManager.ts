import { config } from '../config';
import { RiskState, TradeSignal, Order, Position } from '../types';
import { logger } from '../utils/logger';

/**
 * Risk Management Engine
 * Controls position sizing, exposure limits, and circuit breakers
 * Prevents catastrophic losses through multi-layered checks
 */
export class RiskManager {
  private state: RiskState;
  private positions: Map<string, Position> = new Map();
  private dailyPnlHistory: number[] = [];
  private lastDayReset: number;

  constructor() {
    this.state = {
      totalExposure: 0,
      openPositions: 0,
      dailyPnl: 0,
      dailyTradeCount: 0,
      isHalted: false,
    };
    this.lastDayReset = this.getStartOfDay();
  }

  /**
   * Check if a trade signal passes all risk checks
   */
  canTrade(signal: TradeSignal): { allowed: boolean; reason?: string } {
    // Reset daily counters if new day
    this.checkDayReset();

    // Circuit breaker check
    if (this.state.isHalted) {
      return { allowed: false, reason: `Trading halted: ${this.state.haltReason}` };
    }

    // Daily loss limit
    if (this.state.dailyPnl <= -config.risk.dailyLossLimit) {
      this.halt(`Daily loss limit hit: $${Math.abs(this.state.dailyPnl).toFixed(2)}`);
      return { allowed: false, reason: 'Daily loss limit reached' };
    }

    // Max open positions
    if (this.state.openPositions >= config.risk.maxOpenPositions) {
      return { allowed: false, reason: `Max open positions reached (${config.risk.maxOpenPositions})` };
    }

    // Max total exposure
    if (this.state.totalExposure + signal.suggestedSize > config.risk.maxTotalExposure) {
      return { allowed: false, reason: `Would exceed max exposure ($${config.risk.maxTotalExposure})` };
    }

    // Max position size
    if (signal.suggestedSize > config.risk.maxPositionSize) {
      return { allowed: false, reason: `Size exceeds max position ($${config.risk.maxPositionSize})` };
    }

    // Minimum confidence check
    if (signal.confidence < config.risk.minConfidence) {
      return { allowed: false, reason: `Confidence too low (${(signal.confidence * 100).toFixed(0)}% < ${config.risk.minConfidence * 100}%)` };
    }

    // Check for duplicate/correlated positions
    const existingPosition = this.positions.get(signal.market.id);
    if (existingPosition && existingPosition.size > 0) {
      // Already have a position in this market
      if (existingPosition.outcome === signal.outcome) {
        return { allowed: false, reason: 'Already have position in same direction' };
      }
    }

    return { allowed: true };
  }

  /**
   * Register a new trade execution
   */
  registerTrade(signal: TradeSignal, order: Order): void {
    if (order.status === 'OPEN' || order.status === 'FILLED') {
      this.state.totalExposure += signal.suggestedSize;
      this.state.openPositions++;
      this.state.dailyTradeCount++;

      this.positions.set(signal.market.id, {
        market: signal.market.id,
        tokenId: signal.tokenId,
        outcome: signal.outcome,
        size: signal.suggestedSize,
        avgEntryPrice: signal.suggestedPrice,
        currentPrice: signal.suggestedPrice,
        unrealizedPnl: 0,
        openedAt: Date.now(),
      });

      logger.info(`📊 Risk State: Exposure=$${this.state.totalExposure.toFixed(2)} | ` +
                  `Positions=${this.state.openPositions} | DailyPnl=$${this.state.dailyPnl.toFixed(2)}`);
    }
  }

  /**
   * Update position P&L
   */
  updatePosition(marketId: string, currentPrice: number): void {
    const pos = this.positions.get(marketId);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.avgEntryPrice) * pos.size;
  }

  /**
   * Close a position
   */
  closePosition(marketId: string, exitPrice: number): number {
    const pos = this.positions.get(marketId);
    if (!pos) return 0;

    const pnl = (exitPrice - pos.avgEntryPrice) * pos.size;
    this.state.dailyPnl += pnl;
    this.state.totalExposure -= pos.size;
    this.state.openPositions--;
    this.positions.delete(marketId);

    logger.info(`📈 Position closed: PnL=$${pnl.toFixed(2)} | Market: ${marketId}`);
    return pnl;
  }

  /**
   * Halt trading (circuit breaker)
   */
  halt(reason: string): void {
    this.state.isHalted = true;
    this.state.haltReason = reason;
    logger.error(`🚨 TRADING HALTED: ${reason}`);
  }

  /**
   * Resume trading
   */
  resume(): void {
    this.state.isHalted = false;
    this.state.haltReason = undefined;
    logger.info('✅ Trading resumed');
  }

  /**
   * Get current risk state
   */
  getState(): RiskState {
    return { ...this.state };
  }

  /**
   * Get all positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Adjust signal size based on risk parameters
   */
  adjustSize(signal: TradeSignal): number {
    let size = signal.suggestedSize;

    // Reduce size if approaching exposure limit
    const remainingExposure = config.risk.maxTotalExposure - this.state.totalExposure;
    size = Math.min(size, remainingExposure);

    // Reduce size if daily PnL is negative (conservative when losing)
    if (this.state.dailyPnl < 0) {
      const lossRatio = Math.abs(this.state.dailyPnl) / config.risk.dailyLossLimit;
      size *= (1 - lossRatio * 0.5); // reduce up to 50% when approaching loss limit
    }

    // Minimum trade size
    return Math.max(5, Math.round(size * 100) / 100);
  }

  /**
   * Check if day has rolled over and reset counters
   */
  private checkDayReset(): void {
    const startOfDay = this.getStartOfDay();
    if (startOfDay > this.lastDayReset) {
      // Store yesterday's PnL
      this.dailyPnlHistory.push(this.state.dailyPnl);
      if (this.dailyPnlHistory.length > 30) this.dailyPnlHistory.shift();

      // Reset daily counters
      this.state.dailyPnl = 0;
      this.state.dailyTradeCount = 0;
      this.lastDayReset = startOfDay;

      // Auto-resume if halted due to daily limit
      if (this.state.isHalted && this.state.haltReason?.includes('Daily loss')) {
        this.resume();
      }

      logger.info('📅 New trading day - counters reset');
    }
  }

  private getStartOfDay(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
}
