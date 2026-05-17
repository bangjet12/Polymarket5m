import { config } from '../config';
import { TradeSignal, Order, TradeLog, Position, RiskState } from '../types';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * Paper Trading Mode
 * 
 * Simulates trade execution without placing real orders.
 * Records all signals, simulated fills, and tracks virtual P&L.
 * 
 * Use for:
 * - Validating strategy before going live
 * - Comparing real vs simulated performance
 * - Testing new parameters without risk
 * 
 * Enable via: PAPER_TRADING=true in .env
 * 
 * All paper trades are logged to data/paper_trades.json for analysis.
 */

interface PaperPosition {
  marketId: string;
  tokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  enteredAt: number;
  currentPrice: number;
  unrealizedPnl: number;
}

interface PaperTrade {
  id: string;
  signal: {
    marketId: string;
    question: string;
    side: string;
    outcome: string;
    spotPrice: number;
    divergence: number;
    confidence: number;
    suggestedSize: number;
    suggestedPrice: number;
  };
  entryPrice: number;
  exitPrice?: number;
  size: number;
  enteredAt: number;
  exitedAt?: number;
  pnl?: number;
  pnlPercent?: number;
  exitReason?: string;
  status: 'OPEN' | 'CLOSED';
}

interface PaperStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number;
  sharpeRatio: number;
}

export class PaperTrader {
  private positions: Map<string, PaperPosition> = new Map();
  private tradeHistory: PaperTrade[] = [];
  private virtualBalance: number;
  private startBalance: number;
  private readonly dataPath: string;
  private tradeCounter = 0;

  constructor(startingBalance: number = 1000) {
    this.virtualBalance = startingBalance;
    this.startBalance = startingBalance;
    this.dataPath = path.resolve(__dirname, '../../data/paper_trades.json');

    // Load existing paper trades
    this.loadHistory();
    logger.info(`📝 Paper Trading Mode Active | Balance: $${this.virtualBalance.toFixed(2)} | History: ${this.tradeHistory.length} trades`);
  }

  /**
   * Simulate order execution (instant fill at suggested price)
   */
  executeSignal(signal: TradeSignal): Order {
    this.tradeCounter++;
    const orderId = `paper_${Date.now()}_${this.tradeCounter}`;

    // Simulate fill (assume we get filled at suggested price)
    const fillPrice = signal.suggestedPrice;
    const size = signal.suggestedSize;

    // Check if we have enough balance
    if (size > this.virtualBalance) {
      logger.info(`📝 [PAPER] Order rejected: insufficient balance ($${this.virtualBalance.toFixed(2)} < $${size.toFixed(2)})`);
      return {
        id: orderId,
        market: signal.market.id,
        tokenId: signal.tokenId,
        side: signal.side,
        price: fillPrice,
        size: size,
        type: 'LIMIT',
        status: 'FAILED',
        createdAt: Date.now(),
      };
    }

    // Open position
    const position: PaperPosition = {
      marketId: signal.market.id,
      tokenId: signal.tokenId,
      outcome: signal.outcome,
      side: signal.side,
      entryPrice: fillPrice,
      size: size,
      enteredAt: Date.now(),
      currentPrice: fillPrice,
      unrealizedPnl: 0,
    };

    this.positions.set(signal.market.id, position);
    this.virtualBalance -= size;

    // Record trade
    const trade: PaperTrade = {
      id: orderId,
      signal: {
        marketId: signal.market.id,
        question: signal.market.question.slice(0, 80),
        side: signal.side,
        outcome: signal.outcome,
        spotPrice: signal.spotPrice,
        divergence: signal.divergence,
        confidence: signal.confidence,
        suggestedSize: size,
        suggestedPrice: fillPrice,
      },
      entryPrice: fillPrice,
      size: size,
      enteredAt: Date.now(),
      status: 'OPEN',
    };
    this.tradeHistory.push(trade);

    logger.info(`📝 [PAPER] ${signal.side} ${signal.outcome} | ` +
                `Size: $${size.toFixed(2)} @ ${fillPrice.toFixed(4)} | ` +
                `Market: "${signal.market.question.slice(0, 40)}..." | ` +
                `Confidence: ${(signal.confidence * 100).toFixed(0)}% | ` +
                `Balance: $${this.virtualBalance.toFixed(2)}`);

    // Save
    this.saveHistory();

    return {
      id: orderId,
      market: signal.market.id,
      tokenId: signal.tokenId,
      side: signal.side,
      price: fillPrice,
      size: size,
      type: 'LIMIT',
      status: 'FILLED',
      createdAt: Date.now(),
      filledAt: Date.now(),
    };
  }

  /**
   * Close a paper position
   */
  closePosition(marketId: string, exitPrice: number, reason: string): number {
    const position = this.positions.get(marketId);
    if (!position) return 0;

    // Calculate P&L
    const pnl = position.side === 'BUY'
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;

    // Return capital + profit/loss
    this.virtualBalance += position.size + pnl;
    this.positions.delete(marketId);

    // Update trade history
    const trade = this.tradeHistory.find(t => t.signal.marketId === marketId && t.status === 'OPEN');
    if (trade) {
      trade.exitPrice = exitPrice;
      trade.exitedAt = Date.now();
      trade.pnl = pnl;
      trade.pnlPercent = (pnl / position.size) * 100;
      trade.exitReason = reason;
      trade.status = 'CLOSED';
    }

    const emoji = pnl >= 0 ? '✅' : '❌';
    logger.info(`📝 [PAPER] ${emoji} CLOSE ${position.side} | ` +
                `PnL: $${pnl.toFixed(2)} (${((pnl / position.size) * 100).toFixed(1)}%) | ` +
                `Reason: ${reason} | Balance: $${this.virtualBalance.toFixed(2)}`);

    this.saveHistory();
    return pnl;
  }

  /**
   * Simulate market resolution (position settles at 0 or 1)
   */
  resolvePosition(marketId: string, winningOutcome: string): number {
    const position = this.positions.get(marketId);
    if (!position) return 0;

    const isWinner = position.outcome === winningOutcome;
    const exitPrice = isWinner ? 1.0 : 0.0;
    return this.closePosition(marketId, exitPrice, `Resolution: ${winningOutcome} (${isWinner ? 'WIN' : 'LOSS'})`);
  }

  /**
   * Get comprehensive paper trading statistics
   */
  getStats(): PaperStats {
    const closed = this.tradeHistory.filter(t => t.status === 'CLOSED');
    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const losses = closed.filter(t => (t.pnl || 0) <= 0);

    const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalWinAmount = wins.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLossAmount = Math.abs(losses.reduce((sum, t) => sum + (t.pnl || 0), 0));

    const pnls = closed.map(t => t.pnl || 0);
    const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
    const variance = pnls.length > 1
      ? pnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / (pnls.length - 1)
      : 0;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgPnl / stdDev) * Math.sqrt(252) : 0; // annualized

    return {
      totalTrades: this.tradeHistory.length,
      openTrades: this.positions.size,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      totalPnl,
      avgPnl,
      avgWin: wins.length > 0 ? totalWinAmount / wins.length : 0,
      avgLoss: losses.length > 0 ? totalLossAmount / losses.length : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl || 0)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl || 0)) : 0,
      profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : totalWinAmount > 0 ? Infinity : 0,
      sharpeRatio,
    };
  }

  /**
   * Print performance summary
   */
  printSummary(): void {
    const stats = this.getStats();
    logger.info(`\n═══════════════════════════════════════════════`);
    logger.info(`  📝 PAPER TRADING PERFORMANCE SUMMARY`);
    logger.info(`═══════════════════════════════════════════════`);
    logger.info(`  Total Trades:    ${stats.totalTrades}`);
    logger.info(`  Open/Closed:     ${stats.openTrades} / ${stats.closedTrades}`);
    logger.info(`  Win Rate:        ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}W / ${stats.losses}L)`);
    logger.info(`  Total P&L:       $${stats.totalPnl.toFixed(2)}`);
    logger.info(`  Avg P&L/Trade:   $${stats.avgPnl.toFixed(2)}`);
    logger.info(`  Avg Win:         $${stats.avgWin.toFixed(2)}`);
    logger.info(`  Avg Loss:        $${stats.avgLoss.toFixed(2)}`);
    logger.info(`  Largest Win:     $${stats.largestWin.toFixed(2)}`);
    logger.info(`  Largest Loss:    $${stats.largestLoss.toFixed(2)}`);
    logger.info(`  Profit Factor:   ${stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2)}`);
    logger.info(`  Sharpe Ratio:    ${stats.sharpeRatio.toFixed(2)}`);
    logger.info(`  Balance:         $${this.virtualBalance.toFixed(2)} (start: $${this.startBalance.toFixed(2)})`);
    logger.info(`  Return:          ${(((this.virtualBalance - this.startBalance) / this.startBalance) * 100).toFixed(1)}%`);
    logger.info(`═══════════════════════════════════════════════\n`);
  }

  getBalance(): number {
    return this.virtualBalance;
  }

  getPositions(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  isEnabled(): boolean {
    return process.env.PAPER_TRADING === 'true';
  }

  private saveHistory(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify({
        balance: this.virtualBalance,
        startBalance: this.startBalance,
        trades: this.tradeHistory.slice(-500), // keep last 500
      }, null, 2));
    } catch (e) {
      // silent fail
    }
  }

  private loadHistory(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        this.virtualBalance = data.balance || this.startBalance;
        this.tradeHistory = data.trades || [];
        this.tradeCounter = this.tradeHistory.length;
      }
    } catch (e) {
      // start fresh
    }
  }
}
