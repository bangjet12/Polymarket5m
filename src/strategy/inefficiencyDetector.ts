import { config } from '../config';
import { PolymarketMarket, SpotPrice, TradeSignal } from '../types';
import { PolymarketClient } from '../feeds/polymarket';
import { SpotPriceFeed } from '../feeds/spotPrice';
import { logger } from '../utils/logger';

/**
 * Inefficiency Detection Engine
 * 
 * Compares BTC spot price against Polymarket binary market implied prices.
 * Polymarket BTC markets are typically:
 * - "Will BTC be above $X by date Y?" 
 * - "Will BTC hit $X in [timeframe]?"
 * 
 * Strategy: If spot is $67,000 and "BTC above $65,000 by Friday" is trading at 0.70
 * but should be 0.85+ given current price and momentum, that's an inefficiency.
 */
export class InefficiencyDetector {
  private polyClient: PolymarketClient;
  private priceFeed: SpotPriceFeed;

  constructor(polyClient: PolymarketClient, priceFeed: SpotPriceFeed) {
    this.polyClient = polyClient;
    this.priceFeed = priceFeed;
  }

  /**
   * Scan all BTC markets for inefficiencies
   */
  async detectInefficiencies(): Promise<TradeSignal[]> {
    const signals: TradeSignal[] = [];
    const spotPrice = await this.priceFeed.getSpotPrice();
    const markets = this.polyClient.getBTCMarkets();

    if (markets.length === 0) {
      logger.warn('No BTC markets available for analysis');
      return signals;
    }

    for (const market of markets) {
      try {
        const signal = await this.analyzeMarket(market, spotPrice);
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
   * Analyze a single market for inefficiency
   */
  private async analyzeMarket(market: PolymarketMarket, spotPrice: SpotPrice): Promise<TradeSignal | null> {
    // Detect which crypto asset this market is about and get its spot price
    const assetInfo = await this.priceFeed.detectAssetAndPrice(market.question);
    const actualSpotPrice = assetInfo ? assetInfo.price : spotPrice.price;

    // Extract price threshold from market question
    const threshold = this.extractPriceThreshold(market.question);
    if (!threshold) return null;

    // Get orderbook for the Yes token
    const yesToken = market.tokens.find(t => t.outcome === 'Yes');
    const noToken = market.tokens.find(t => t.outcome === 'No');
    if (!yesToken || !noToken) return null;

    // Fetch fresh orderbook
    const orderbook = await this.polyClient.fetchOrderbook(yesToken.tokenId);
    if (!orderbook) return null;

    const bbo = this.polyClient.getBBO(yesToken.tokenId);
    if (!bbo) return null;

    // Calculate fair value based on spot price distance and time
    const fairValue = this.calculateFairValue(actualSpotPrice, threshold, market);
    const marketPrice = (bbo.bid + bbo.ask) / 2;

    // Calculate divergence
    const divergence = Math.abs(fairValue - marketPrice) * 100; // in percentage points
    
    // Check if divergence meets our threshold
    if (divergence < config.strategy.minDivergence || divergence > config.strategy.maxDivergence) {
      return null;
    }

    // Determine trade direction
    const side: 'BUY' | 'SELL' = fairValue > marketPrice ? 'BUY' : 'SELL';
    const tokenId = side === 'BUY' ? yesToken.tokenId : noToken.tokenId;
    const outcome = side === 'BUY' ? 'Yes' : 'No';

    // Calculate confidence score
    const confidence = this.calculateConfidence(
      divergence,
      market.liquidity,
      market.volume,
      bbo.spread,
      spotPrice
    );

    if (confidence < config.risk.minConfidence) {
      return null;
    }

    // Calculate suggested position size
    const suggestedSize = this.calculatePositionSize(divergence, confidence, market.liquidity);

    // Calculate limit price with slippage
    const suggestedPrice = side === 'BUY'
      ? Math.min(bbo.ask + config.strategy.slippageTolerance / 100, fairValue * 0.98)
      : Math.max(bbo.bid - config.strategy.slippageTolerance / 100, (1 - fairValue) * 0.98);

    const signal: TradeSignal = {
      market,
      side,
      tokenId,
      outcome,
      spotPrice: actualSpotPrice,
      impliedPrice: threshold,
      divergence,
      confidence,
      suggestedSize,
      suggestedPrice: Math.max(0.01, Math.min(0.99, suggestedPrice)),
      reason: `${assetInfo?.asset.toUpperCase() || 'BTC'} spot $${actualSpotPrice.toFixed(2)} vs threshold $${threshold.toFixed(2)} | ` +
              `Market ${marketPrice.toFixed(3)} vs fair ${fairValue.toFixed(3)} | ` +
              `Divergence: ${divergence.toFixed(1)}%`,
      timestamp: Date.now(),
    };

    logger.info(`🎯 Signal: ${side} ${outcome} on "${market.question.slice(0, 50)}..." ` +
                `| ${assetInfo?.asset.toUpperCase() || 'BTC'} $${actualSpotPrice.toFixed(2)} ` +
                `| Div: ${divergence.toFixed(1)}% | Conf: ${(confidence * 100).toFixed(0)}%`);

    return signal;
  }

  /**
   * Extract crypto price threshold from market question
   * Supports all price ranges: $0.05 (DOGE) to $100,000+ (BTC)
   * e.g., "Will Bitcoin be above $70,000 on June 30?" -> 70000
   * e.g., "Will Ethereum hit $4,000?" -> 4000
   * e.g., "Will Solana be above $200?" -> 200
   * e.g., "Will Dogecoin reach $0.50?" -> 0.50
   */
  private extractPriceThreshold(question: string): number | null {
    // Match patterns like $70,000 or $70000 or $70K or $0.50 or $200
    const patterns = [
      /\$([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)/,  // $70,000 or $70000 or $4,000.50
      /\$([0-9]+(?:\.[0-9]+)?)\s*[kK]/,                // $70K or $4.5K
      /([0-9]{1,3}(?:,?[0-9]{3})*(?:\.[0-9]+)?)\s*(?:USD|usd|dollars?)/, // 70000 USD
    ];

    for (const pattern of patterns) {
      const match = question.match(pattern);
      if (match) {
        let value = match[1].replace(/,/g, '');
        let num = parseFloat(value);
        // Handle K notation
        if (/[kK]/.test(question.slice(match.index || 0, (match.index || 0) + match[0].length + 2)) && num < 10000) {
          num *= 1000;
        }
        // Sanity check - any crypto price from $0.001 to $1,000,000
        if (num >= 0.001 && num <= 1000000) {
          return num;
        }
      }
    }
    return null;
  }

  /**
   * Calculate fair value of YES token based on spot price and threshold
   * Uses a simple logistic model considering:
   * - Distance from spot to threshold
   * - Time until expiry
   * - Recent volatility
   */
  private calculateFairValue(
    spotPrice: number,
    threshold: number,
    market: PolymarketMarket
  ): number {
    // Distance from spot to threshold (normalized)
    const distance = (spotPrice - threshold) / threshold;

    // Time factor (more time = more uncertainty)
    const now = Date.now();
    const expiry = new Date(market.endDate).getTime();
    const hoursRemaining = Math.max(1, (expiry - now) / (1000 * 60 * 60));
    const daysRemaining = hoursRemaining / 24;

    // Volatility factor
    const volatility = this.priceFeed.getRecentVolatility() || 2.0; // default 2% daily vol
    const adjustedVol = volatility * Math.sqrt(daysRemaining); // scale by sqrt(time)

    // Logistic function for probability
    // If spot is well above threshold, probability approaches 1
    // If spot is well below threshold, probability approaches 0
    const zScore = distance / (adjustedVol / 100);
    const fairValue = 1 / (1 + Math.exp(-zScore * 3));

    // Clamp between 0.02 and 0.98
    return Math.max(0.02, Math.min(0.98, fairValue));
  }

  /**
   * Calculate confidence score for a trade signal
   */
  private calculateConfidence(
    divergence: number,
    liquidity: number,
    volume: number,
    spread: number,
    spotPrice: SpotPrice
  ): number {
    let confidence = 0.5; // base confidence

    // Higher divergence = higher confidence (up to a point)
    if (divergence >= 3) confidence += 0.1;
    if (divergence >= 5) confidence += 0.1;
    if (divergence >= 8) confidence += 0.05;

    // Better liquidity = higher confidence
    if (liquidity > 10000) confidence += 0.1;
    if (liquidity > 50000) confidence += 0.05;

    // Higher volume = more reliable market
    if (volume > 100000) confidence += 0.05;
    if (volume > 500000) confidence += 0.05;

    // Tighter spread = better execution
    if (spread < 0.03) confidence += 0.05;
    if (spread < 0.01) confidence += 0.05;

    // Fresh price data = higher confidence
    const priceAge = Date.now() - spotPrice.timestamp;
    if (priceAge < 5000) confidence += 0.05; // less than 5 seconds old

    // Cap at 0.95
    return Math.min(0.95, confidence);
  }

  /**
   * Calculate position size based on signal quality and risk params
   */
  private calculatePositionSize(
    divergence: number,
    confidence: number,
    marketLiquidity: number
  ): number {
    // Base size from config
    let size = config.risk.maxPositionSize;

    // Scale by confidence
    size *= confidence;

    // Scale by divergence (more divergence = more conviction)
    const divScale = Math.min(divergence / 10, 1.5);
    size *= divScale;

    // Don't take more than 5% of market liquidity
    const liquidityLimit = marketLiquidity * 0.05;
    size = Math.min(size, liquidityLimit);

    // Ensure minimum viable trade ($5)
    size = Math.max(5, Math.min(size, config.risk.maxPositionSize));

    return Math.round(size * 100) / 100;
  }
}
