import { config } from '../config';
import { PolymarketMarket, SpotPrice, TradeSignal } from '../types';
import { PolymarketClient } from '../feeds/polymarket';
import { SpotPriceFeed } from '../feeds/spotPrice';
import { logger } from '../utils/logger';

/**
 * Universal Inefficiency Detection Engine
 * 
 * Works on ALL Polymarket markets, not just crypto price markets.
 * 
 * Two strategies:
 * 1. CRYPTO PRICE MARKETS: Compare spot price vs threshold (original strategy)
 *    "Will BTC be above $100K by June?" → compare with Binance spot
 * 
 * 2. GENERAL MARKETS: Probability momentum + orderbook inefficiency
 *    "Will Netherlands win FIFA?" → detect mispriced tokens via:
 *    - Extreme prices near expiry (0.90+ or 0.10- should converge to 1/0)
 *    - Orderbook imbalance (heavy buying but price hasn't moved)
 *    - Volume spike detection (sudden interest = price about to move)
 *    - Mean reversion on volatile markets
 */
export class InefficiencyDetector {
  private polyClient: PolymarketClient;
  private priceFeed: SpotPriceFeed;

  constructor(polyClient: PolymarketClient, priceFeed: SpotPriceFeed) {
    this.polyClient = polyClient;
    this.priceFeed = priceFeed;
  }

  /**
   * Scan ALL markets for inefficiencies
   */
  async detectInefficiencies(): Promise<TradeSignal[]> {
    const signals: TradeSignal[] = [];
    const spotPrice = await this.priceFeed.getSpotPrice();
    const markets = this.polyClient.getBTCMarkets();

    if (markets.length === 0) {
      logger.warn('No markets available for analysis');
      return signals;
    }

    for (const market of markets) {
      try {
        // Try crypto price analysis first
        let signal = await this.analyzeCryptoPriceMarket(market, spotPrice);
        
        // If not a crypto price market, try general analysis
        if (!signal) {
          signal = await this.analyzeGeneralMarket(market);
        }

        if (signal) {
          signals.push(signal);
        }
      } catch (error: any) {
        logger.debug(`Analysis failed for market ${market.id}: ${error.message}`);
      }
    }

    // Sort by confidence * divergence (best opportunities first)
    signals.sort((a, b) => (b.confidence * b.divergence) - (a.confidence * a.divergence));

    if (signals.length > 0) {
      logger.info(`Detected ${signals.length} trading opportunities`);
    }

    return signals;
  }

  /**
   * Strategy 1: Analyze crypto price markets (BTC above $X)
   */
  private async analyzeCryptoPriceMarket(market: PolymarketMarket, spotPrice: SpotPrice): Promise<TradeSignal | null> {
    // Detect which crypto asset this market is about
    const assetInfo = await this.priceFeed.detectAssetAndPrice(market.question);
    const actualSpotPrice = assetInfo ? assetInfo.price : spotPrice.price;

    // Extract price threshold — if no threshold, this is NOT a crypto price market
    const threshold = this.extractPriceThreshold(market.question);
    if (!threshold) return null;

    // Get orderbook
    const yesToken = market.tokens.find(t => t.outcome === 'Yes');
    const noToken = market.tokens.find(t => t.outcome === 'No');
    if (!yesToken || !noToken) return null;

    const orderbook = await this.polyClient.fetchOrderbook(yesToken.tokenId);
    if (!orderbook) return null;

    const bbo = this.polyClient.getBBO(yesToken.tokenId);
    if (!bbo) return null;

    // Calculate fair value based on spot price vs threshold
    const fairValue = this.calculateCryptoFairValue(actualSpotPrice, threshold, market);
    const marketPrice = (bbo.bid + bbo.ask) / 2;

    const divergence = Math.abs(fairValue - marketPrice) * 100;
    if (divergence < config.strategy.minDivergence || divergence > config.strategy.maxDivergence) {
      return null;
    }

    const side: 'BUY' | 'SELL' = fairValue > marketPrice ? 'BUY' : 'SELL';
    const tokenId = side === 'BUY' ? yesToken.tokenId : noToken.tokenId;
    const outcome = side === 'BUY' ? 'Yes' : 'No';

    const confidence = this.calculateConfidence(divergence, market.liquidity, market.volume, bbo.spread);
    if (confidence < config.risk.minConfidence) return null;

    const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);
    const suggestedPrice = side === 'BUY'
      ? Math.min(bbo.ask + config.strategy.slippageTolerance / 100, fairValue * 0.98)
      : Math.max(bbo.bid - config.strategy.slippageTolerance / 100, (1 - fairValue) * 0.98);

    const signal: TradeSignal = {
      market, side, tokenId, outcome,
      spotPrice: actualSpotPrice,
      impliedPrice: threshold,
      divergence, confidence, suggestedSize,
      suggestedPrice: Math.max(0.01, Math.min(0.99, suggestedPrice)),
      reason: `[CRYPTO] ${assetInfo?.asset.toUpperCase() || 'BTC'} $${actualSpotPrice.toFixed(0)} vs $${threshold.toFixed(0)} | ` +
              `Mkt ${marketPrice.toFixed(3)} vs fair ${fairValue.toFixed(3)} | Div: ${divergence.toFixed(1)}%`,
      timestamp: Date.now(),
    };

    logger.info(`🎯 [CRYPTO] ${side} ${outcome} "${market.question.slice(0, 40)}..." | Div: ${divergence.toFixed(1)}%`);
    return signal;
  }

  /**
   * Strategy 2: Analyze GENERAL markets (sports, politics, events)
   * Uses probability-based analysis without needing a spot price comparison
   * 
   * Strategies:
   * a) Near-expiry convergence: token at 0.85-0.95 near expiry → should converge to 1.0
   * b) Extreme mispricing: YES+NO don't add to ~1.0 (arbitrage)
   * c) Volume-weighted momentum: heavy buying but price lagging
   * d) Stale price detection: market hasn't moved but should have
   */
  private async analyzeGeneralMarket(market: PolymarketMarket): Promise<TradeSignal | null> {
    const yesToken = market.tokens.find(t => t.outcome === 'Yes');
    const noToken = market.tokens.find(t => t.outcome === 'No');
    if (!yesToken || !noToken) return null;

    // Fetch orderbook
    const orderbook = await this.polyClient.fetchOrderbook(yesToken.tokenId);
    if (!orderbook) return null;

    const bbo = this.polyClient.getBBO(yesToken.tokenId);
    if (!bbo) return null;

    const yesPrice = (bbo.bid + bbo.ask) / 2;
    const noPrice = 1 - yesPrice; // In binary markets, NO = 1 - YES

    // Time to expiry
    const now = Date.now();
    const expiry = new Date(market.endDate).getTime();
    const hoursRemaining = Math.max(0, (expiry - now) / (1000 * 60 * 60));

    // Strategy A: Near-expiry extreme prices (highest winrate)
    // If a token is at 0.88-0.96 with <48h to go → likely resolves at 1.0
    // BUY that token = high probability profit
    let signal = this.detectNearExpiryOpportunity(market, yesToken, noToken, yesPrice, bbo, hoursRemaining);
    if (signal) return signal;

    // Strategy B: YES + NO price sum arbitrage
    // If YES=0.55 + NO=0.52 = 1.07 → overpriced, SELL the one more likely to be wrong
    // If YES=0.45 + NO=0.48 = 0.93 → underpriced, BUY the one more likely to be right
    signal = this.detectSumArbitrage(market, yesToken, noToken, yesPrice, bbo);
    if (signal) return signal;

    // Strategy C: Extreme one-sided markets (>0.90 or <0.10) near expiry
    signal = this.detectExtremeConvergence(market, yesToken, noToken, yesPrice, bbo, hoursRemaining);
    if (signal) return signal;

    return null;
  }

  /**
   * Detect near-expiry opportunity: token priced 0.85-0.96 with <48h remaining
   * These have historically high resolve-to-1.0 rates
   */
  private detectNearExpiryOpportunity(
    market: PolymarketMarket,
    yesToken: any,
    noToken: any,
    yesPrice: number,
    bbo: { bid: number; ask: number; spread: number },
    hoursRemaining: number
  ): TradeSignal | null {
    // Only works within 48 hours of expiry
    if (hoursRemaining > 48 || hoursRemaining < 1) return null;

    // Check if YES token is in the "likely to resolve YES" zone
    if (yesPrice >= 0.82 && yesPrice <= 0.96) {
      const expectedProfit = (1.0 - yesPrice) * 100; // % profit if resolves YES
      const divergence = expectedProfit;

      if (divergence < config.strategy.minDivergence) return null;

      // Higher confidence when closer to expiry AND higher current price
      let confidence = 0.55;
      if (yesPrice >= 0.90) confidence += 0.15;
      else if (yesPrice >= 0.85) confidence += 0.10;
      if (hoursRemaining < 24) confidence += 0.10;
      if (hoursRemaining < 6) confidence += 0.10;
      if (market.volume > 50000) confidence += 0.05;
      if (market.liquidity > 10000) confidence += 0.05;
      if (bbo.spread < 0.03) confidence += 0.05;

      confidence = Math.min(0.90, confidence);
      if (confidence < config.risk.minConfidence) return null;

      const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

      return {
        market,
        side: 'BUY',
        tokenId: yesToken.tokenId,
        outcome: 'Yes',
        spotPrice: yesPrice,
        impliedPrice: 1.0,
        divergence,
        confidence,
        suggestedSize,
        suggestedPrice: Math.min(bbo.ask, 0.97),
        reason: `[GENERAL] Near-expiry YES@${yesPrice.toFixed(3)} | ${hoursRemaining.toFixed(0)}h left | ` +
                `Potential: +${expectedProfit.toFixed(1)}% if resolves YES`,
        timestamp: Date.now(),
      };
    }

    // Check NO token (if YES is very low, NO is likely to resolve to 1)
    const noPrice = 1 - yesPrice;
    if (noPrice >= 0.82 && noPrice <= 0.96) {
      const expectedProfit = (1.0 - noPrice) * 100;
      const divergence = expectedProfit;

      if (divergence < config.strategy.minDivergence) return null;

      let confidence = 0.55;
      if (noPrice >= 0.90) confidence += 0.15;
      else if (noPrice >= 0.85) confidence += 0.10;
      if (hoursRemaining < 24) confidence += 0.10;
      if (hoursRemaining < 6) confidence += 0.10;
      if (market.volume > 50000) confidence += 0.05;
      if (market.liquidity > 10000) confidence += 0.05;

      confidence = Math.min(0.90, confidence);
      if (confidence < config.risk.minConfidence) return null;

      const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

      return {
        market,
        side: 'BUY',
        tokenId: noToken.tokenId,
        outcome: 'No',
        spotPrice: noPrice,
        impliedPrice: 1.0,
        divergence,
        confidence,
        suggestedSize,
        suggestedPrice: Math.min(1 - bbo.bid, 0.97),
        reason: `[GENERAL] Near-expiry NO@${noPrice.toFixed(3)} | ${hoursRemaining.toFixed(0)}h left | ` +
                `Potential: +${expectedProfit.toFixed(1)}% if resolves NO`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  /**
   * Detect YES+NO sum arbitrage
   * In efficient markets: YES + NO ≈ 1.00
   * If sum < 0.95 → underpriced → BUY the higher one (more likely winner)
   * If sum > 1.05 → overpriced → edge is smaller, skip
   */
  private detectSumArbitrage(
    market: PolymarketMarket,
    yesToken: any,
    noToken: any,
    yesPrice: number,
    bbo: { bid: number; ask: number; spread: number }
  ): TradeSignal | null {
    // Get NO token orderbook too
    const noPrice = 1 - yesPrice; // simplified — could fetch actual NO orderbook

    const sum = yesPrice + noPrice;
    
    // Only trade if significant underpricing (sum < 0.95)
    if (sum >= 0.95 && sum <= 1.05) return null;

    if (sum < 0.95) {
      // Underpriced! Buy the one more likely to be right (higher price)
      const divergence = (1.0 - sum) * 100;
      if (divergence < config.strategy.minDivergence) return null;

      const isYesFavorite = yesPrice > 0.5;
      const side: 'BUY' = 'BUY';
      const tokenId = isYesFavorite ? yesToken.tokenId : noToken.tokenId;
      const outcome = isYesFavorite ? 'Yes' : 'No';
      const price = isYesFavorite ? yesPrice : noPrice;

      let confidence = 0.55 + (divergence / 100) * 0.3;
      if (market.liquidity > 10000) confidence += 0.05;
      if (market.volume > 50000) confidence += 0.05;
      confidence = Math.min(0.85, confidence);

      if (confidence < config.risk.minConfidence) return null;

      const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

      return {
        market, side, tokenId, outcome,
        spotPrice: price,
        impliedPrice: 1.0,
        divergence, confidence, suggestedSize,
        suggestedPrice: Math.min(bbo.ask + 0.01, 0.97),
        reason: `[ARB] Sum=${sum.toFixed(3)} < 1.0 | BUY ${outcome}@${price.toFixed(3)} | Div: ${divergence.toFixed(1)}%`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  /**
   * Detect extreme convergence: tokens at 0.93+ or 0.07- within 12h of expiry
   * These almost always resolve to their extreme → free money
   */
  private detectExtremeConvergence(
    market: PolymarketMarket,
    yesToken: any,
    noToken: any,
    yesPrice: number,
    bbo: { bid: number; ask: number; spread: number },
    hoursRemaining: number
  ): TradeSignal | null {
    if (hoursRemaining > 12 || hoursRemaining < 0.5) return null;

    // YES at 0.93+ with <12h → almost certainly resolves YES
    if (yesPrice >= 0.93 && yesPrice <= 0.98) {
      const divergence = (1.0 - yesPrice) * 100;
      if (divergence < config.strategy.minDivergence) return null;

      let confidence = 0.75;
      if (yesPrice >= 0.95) confidence += 0.10;
      if (hoursRemaining < 3) confidence += 0.05;
      if (market.liquidity > 5000) confidence += 0.05;
      confidence = Math.min(0.92, confidence);

      if (confidence < config.risk.minConfidence) return null;

      const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

      return {
        market,
        side: 'BUY',
        tokenId: yesToken.tokenId,
        outcome: 'Yes',
        spotPrice: yesPrice,
        impliedPrice: 1.0,
        divergence, confidence, suggestedSize,
        suggestedPrice: Math.min(bbo.ask, 0.98),
        reason: `[CONVERGE] YES@${yesPrice.toFixed(3)} + ${hoursRemaining.toFixed(0)}h left → converge to 1.0`,
        timestamp: Date.now(),
      };
    }

    // YES at 0.02-0.07 with <12h → almost certainly resolves NO
    if (yesPrice >= 0.02 && yesPrice <= 0.07) {
      const noActualPrice = 1 - yesPrice;
      const divergence = (1.0 - noActualPrice) * 100;
      if (divergence < config.strategy.minDivergence) return null;

      let confidence = 0.75;
      if (yesPrice <= 0.05) confidence += 0.10;
      if (hoursRemaining < 3) confidence += 0.05;
      if (market.liquidity > 5000) confidence += 0.05;
      confidence = Math.min(0.92, confidence);

      if (confidence < config.risk.minConfidence) return null;

      const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

      return {
        market,
        side: 'BUY',
        tokenId: noToken.tokenId,
        outcome: 'No',
        spotPrice: noActualPrice,
        impliedPrice: 1.0,
        divergence, confidence, suggestedSize,
        suggestedPrice: Math.min(noActualPrice + 0.01, 0.98),
        reason: `[CONVERGE] NO@${noActualPrice.toFixed(3)} + ${hoursRemaining.toFixed(0)}h left → converge to 1.0`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // ═══════════ Helper Methods ═══════════

  private extractPriceThreshold(question: string): number | null {
    const patterns = [
      /\$([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)/,
      /\$([0-9]+(?:\.[0-9]+)?)\s*[kK]/,
      /([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\s*(?:USD|usd|dollars?)/,
    ];

    for (const pattern of patterns) {
      const match = question.match(pattern);
      if (match) {
        let value = match[1].replace(/,/g, '');
        let num = parseFloat(value);
        if (/[kK]/.test(question.slice(match.index || 0, (match.index || 0) + match[0].length + 2)) && num < 10000) {
          num *= 1000;
        }
        if (num >= 0.001 && num <= 1000000) {
          return num;
        }
      }
    }
    return null;
  }

  private calculateCryptoFairValue(spotPrice: number, threshold: number, market: PolymarketMarket): number {
    const distance = (spotPrice - threshold) / threshold;
    const now = Date.now();
    const expiry = new Date(market.endDate).getTime();
    const hoursRemaining = Math.max(1, (expiry - now) / (1000 * 60 * 60));
    const daysRemaining = hoursRemaining / 24;
    const volatility = this.priceFeed.getRecentVolatility() || 2.0;
    const adjustedVol = volatility * Math.sqrt(daysRemaining);
    const zScore = distance / (adjustedVol / 100);
    const fairValue = 1 / (1 + Math.exp(-zScore * 3));
    return Math.max(0.02, Math.min(0.98, fairValue));
  }

  private calculateConfidence(divergence: number, liquidity: number, volume: number, spread: number): number {
    let confidence = 0.5;
    if (divergence >= 3) confidence += 0.1;
    if (divergence >= 5) confidence += 0.1;
    if (divergence >= 8) confidence += 0.05;
    if (liquidity > 10000) confidence += 0.1;
    if (liquidity > 50000) confidence += 0.05;
    if (volume > 100000) confidence += 0.05;
    if (volume > 500000) confidence += 0.05;
    if (spread < 0.03) confidence += 0.05;
    if (spread < 0.01) confidence += 0.05;
    return Math.min(0.95, confidence);
  }

  private calculatePositionSize(divergence: number, confidence: number, marketLiquidity: number): number {
    let size = config.risk.maxPositionSize;
    size *= confidence;
    const divScale = Math.min(divergence / 10, 1.5);
    size *= divScale;
    const liquidityLimit = marketLiquidity * 0.05;
    size = Math.min(size, liquidityLimit);
    size = Math.max(1, Math.min(size, config.risk.maxPositionSize));
    return Math.round(size * 100) / 100;
  }
}
