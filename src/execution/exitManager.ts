import { config } from '../config';
import { Position, Order, TradeSignal } from '../types';
import { PolymarketClient } from '../feeds/polymarket';
import { OrderExecutor } from './orderExecutor';
import { logger } from '../utils/logger';

/**
 * Exit Strategy Manager
 * 
 * Manages active position exits with multiple strategies:
 * 1. Take Profit (TP): Exit when 60-70% of expected move is captured
 * 2. Trailing Stop: Lock in profits with dynamic stop-loss
 * 3. Time-Based Exit: Exit if no movement within 30 minutes
 * 4. Stop Loss: Cut losses at configurable threshold
 * 
 * Runs on every cycle to check if any position should be exited.
 */

export interface ExitRule {
  type: 'TAKE_PROFIT' | 'TRAILING_STOP' | 'TIME_EXIT' | 'STOP_LOSS';
  triggerPrice?: number;
  trailingDistance?: number;   // for trailing stop (as decimal, e.g., 0.05 = 5%)
  timeoutMs?: number;         // for time-based exit
  reason: string;
}

export interface ManagedPosition {
  position: Position;
  signal: TradeSignal;
  entryTime: number;
  highWaterMark: number;      // highest price since entry (for trailing)
  lowWaterMark: number;       // lowest price since entry
  takeProfitPrice: number;
  stopLossPrice: number;
  trailingActivated: boolean;
  trailingStopPrice: number;
  lastChecked: number;
}

export interface ExitDecision {
  shouldExit: boolean;
  rule?: ExitRule;
  exitPrice: number;
  estimatedPnl: number;
}

export class ExitManager {
  private polyClient: PolymarketClient;
  private managedPositions: Map<string, ManagedPosition> = new Map();

  // Configurable parameters
  private readonly takeProfitRatio = 0.65;       // Exit at 65% of max expected gain
  private readonly stopLossRatio = 0.40;         // Stop loss at 40% of position value
  private readonly trailingActivation = 0.05;    // Activate trailing after 5% gain
  private readonly trailingDistance = 0.03;       // Trail by 3%
  private readonly timeoutMs = 30 * 60 * 1000;  // 30 minute timeout
  private readonly breakEvenBuffer = 0.005;      // Move stop to breakeven + 0.5%

  constructor(polyClient: PolymarketClient) {
    this.polyClient = polyClient;
  }

  /**
   * Register a new position for exit management
   */
  registerPosition(position: Position, signal: TradeSignal): void {
    // Calculate take profit and stop loss levels
    const fairValue = signal.suggestedPrice + (signal.divergence / 100);
    const maxGain = Math.abs(fairValue - position.avgEntryPrice);
    const takeProfitPrice = signal.side === 'BUY'
      ? position.avgEntryPrice + (maxGain * this.takeProfitRatio)
      : position.avgEntryPrice - (maxGain * this.takeProfitRatio);

    const stopLossPrice = signal.side === 'BUY'
      ? position.avgEntryPrice * (1 - this.stopLossRatio)
      : position.avgEntryPrice * (1 + this.stopLossRatio);

    const managed: ManagedPosition = {
      position,
      signal,
      entryTime: Date.now(),
      highWaterMark: position.avgEntryPrice,
      lowWaterMark: position.avgEntryPrice,
      takeProfitPrice: Math.max(0.01, Math.min(0.99, takeProfitPrice)),
      stopLossPrice: Math.max(0.01, Math.min(0.99, stopLossPrice)),
      trailingActivated: false,
      trailingStopPrice: stopLossPrice,
      lastChecked: Date.now(),
    };

    this.managedPositions.set(position.market, managed);
    logger.info(`📋 Exit registered: ${position.market.slice(0, 8)}... | ` +
                `TP: ${takeProfitPrice.toFixed(4)} | SL: ${stopLossPrice.toFixed(4)} | ` +
                `Timeout: ${this.timeoutMs / 60000}min`);
  }

  /**
   * Check all managed positions for exit conditions
   * Returns list of positions that should be exited
   */
  async checkExits(): Promise<{ marketId: string; decision: ExitDecision }[]> {
    const exits: { marketId: string; decision: ExitDecision }[] = [];

    for (const [marketId, managed] of this.managedPositions) {
      try {
        const decision = await this.evaluatePosition(managed);
        if (decision.shouldExit) {
          exits.push({ marketId, decision });
          logger.info(`🚪 EXIT SIGNAL: ${marketId.slice(0, 8)}... | ` +
                      `Rule: ${decision.rule?.type} | ` +
                      `Est. PnL: $${decision.estimatedPnl.toFixed(2)} | ` +
                      `Reason: ${decision.rule?.reason}`);
        }
        managed.lastChecked = Date.now();
      } catch (error: any) {
        logger.debug(`Exit check failed for ${marketId}: ${error.message}`);
      }
    }

    return exits;
  }

  /**
   * Evaluate a single position for exit
   */
  private async evaluatePosition(managed: ManagedPosition): Promise<ExitDecision> {
    const { position, signal } = managed;
    const tokenId = position.tokenId;

    // Get current price
    const bbo = this.polyClient.getBBO(tokenId);
    if (!bbo) {
      // Try fetching fresh orderbook
      await this.polyClient.fetchOrderbook(tokenId);
      const freshBbo = this.polyClient.getBBO(tokenId);
      if (!freshBbo) {
        return { shouldExit: false, exitPrice: position.currentPrice, estimatedPnl: 0 };
      }
    }

    const currentBbo = this.polyClient.getBBO(tokenId)!;
    const currentPrice = signal.side === 'BUY'
      ? currentBbo.bid  // selling = hit bids
      : currentBbo.ask; // covering = lift asks

    // Update high/low water marks
    managed.highWaterMark = Math.max(managed.highWaterMark, currentPrice);
    managed.lowWaterMark = Math.min(managed.lowWaterMark, currentPrice);
    position.currentPrice = currentPrice;

    const isBuy = signal.side === 'BUY';

    // --- CHECK 1: Take Profit ---
    if (isBuy && currentPrice >= managed.takeProfitPrice) {
      return {
        shouldExit: true,
        rule: { type: 'TAKE_PROFIT', triggerPrice: managed.takeProfitPrice, reason: `Price ${currentPrice.toFixed(4)} hit TP ${managed.takeProfitPrice.toFixed(4)}` },
        exitPrice: currentPrice,
        estimatedPnl: (currentPrice - position.avgEntryPrice) * position.size,
      };
    }
    if (!isBuy && currentPrice <= managed.takeProfitPrice) {
      return {
        shouldExit: true,
        rule: { type: 'TAKE_PROFIT', triggerPrice: managed.takeProfitPrice, reason: `Price ${currentPrice.toFixed(4)} hit TP ${managed.takeProfitPrice.toFixed(4)}` },
        exitPrice: currentPrice,
        estimatedPnl: (position.avgEntryPrice - currentPrice) * position.size,
      };
    }

    // --- CHECK 2: Stop Loss ---
    if (isBuy && currentPrice <= managed.stopLossPrice) {
      return {
        shouldExit: true,
        rule: { type: 'STOP_LOSS', triggerPrice: managed.stopLossPrice, reason: `Price ${currentPrice.toFixed(4)} hit SL ${managed.stopLossPrice.toFixed(4)}` },
        exitPrice: currentPrice,
        estimatedPnl: (currentPrice - position.avgEntryPrice) * position.size,
      };
    }
    if (!isBuy && currentPrice >= managed.stopLossPrice) {
      return {
        shouldExit: true,
        rule: { type: 'STOP_LOSS', triggerPrice: managed.stopLossPrice, reason: `Price ${currentPrice.toFixed(4)} hit SL ${managed.stopLossPrice.toFixed(4)}` },
        exitPrice: currentPrice,
        estimatedPnl: (position.avgEntryPrice - currentPrice) * position.size,
      };
    }

    // --- CHECK 3: Trailing Stop ---
    const unrealizedGain = isBuy
      ? (currentPrice - position.avgEntryPrice) / position.avgEntryPrice
      : (position.avgEntryPrice - currentPrice) / position.avgEntryPrice;

    // Activate trailing stop after sufficient gain
    if (!managed.trailingActivated && unrealizedGain >= this.trailingActivation) {
      managed.trailingActivated = true;
      managed.trailingStopPrice = isBuy
        ? currentPrice * (1 - this.trailingDistance)
        : currentPrice * (1 + this.trailingDistance);
      logger.info(`📊 Trailing stop activated for ${position.market.slice(0, 8)}... at ${managed.trailingStopPrice.toFixed(4)}`);
    }

    // Update trailing stop (only moves in favorable direction)
    if (managed.trailingActivated) {
      if (isBuy) {
        const newTrail = currentPrice * (1 - this.trailingDistance);
        if (newTrail > managed.trailingStopPrice) {
          managed.trailingStopPrice = newTrail;
        }
        if (currentPrice <= managed.trailingStopPrice) {
          return {
            shouldExit: true,
            rule: { type: 'TRAILING_STOP', triggerPrice: managed.trailingStopPrice, trailingDistance: this.trailingDistance, reason: `Trailing stop hit: ${currentPrice.toFixed(4)} < trail ${managed.trailingStopPrice.toFixed(4)}` },
            exitPrice: currentPrice,
            estimatedPnl: (currentPrice - position.avgEntryPrice) * position.size,
          };
        }
      } else {
        const newTrail = currentPrice * (1 + this.trailingDistance);
        if (newTrail < managed.trailingStopPrice) {
          managed.trailingStopPrice = newTrail;
        }
        if (currentPrice >= managed.trailingStopPrice) {
          return {
            shouldExit: true,
            rule: { type: 'TRAILING_STOP', triggerPrice: managed.trailingStopPrice, trailingDistance: this.trailingDistance, reason: `Trailing stop hit: ${currentPrice.toFixed(4)} > trail ${managed.trailingStopPrice.toFixed(4)}` },
            exitPrice: currentPrice,
            estimatedPnl: (position.avgEntryPrice - currentPrice) * position.size,
          };
        }
      }
    }

    // --- CHECK 4: Time-Based Exit ---
    const timeHeld = Date.now() - managed.entryTime;
    if (timeHeld >= this.timeoutMs) {
      // Only exit on time if position is not significantly profitable
      const pnlPercent = unrealizedGain;
      if (pnlPercent < 0.02) { // less than 2% gain after timeout
        const pnl = isBuy
          ? (currentPrice - position.avgEntryPrice) * position.size
          : (position.avgEntryPrice - currentPrice) * position.size;
        return {
          shouldExit: true,
          rule: { type: 'TIME_EXIT', timeoutMs: this.timeoutMs, reason: `Timeout (${(timeHeld / 60000).toFixed(0)}min) with only ${(pnlPercent * 100).toFixed(1)}% gain` },
          exitPrice: currentPrice,
          estimatedPnl: pnl,
        };
      }
    }

    // No exit condition met
    return { shouldExit: false, exitPrice: currentPrice, estimatedPnl: 0 };
  }

  /**
   * Remove a position from management (after exit or resolution)
   */
  removePosition(marketId: string): void {
    this.managedPositions.delete(marketId);
  }

  /**
   * Get all managed positions
   */
  getManagedPositions(): ManagedPosition[] {
    return Array.from(this.managedPositions.values());
  }

  /**
   * Get count of managed positions
   */
  getCount(): number {
    return this.managedPositions.size;
  }
}
