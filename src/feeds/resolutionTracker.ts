import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import {
  MarketResolution,
  ResolutionStatus,
  ResolutionEvent,
  Position,
  PositionResolutionResult,
  PolymarketMarket,
} from '../types';
import { RiskManager } from '../risk/riskManager';
import { AlertManager } from '../utils/alerts';
import { logger } from '../utils/logger';

/**
 * Market Resolution Tracker
 * 
 * Monitors Polymarket markets for resolution events:
 * - Detects when markets transition from ACTIVE → PENDING → RESOLVED
 * - Auto-calculates P&L on resolved positions
 * - Closes positions in RiskManager when markets resolve
 * - Sends alerts on resolution events
 * - Tracks historical resolution outcomes for strategy improvement
 * 
 * Critical for:
 * - Preventing trades on about-to-resolve markets
 * - Accurate P&L calculation
 * - Strategy backtesting data
 */
export class ResolutionTracker {
  private client: AxiosInstance;
  private clobClient: AxiosInstance;
  private trackedMarkets: Map<string, MarketResolution> = new Map();
  private resolutionHistory: ResolutionEvent[] = [];
  private riskManager: RiskManager;
  private alerts: AlertManager;
  private readonly maxHistorySize = 200;

  constructor(riskManager: RiskManager, alerts: AlertManager) {
    this.riskManager = riskManager;
    this.alerts = alerts;

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
   * Start tracking a market for resolution
   */
  trackMarket(market: PolymarketMarket): void {
    if (this.trackedMarkets.has(market.id)) return;

    const resolution: MarketResolution = {
      marketId: market.id,
      conditionId: market.conditionId,
      question: market.question,
      status: market.closed ? 'RESOLVED' : 'ACTIVE',
      lastChecked: Date.now(),
    };

    this.trackedMarkets.set(market.id, resolution);
    logger.debug(`Tracking market resolution: ${market.question.slice(0, 50)}...`);
  }

  /**
   * Check all tracked markets for resolution status updates
   * Should be called periodically (every 1-5 minutes)
   */
  async checkResolutions(): Promise<ResolutionEvent[]> {
    const events: ResolutionEvent[] = [];
    const positions = this.riskManager.getPositions();

    // Only check markets where we have active positions + recently active markets
    const marketsToCheck = new Set<string>();
    for (const pos of positions) {
      marketsToCheck.add(pos.market);
    }
    // Also check all tracked markets periodically
    for (const [marketId] of this.trackedMarkets) {
      marketsToCheck.add(marketId);
    }

    for (const marketId of marketsToCheck) {
      try {
        const event = await this.checkSingleMarket(marketId);
        if (event) {
          events.push(event);
          this.resolutionHistory.push(event);
          if (this.resolutionHistory.length > this.maxHistorySize) {
            this.resolutionHistory.shift();
          }
        }
      } catch (error: any) {
        logger.debug(`Resolution check failed for ${marketId}: ${error.message}`);
      }
    }

    if (events.length > 0) {
      logger.info(`🏁 ${events.length} resolution event(s) detected`);
    }

    return events;
  }

  /**
   * Check a single market for resolution status change
   */
  private async checkSingleMarket(marketId: string): Promise<ResolutionEvent | null> {
    const tracked = this.trackedMarkets.get(marketId);
    if (!tracked) return null;

    // Don't re-check already resolved markets
    if (tracked.status === 'RESOLVED') return null;

    try {
      // Fetch current market state from Gamma API
      const response = await this.client.get(`/markets/${marketId}`);
      const marketData = response.data;

      if (!marketData) return null;

      const previousStatus = tracked.status;
      let newStatus: ResolutionStatus = tracked.status;

      // Determine new status
      if (marketData.resolved === true || marketData.closed === true) {
        newStatus = 'RESOLVED';
      } else if (marketData.accepting_orders === false) {
        newStatus = 'PENDING_RESOLUTION';
      } else if (marketData.disputed === true) {
        newStatus = 'DISPUTED';
      } else {
        newStatus = 'ACTIVE';
      }

      // No change
      if (newStatus === previousStatus) {
        tracked.lastChecked = Date.now();
        return null;
      }

      // Status changed!
      logger.info(`🔔 Market status changed: ${tracked.question.slice(0, 40)}... ` +
                  `[${previousStatus} → ${newStatus}]`);

      // Update tracked state
      tracked.status = newStatus;
      tracked.lastChecked = Date.now();

      // If resolved, extract winning outcome
      let winningOutcome: string | undefined;
      if (newStatus === 'RESOLVED') {
        winningOutcome = this.extractWinningOutcome(marketData);
        tracked.resolvedAt = Date.now();
        tracked.winningOutcome = winningOutcome;
        tracked.payoutPerShare = 1.0; // Winners get $1 per share on Polymarket

        // Find winning token
        if (marketData.tokens) {
          const winnerToken = marketData.tokens.find(
            (t: any) => t.winner === true || t.outcome === winningOutcome
          );
          if (winnerToken) {
            tracked.winningTokenId = winnerToken.token_id || winnerToken.tokenId;
          }
        }

        // Handle position closure
        await this.handleResolution(tracked);
      }

      const event: ResolutionEvent = {
        marketId,
        previousStatus,
        newStatus,
        winningOutcome,
        timestamp: Date.now(),
      };

      return event;
    } catch (error: any) {
      logger.debug(`Market ${marketId} check failed: ${error.message}`);
      tracked.lastChecked = Date.now();
      return null;
    }
  }

  /**
   * Handle a market resolution - close positions and calculate P&L
   */
  private async handleResolution(resolution: MarketResolution): Promise<PositionResolutionResult | null> {
    const positions = this.riskManager.getPositions();
    const position = positions.find(p => p.market === resolution.marketId);

    if (!position) {
      logger.debug(`No position in resolved market: ${resolution.marketId}`);
      return null;
    }

    // Determine if our position won or lost
    const isWinner = position.outcome === resolution.winningOutcome;
    const exitPrice = isWinner ? 1.0 : 0.0;

    // Close position in risk manager
    const realizedPnl = this.riskManager.closePosition(resolution.marketId, exitPrice);

    const result: PositionResolutionResult = {
      marketId: resolution.marketId,
      position,
      resolution,
      realizedPnl,
      isWinner,
    };

    // Log and alert
    const emoji = isWinner ? '🎉' : '💸';
    logger.info(`${emoji} Position resolved: ${resolution.question.slice(0, 40)}... | ` +
                `Outcome: ${resolution.winningOutcome} | Our side: ${position.outcome} | ` +
                `P&L: $${realizedPnl.toFixed(2)}`);

    // Send alert
    await this.alerts.notifyRisk(
      this.riskManager.getState(),
      `Market resolved: "${resolution.question.slice(0, 50)}..."\n` +
      `Winner: ${resolution.winningOutcome} | Your side: ${position.outcome}\n` +
      `${isWinner ? '✅ WIN' : '❌ LOSS'}: $${realizedPnl.toFixed(2)}`
    );

    return result;
  }

  /**
   * Extract winning outcome from market data
   */
  private extractWinningOutcome(marketData: any): string | undefined {
    // Check tokens for winner flag
    if (marketData.tokens) {
      const winner = marketData.tokens.find((t: any) => t.winner === true);
      if (winner) return winner.outcome;
    }

    // Check resolved_to field
    if (marketData.resolved_to) {
      return marketData.resolved_to;
    }

    // Check resolution field
    if (marketData.resolution) {
      return marketData.resolution;
    }

    return undefined;
  }

  /**
   * Check if a market is safe to trade (not about to resolve)
   */
  isMarketSafeToTrade(marketId: string): { safe: boolean; reason?: string } {
    const tracked = this.trackedMarkets.get(marketId);
    if (!tracked) return { safe: true }; // Unknown market, assume safe

    if (tracked.status === 'RESOLVED') {
      return { safe: false, reason: 'Market already resolved' };
    }

    if (tracked.status === 'PENDING_RESOLUTION') {
      return { safe: false, reason: 'Market pending resolution - no new orders accepted' };
    }

    if (tracked.status === 'DISPUTED') {
      return { safe: false, reason: 'Market is disputed' };
    }

    return { safe: true };
  }

  /**
   * Get time until expected resolution for a market
   */
  getTimeToResolution(market: PolymarketMarket): number | null {
    if (!market.endDate) return null;
    const expiry = new Date(market.endDate).getTime();
    const remaining = expiry - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Check if market is too close to expiry to trade safely
   * Default: don't trade if less than 1 hour to expiry
   */
  isTooCloseToExpiry(market: PolymarketMarket, minHoursBuffer: number = 1): boolean {
    const timeRemaining = this.getTimeToResolution(market);
    if (timeRemaining === null) return false;
    return timeRemaining < minHoursBuffer * 60 * 60 * 1000;
  }

  /**
   * Get resolution statistics (for strategy tuning)
   */
  getResolutionStats(): {
    totalResolved: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnlPerResolution: number;
  } {
    const resolved = this.resolutionHistory.filter(e => e.newStatus === 'RESOLVED');
    const wins = resolved.filter(e => e.pnlImpact && e.pnlImpact > 0).length;
    const losses = resolved.filter(e => e.pnlImpact && e.pnlImpact <= 0).length;
    const totalPnl = resolved.reduce((sum, e) => sum + (e.pnlImpact || 0), 0);

    return {
      totalResolved: resolved.length,
      wins,
      losses,
      winRate: resolved.length > 0 ? wins / resolved.length : 0,
      totalPnl,
      avgPnlPerResolution: resolved.length > 0 ? totalPnl / resolved.length : 0,
    };
  }

  /**
   * Get all tracked markets
   */
  getTrackedMarkets(): MarketResolution[] {
    return Array.from(this.trackedMarkets.values());
  }

  /**
   * Get resolution history
   */
  getResolutionHistory(): ResolutionEvent[] {
    return [...this.resolutionHistory];
  }

  /**
   * Clean up resolved markets from tracking (keep last N for stats)
   */
  cleanup(keepResolved: number = 50): void {
    const resolved: string[] = [];
    for (const [id, market] of this.trackedMarkets) {
      if (market.status === 'RESOLVED') {
        resolved.push(id);
      }
    }

    // Remove oldest resolved entries beyond keepResolved count
    if (resolved.length > keepResolved) {
      const toRemove = resolved.slice(0, resolved.length - keepResolved);
      for (const id of toRemove) {
        this.trackedMarkets.delete(id);
      }
      logger.debug(`Cleaned up ${toRemove.length} old resolved market entries`);
    }
  }
}
