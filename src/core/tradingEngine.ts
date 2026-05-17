import { config } from '../config';
import { SpotPriceFeed } from '../feeds/spotPrice';
import { PolymarketClient } from '../feeds/polymarket';
import { HistoricalDataFeed } from '../feeds/historicalData';
import { ResolutionTracker } from '../feeds/resolutionTracker';
import { WhaleTracker } from '../feeds/whaleTracker';
import { InefficiencyDetector } from '../strategy/inefficiencyDetector';
import { MLConfidenceLayer } from '../strategy/mlConfidence';
import { TimeDecayEngine } from '../strategy/timeDecay';
import { MomentumFilter } from '../strategy/momentumFilter';
import { OrderbookImbalanceAnalyzer } from '../strategy/orderbookImbalance';
import { MultiTimeframeConfirmation } from '../strategy/multiTimeframe';
import { MarketRegimeDetector } from '../strategy/marketRegime';
import { AdaptiveParameterTuner } from '../strategy/adaptiveParams';
import { OrderExecutor } from '../execution/orderExecutor';
import { ExitManager } from '../execution/exitManager';
import { RiskManager } from '../risk/riskManager';
import { KellyCriterion } from '../risk/kellyCriterion';
import { AlertManager } from '../utils/alerts';
import { PaperTrader } from './paperTrader';
import { BotStatus, TradeLog, TradeSignal } from '../types';
import { logger } from '../utils/logger';

/**
 * Main Trading Engine v3
 * 
 * Full pipeline per cycle:
 * 1. Fetch BTC spot (5 exchanges) + sync orders
 * 2. Detect market regime (TRENDING/RANGING/VOLATILE/QUIET)
 * 3. Check resolutions + exit managed positions (TP/SL/trailing/time)
 * 4. Detect inefficiencies (spot vs implied)
 * 5. For each signal, apply 10-layer confidence filter:
 *    a) Market regime gate (blocks trades in VOLATILE regime)
 *    b) Adaptive parameter check (dynamic MIN_CONFIDENCE/MIN_DIVERGENCE)
 *    c) Resolution safety check
 *    d) Time decay validation
 *    e) Momentum filter (1H/4H trend alignment)
 *    f) Orderbook imbalance analysis
 *    g) Multi-timeframe confirmation (divergence trend)
 *    h) Whale/smart money tracker
 *    i) ML confidence layer (12-feature logistic regression)
 *    j) Market regime alignment (signal vs trend direction)
 * 6. Kelly Criterion position sizing
 * 7. Risk check → Execute (real or paper)
 * 8. Register with Exit Manager + record for adaptive tuning
 * 
 * Runs on 5-minute intervals, 24/7
 */
export class TradingEngine {
  // Data feeds
  private priceFeed: SpotPriceFeed;
  private polyClient: PolymarketClient;
  private historicalFeed: HistoricalDataFeed;
  private resolutionTracker: ResolutionTracker;
  private whaleTracker: WhaleTracker;

  // Strategy layers
  private detector: InefficiencyDetector;
  private mlConfidence: MLConfidenceLayer;
  private timeDecay: TimeDecayEngine;
  private momentumFilter: MomentumFilter;
  private orderbookImbalance: OrderbookImbalanceAnalyzer;
  private multiTimeframe: MultiTimeframeConfirmation;
  private marketRegime: MarketRegimeDetector;
  private adaptiveParams: AdaptiveParameterTuner;

  // Execution
  private executor: OrderExecutor;
  private exitManager: ExitManager;
  private paperTrader: PaperTrader;

  // Risk & alerts
  private riskManager: RiskManager;
  private kellyCriterion: KellyCriterion;
  private alerts: AlertManager;

  // State
  private isRunning = false;
  private isPaperMode = false;
  private startTime = 0;
  private lastCycleTime = 0;
  private cycleCount = 0;
  private tradeHistory: TradeLog[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor() {
    this.priceFeed = new SpotPriceFeed();
    this.polyClient = new PolymarketClient();
    this.historicalFeed = new HistoricalDataFeed();
    this.riskManager = new RiskManager();
    this.alerts = new AlertManager();
    this.resolutionTracker = new ResolutionTracker(this.riskManager, this.alerts);
    this.whaleTracker = new WhaleTracker();
    this.detector = new InefficiencyDetector(this.polyClient, this.priceFeed);
    this.mlConfidence = new MLConfidenceLayer(this.historicalFeed);
    this.timeDecay = new TimeDecayEngine();
    this.momentumFilter = new MomentumFilter();
    this.orderbookImbalance = new OrderbookImbalanceAnalyzer(this.polyClient);
    this.multiTimeframe = new MultiTimeframeConfirmation();
    this.marketRegime = new MarketRegimeDetector();
    this.adaptiveParams = new AdaptiveParameterTuner();
    this.executor = new OrderExecutor();
    this.exitManager = new ExitManager(this.polyClient);
    this.paperTrader = new PaperTrader();
    this.kellyCriterion = new KellyCriterion(
      parseFloat(process.env.PAPER_STARTING_BALANCE || '15')
    );

    // Check paper trading mode
    this.isPaperMode = process.env.PAPER_TRADING === 'true';
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
    logger.info('  POLYMARKET BTC 5M TRADER v3 - STARTING');
    logger.info(`  Mode: ${this.isPaperMode ? '📝 PAPER TRADING' : '💰 LIVE TRADING'}`);
    logger.info('═══════════════════════════════════════════════════');
    logger.info(`Interval: ${config.strategy.tradingIntervalMs / 1000}s`);
    logger.info(`Min Divergence: ${config.strategy.minDivergence}%`);
    logger.info(`Max Position: $${config.risk.maxPositionSize}`);
    logger.info(`Max Exposure: $${config.risk.maxTotalExposure}`);
    logger.info(`Daily Loss Limit: $${config.risk.dailyLossLimit}`);
    logger.info(`Filters: Momentum + Orderbook + MTF + Whale + ML + TimeDecay + Regime + Kelly + Adaptive`);
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

    // Pre-warm momentum cache
    await this.momentumFilter.getMomentum();

    // Run first cycle immediately
    await this.runCycle();

    // Set up interval for subsequent cycles
    this.intervalHandle = setInterval(
      () => this.runCycle(),
      config.strategy.tradingIntervalMs
    );

    // Periodic market refresh (every 15 minutes)
    setInterval(() => this.refreshMarkets(), 15 * 60 * 1000);

    // Periodic resolution check (every 2 minutes)
    setInterval(() => this.checkResolutions(), 2 * 60 * 1000);

    // Periodic status update (every hour)
    setInterval(() => this.sendStatusUpdate(), 60 * 60 * 1000);

    // Periodic cleanup (every 30 minutes)
    setInterval(() => {
      this.historicalFeed.cleanCache();
      this.resolutionTracker.cleanup();
      this.whaleTracker.clearCache();
    }, 30 * 60 * 1000);

    logger.info('🚀 Trading engine v3 started successfully');
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
    if (!this.isPaperMode) {
      await this.executor.cancelAllOrders();
    }

    // Disconnect WebSocket
    this.polyClient.disconnect();

    // Print paper trading summary if in paper mode
    if (this.isPaperMode) {
      this.paperTrader.printSummary();
    }

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
      logger.info(`\n━━━ Cycle #${this.cycleCount} ${this.isPaperMode ? '[PAPER]' : '[LIVE]'} ━━━━━━━━━━━━━━━━━━`);

      // ═══ STEP 1: Fetch prices & sync ═══
      const spotPrice = await this.priceFeed.getSpotPrice();
      logger.info(`💰 BTC Spot: $${spotPrice.price.toFixed(2)}`);

      if (!this.isPaperMode) {
        await this.executor.syncOrderStatus();
      }

      // ═══ STEP 2: Check exits on managed positions ═══
      const exitDecisions = await this.exitManager.checkExits();
      for (const { marketId, decision } of exitDecisions) {
        if (decision.shouldExit) {
          if (this.isPaperMode) {
            this.paperTrader.closePosition(marketId, decision.exitPrice, decision.rule?.reason || 'Exit rule');
          } else {
            this.riskManager.closePosition(marketId, decision.exitPrice);
          }
          this.exitManager.removePosition(marketId);
          logger.info(`🚪 Exited: ${marketId.slice(0, 8)}... | Rule: ${decision.rule?.type} | PnL: $${decision.estimatedPnl.toFixed(2)}`);
        }
      }

      // ═══ STEP 3: Check resolutions ═══
      await this.checkResolutions();

      // ═══ STEP 4: Detect inefficiencies ═══
      const signals = await this.detector.detectInefficiencies();

      if (signals.length === 0) {
        logger.info('No trading opportunities detected this cycle');
        this.lastCycleTime = Date.now();
        return;
      }

      // ═══ STEP 4b: Market Regime Detection ═══
      const regime = await this.marketRegime.detectRegime();

      // Block trading in VOLATILE regime
      if (!regime.tradingAllowed) {
        logger.info(`🛑 [Regime] ${regime.reason}`);
        this.lastCycleTime = Date.now();
        return;
      }

      // ═══ STEP 4c: Adaptive Parameter Check ═══
      const adaptiveP = this.adaptiveParams.getParams();

      // Check if current hour is historically bad
      if (this.adaptiveParams.isCurrentHourBad()) {
        logger.info(`⏭️ [Adaptive] Current hour historically unprofitable - skipping cycle`);
        this.lastCycleTime = Date.now();
        return;
      }

      // ═══ STEP 4d: Kelly Pause Check ═══
      const kellyPause = this.kellyCriterion.shouldPause();
      if (kellyPause.pause) {
        logger.info(`⏸️ [Kelly] ${kellyPause.reason}`);
        this.lastCycleTime = Date.now();
        return;
      }

      // ═══ STEP 5: Multi-layer filtering & execution ═══
      const priceDispersion = await this.priceFeed.getPriceDispersion();
      let tradesExecuted = 0;

      for (const signal of signals) {
        // ──── Filter A: Resolution Safety ────
        const safetyCheck = this.resolutionTracker.isMarketSafeToTrade(signal.market.id);
        if (!safetyCheck.safe) {
          logger.info(`⏭️ [Resolution] ${safetyCheck.reason}`);
          continue;
        }

        if (this.resolutionTracker.isTooCloseToExpiry(signal.market, 1)) {
          logger.info(`⏭️ [Expiry] Too close to resolution (<1h)`);
          continue;
        }

        // ──── Filter B: Momentum Alignment (1H/4H) ────
        const momentumCheck = await this.momentumFilter.checkMomentumAlignment(signal);
        if (!momentumCheck.allowed) {
          logger.info(`⏭️ [Momentum] ${momentumCheck.reason}`);
          continue;
        }
        logger.info(`📈 Momentum: ×${momentumCheck.confidenceMultiplier.toFixed(2)} | ${momentumCheck.reason}`);

        // ──── Filter C: Multi-Timeframe Confirmation ────
        const bbo = this.polyClient.getBBO(signal.tokenId);
        const marketPrice = bbo ? (bbo.bid + bbo.ask) / 2 : signal.suggestedPrice;
        this.multiTimeframe.recordSnapshot(signal, marketPrice);
        const mtfResult = this.multiTimeframe.analyzeSignal(signal);
        logger.info(`📐 MTF: ×${mtfResult.confidenceMultiplier.toFixed(2)} | ${mtfResult.reason}`);

        // If divergence is shrinking fast, skip
        if (mtfResult.trend === 'SHRINKING' && mtfResult.divergenceSlope < -0.5) {
          logger.info(`⏭️ [MTF] Divergence closing too fast (slope=${mtfResult.divergenceSlope.toFixed(2)})`);
          continue;
        }

        // ──── Filter D: Orderbook Imbalance ────
        const obResult = await this.orderbookImbalance.analyzeImbalance(signal);
        logger.info(`📊 OB: ×${obResult.confidenceMultiplier.toFixed(2)} | ${obResult.reason}`);

        // ──── Filter E: Whale Tracker ────
        const whaleResult = await this.whaleTracker.analyzeWhaleActivity(signal);
        logger.info(`🐋 Whale: ×${whaleResult.confidenceMultiplier.toFixed(2)} | ${whaleResult.reason}`);

        // ──── Filter F: Time Decay ────
        const decayMultiplier = this.timeDecay.getTimeDecayMultiplier(signal.market, signal.spotPrice, signal.impliedPrice);
        if (decayMultiplier < 0.5) {
          logger.info(`⏭️ [TimeDecay] Low predictability (×${decayMultiplier.toFixed(2)})`);
          continue;
        }

        const decayScore = this.timeDecay.scoreTimeDecayOpportunity(
          signal.market, signal.spotPrice, signal.impliedPrice,
          signal.suggestedPrice, this.priceFeed.getRecentVolatility() || 2.0
        );

        // ──── Filter G: ML Confidence ────
        const yesToken = signal.market.tokens.find(t => t.outcome === 'Yes');
        const history = yesToken
          ? await this.historicalFeed.getMarketHistory(signal.market.id, yesToken.tokenId)
          : null;

        const mlResult = this.mlConfidence.getMLConfidence(signal, history, priceDispersion);
        logger.info(`🧠 ML: ${mlResult.explanation}`);

        // ═══ COMBINE ALL CONFIDENCE MULTIPLIERS ═══
        const baseConfidence = signal.confidence;
        let finalConfidence = mlResult.adjustedConfidence;

        // Apply all multipliers
        finalConfidence *= momentumCheck.confidenceMultiplier;
        finalConfidence *= mtfResult.confidenceMultiplier;
        finalConfidence *= obResult.confidenceMultiplier;
        finalConfidence *= whaleResult.confidenceMultiplier;
        finalConfidence *= (1 + decayScore.score / 200);

        // ──── Filter H: Market Regime Alignment ────
        const regimeAlignment = this.marketRegime.isSignalAlignedWithRegime(signal.side, signal.outcome);
        finalConfidence *= regimeAlignment.multiplier;
        finalConfidence *= regime.confidenceMultiplier;
        logger.info(`🌡️ Regime: ×${(regimeAlignment.multiplier * regime.confidenceMultiplier).toFixed(2)} | ${regimeAlignment.reason}`);

        // ──── Filter I: Adaptive Regime Multiplier ────
        const adaptiveRegimeM = this.adaptiveParams.getRegimeMultiplier(regime.regime);
        finalConfidence *= adaptiveRegimeM;

        // ──── Filter J: Hourly Performance Multiplier ────
        const hourlyM = this.adaptiveParams.getHourlyMultiplier();
        finalConfidence *= hourlyM;

        // Clamp
        finalConfidence = Math.max(0, Math.min(0.98, finalConfidence));
        signal.confidence = finalConfidence;

        logger.info(`🎯 Final Confidence: ${(baseConfidence * 100).toFixed(0)}% → ${(finalConfidence * 100).toFixed(0)}% (10-layer filtered)`);

        // ──── Adaptive MIN_CONFIDENCE Gate ────
        if (finalConfidence < adaptiveP.minConfidence) {
          logger.info(`⏭️ [Adaptive] Confidence ${(finalConfidence * 100).toFixed(0)}% < adaptive min ${(adaptiveP.minConfidence * 100).toFixed(0)}%`);
          continue;
        }

        // ──── Adaptive MIN_DIVERGENCE Gate ────
        if (signal.divergence < adaptiveP.minDivergence) {
          logger.info(`⏭️ [Adaptive] Divergence ${signal.divergence.toFixed(1)}% < adaptive min ${adaptiveP.minDivergence.toFixed(1)}%`);
          continue;
        }

        // ──── Risk Check ────
        const riskCheck = this.riskManager.canTrade(signal);
        if (!riskCheck.allowed) {
          logger.info(`⏭️ [Risk] ${riskCheck.reason}`);
          continue;
        }

        // Track market for resolution
        this.resolutionTracker.trackMarket(signal.market);

        // ═══ KELLY CRITERION POSITION SIZING ═══
        const currentBalance = this.isPaperMode
          ? this.paperTrader.getBalance()
          : config.risk.maxTotalExposure - this.riskManager.getState().totalExposure;

        const kellySize = this.kellyCriterion.calculateSize(signal, currentBalance);
        signal.suggestedSize = Math.min(kellySize.size, this.riskManager.adjustSize(signal));
        signal.suggestedSize = Math.min(signal.suggestedSize, currentBalance * regime.maxPositionPercent);

        logger.info(`📐 Kelly: $${kellySize.size.toFixed(2)} (${kellySize.riskLevel}) | ${kellySize.reason}`);

        // ═══ EXECUTE ═══
        let order;
        if (this.isPaperMode) {
          order = this.paperTrader.executeSignal(signal);
        } else {
          order = await this.executor.executeSignal(signal);
        }

        // Register with risk manager
        this.riskManager.registerTrade(signal, order);

        // Register with exit manager for TP/SL/trailing management
        if (order.status === 'OPEN' || order.status === 'FILLED') {
          const position = {
            market: signal.market.id,
            tokenId: signal.tokenId,
            outcome: signal.outcome,
            size: signal.suggestedSize,
            avgEntryPrice: signal.suggestedPrice,
            currentPrice: signal.suggestedPrice,
            unrealizedPnl: 0,
            openedAt: Date.now(),
          };
          this.exitManager.registerPosition(position, signal);
        }

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
        await this.sleep(500);
      }

      const cycleDuration = Date.now() - cycleStart;
      logger.info(`✅ Cycle complete: ${tradesExecuted} trades | ${cycleDuration}ms | ` +
                  `Managed positions: ${this.exitManager.getCount()}`);
      this.lastCycleTime = Date.now();

      // Print paper stats every 10 cycles
      if (this.isPaperMode && this.cycleCount % 10 === 0) {
        this.paperTrader.printSummary();
      }

    } catch (error: any) {
      logger.error(`❌ Cycle error: ${error.message}`);
      logger.error(error.stack);

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

      for (const market of markets) {
        this.resolutionTracker.trackMarket(market);
      }

      // Clean up multi-timeframe data for inactive markets
      const activeIds = new Set(markets.map(m => m.id));
      this.multiTimeframe.cleanup(activeIds);

      logger.info(`🔄 Markets refreshed: ${markets.length} BTC markets active`);
    } catch (error: any) {
      logger.warn(`Market refresh failed: ${error.message}`);
    }
  }

  /**
   * Check market resolutions and train ML model from outcomes
   */
  private async checkResolutions(): Promise<void> {
    try {
      const events = await this.resolutionTracker.checkResolutions();

      for (const event of events) {
        if (event.newStatus === 'RESOLVED') {
          // Close paper position if in paper mode
          if (this.isPaperMode && event.winningOutcome) {
            this.paperTrader.resolvePosition(event.marketId, event.winningOutcome);
          }

          // Remove from exit manager
          this.exitManager.removePosition(event.marketId);

          // Train ML model + update Kelly + adaptive params
          if (event.pnlImpact !== undefined) {
            const relatedTrade = this.tradeHistory.find(t => t.signal.market.id === event.marketId);
            if (relatedTrade) {
              const history = this.historicalFeed.getCachedHistory(event.marketId);
              const wasProfit = (event.pnlImpact || 0) > 0;

              // Train ML
              this.mlConfidence.train(relatedTrade.signal, history, 0, wasProfit);

              // Update Kelly stats
              this.kellyCriterion.recordResult(wasProfit, event.pnlImpact || 0);

              // Update adaptive parameters
              const cachedRegime = this.marketRegime.getCachedRegime();
              this.adaptiveParams.recordTrade({
                win: wasProfit,
                pnl: event.pnlImpact || 0,
                confidence: relatedTrade.signal.confidence,
                regime: cachedRegime?.regime || 'RANGING',
              });

              logger.info(`🧠 Trained: ${wasProfit ? 'WIN' : 'LOSS'} $${(event.pnlImpact || 0).toFixed(2)} | ${event.marketId.slice(0, 8)}...`);
            }
          }
        }
      }

      const stats = this.resolutionTracker.getResolutionStats();
      if (stats.totalResolved > 0 && stats.totalResolved % 5 === 0) {
        logger.info(`📊 Stats: ${stats.totalResolved} resolved | WR: ${(stats.winRate * 100).toFixed(0)}% | P&L: $${stats.totalPnl.toFixed(2)}`);
      }
    } catch (error: any) {
      logger.warn(`Resolution check error: ${error.message}`);
    }
  }

  private async sendStatusUpdate(): Promise<void> {
    const status = this.getStatus();
    await this.alerts.notifyStatus(status);
  }

  getStatus(): BotStatus {
    return {
      running: this.isRunning,
      uptime: Date.now() - this.startTime,
      lastCycle: this.lastCycleTime,
      lastTrade: this.tradeHistory.length > 0 ? this.tradeHistory[this.tradeHistory.length - 1] : undefined,
      riskState: this.riskManager.getState(),
      spotPrice: this.priceFeed.getLastPrice() || { source: 'aggregate', price: 0, timestamp: 0 },
      activeMarkets: this.polyClient.getBTCMarkets().length,
      openOrders: this.isPaperMode ? this.paperTrader.getPositions().length : this.executor.getOpenOrderCount(),
    };
  }

  private shouldHalt(error: Error): boolean {
    if (error.message.includes('401') || error.message.includes('403')) return true;
    if (error.message.includes('429')) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
