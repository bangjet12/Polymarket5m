import { config } from '../config';
import { SpotPriceFeed } from '../feeds/spotPrice';
import { PolymarketClient } from '../feeds/polymarket';
import { InefficiencyDetector } from '../strategy/inefficiencyDetector';
import { OrderExecutor } from '../execution/orderExecutor';
import { RiskManager } from '../risk/riskManager';
import { AlertManager } from '../utils/alerts';
import { BotStatus, TradeLog, TradeSignal } from '../types';
import { logger } from '../utils/logger';

/**
 * Main Trading Engine
 * Orchestrates the full cycle: fetch -> analyze -> execute -> log
 * Runs on 5-minute intervals, 24/7
 */
export class TradingEngine {
  private priceFeed: SpotPriceFeed;
  private polyClient: PolymarketClient;
  private detector: InefficiencyDetector;
  private executor: OrderExecutor;
  private riskManager: RiskManager;
  private alerts: AlertManager;

  private isRunning = false;
  private startTime = 0;
  private lastCycleTime = 0;
  private cycleCount = 0;
  private tradeHistory: TradeLog[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.priceFeed = new SpotPriceFeed();
    this.polyClient = new PolymarketClient();
    this.detector = new InefficiencyDetector(this.polyClient, this.priceFeed);
    this.executor = new OrderExecutor();
    this.riskManager = new RiskManager();
    this.alerts = new AlertManager();
  }

  /**
   * Start the trading engine
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Trading engine already running');
      return;
    }

    logger.info('═══════════════════════════════════════════════════');
    logger.info('  POLYMARKET BTC 5M TRADER - STARTING');
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`Interval: ${config.strategy.tradingIntervalMs / 1000}s`);
    logger.info(`Min Divergence: ${config.strategy.minDivergence}%`);
    logger.info(`Max Position: $${config.risk.maxPositionSize}`);
    logger.info(`Max Exposure: $${config.risk.maxTotalExposure}`);
    logger.info(`Daily Loss Limit: $${config.risk.dailyLossLimit}`);
    logger.info('═══════════════════════════════════════════════════');

    this.isRunning = true;
    this.startTime = Date.now();

    // Send startup notification
    await this.alerts.notifyStartup();

    // Initial market discovery
    await this.polyClient.fetchBTCMarkets();

    // Connect WebSocket for real-time data
    const markets = this.polyClient.getBTCMarkets();
    const tokenIds = markets.flatMap(m => m.tokens.map(t => t.tokenId)).slice(0, 20);
    if (tokenIds.length > 0) {
      this.polyClient.connectWebSocket(tokenIds);
    }

    // Run first cycle immediately
    await this.runCycle();

    // Set up interval for subsequent cycles
    this.intervalHandle = setInterval(
      () => this.runCycle(),
      config.strategy.tradingIntervalMs
    );

    // Periodic market refresh (every 15 minutes)
    setInterval(() => this.refreshMarkets(), 15 * 60 * 1000);

    // Periodic status update (every hour)
    setInterval(() => this.sendStatusUpdate(), 60 * 60 * 1000);

    logger.info('🚀 Trading engine started successfully');
  }

  /**
   * Stop the trading engine gracefully
   */
  async stop(reason: string = 'Manual shutdown'): Promise<void> {
    logger.info(`Stopping trading engine: ${reason}`);
    this.isRunning = false;

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Cancel all open orders
    await this.executor.cancelAllOrders();

    // Disconnect WebSocket
    this.polyClient.disconnect();

    // Send shutdown notification
    await this.alerts.notifyShutdown(reason);

    logger.info('Trading engine stopped');
  }

  /**
   * Run a single trading cycle
   */
  private async runCycle(): Promise<void> {
    const cycleStart = Date.now();
    this.cycleCount++;

    try {
      logger.info(`\n━━━ Cycle #${this.cycleCount} ━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // Step 1: Get current spot price
      const spotPrice = await this.priceFeed.getSpotPrice();
      logger.info(`💰 BTC Spot: $${spotPrice.price.toFixed(2)}`);

      // Step 2: Sync order status
      await this.executor.syncOrderStatus();

      // Step 3: Detect inefficiencies
      const signals = await this.detector.detectInefficiencies();

      if (signals.length === 0) {
        logger.info('No trading opportunities detected this cycle');
        this.lastCycleTime = Date.now();
        return;
      }

      // Step 4: Execute top signals (respecting risk limits)
      let tradesExecuted = 0;

      for (const signal of signals) {
        // Risk check
        const riskCheck = this.riskManager.canTrade(signal);
        if (!riskCheck.allowed) {
          logger.info(`⏭️ Signal skipped: ${riskCheck.reason}`);
          continue;
        }

        // Adjust size based on risk state
        signal.suggestedSize = this.riskManager.adjustSize(signal);

        // Execute
        const order = await this.executor.executeSignal(signal);
        
        // Register with risk manager
        this.riskManager.registerTrade(signal, order);

        // Log trade
        const tradeLog: TradeLog = {
          id: `trade_${Date.now()}_${tradesExecuted}`,
          signal,
          order,
          executedAt: Date.now(),
          result: order.status === 'OPEN' || order.status === 'FILLED' ? 'SUCCESS' : 'FAILED',
        };
        this.tradeHistory.push(tradeLog);

        // Send alert
        await this.alerts.notifyTrade(signal, tradeLog.result === 'SUCCESS');

        tradesExecuted++;

        // Small delay between orders
        await this.sleep(500);
      }

      const cycleDuration = Date.now() - cycleStart;
      logger.info(`✅ Cycle complete: ${tradesExecuted} trades | ${cycleDuration}ms`);
      this.lastCycleTime = Date.now();

    } catch (error: any) {
      logger.error(`❌ Cycle error: ${error.message}`);
      logger.error(error.stack);

      // If too many cycle errors, halt
      if (this.shouldHalt(error)) {
        this.riskManager.halt(`Repeated cycle errors: ${error.message}`);
        await this.alerts.notifyRisk(
          this.riskManager.getState(),
          `Trading halted due to errors: ${error.message}`
        );
      }
    }
  }

  /**
   * Refresh market list periodically
   */
  private async refreshMarkets(): Promise<void> {
    try {
      await this.polyClient.fetchBTCMarkets();
      const markets = this.polyClient.getBTCMarkets();
      logger.info(`🔄 Markets refreshed: ${markets.length} BTC markets active`);
    } catch (error: any) {
      logger.warn(`Market refresh failed: ${error.message}`);
    }
  }

  /**
   * Send periodic status update
   */
  private async sendStatusUpdate(): Promise<void> {
    const status = this.getStatus();
    await this.alerts.notifyStatus(status);
  }

  /**
   * Get current bot status
   */
  getStatus(): BotStatus {
    return {
      running: this.isRunning,
      uptime: Date.now() - this.startTime,
      lastCycle: this.lastCycleTime,
      lastTrade: this.tradeHistory.length > 0 ? this.tradeHistory[this.tradeHistory.length - 1] : undefined,
      riskState: this.riskManager.getState(),
      spotPrice: this.priceFeed.getLastPrice() || { source: 'aggregate', price: 0, timestamp: 0 },
      activeMarkets: this.polyClient.getBTCMarkets().length,
      openOrders: this.executor.getOpenOrderCount(),
    };
  }

  /**
   * Determine if errors warrant halting
   */
  private shouldHalt(error: Error): boolean {
    // Halt on authentication errors
    if (error.message.includes('401') || error.message.includes('403')) return true;
    // Halt on rate limit
    if (error.message.includes('429')) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
