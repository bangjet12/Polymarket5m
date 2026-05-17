import axios from 'axios';
import { config } from '../config';
import { SpotPrice } from '../types';
import { logger } from '../utils/logger';

/**
 * Spot Price Feed Module
 * Fetches BTC/USD price from multiple sources for reliability
 * Returns aggregated price (median of all sources)
 */
export class SpotPriceFeed {
  private lastPrice: SpotPrice | null = null;
  private priceHistory: SpotPrice[] = [];
  private readonly maxHistory = 100;

  /**
   * Get BTC spot price from Binance
   */
  async getBinancePrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(`${config.feeds.binanceUrl}/ticker/price`, {
        params: { symbol: 'BTCUSDT' },
        timeout: 5000,
      });
      return {
        source: 'binance',
        price: parseFloat(response.data.price),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      logger.warn(`Binance price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get BTC spot price from Coinbase
   */
  async getCoinbasePrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(`${config.feeds.coinbaseUrl}/prices/BTC-USD/spot`, {
        timeout: 5000,
      });
      return {
        source: 'coinbase',
        price: parseFloat(response.data.data.amount),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      logger.warn(`Coinbase price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get aggregated BTC spot price (median of all sources)
   * Falls back to single source if others fail
   */
  async getSpotPrice(): Promise<SpotPrice> {
    const [binance, coinbase] = await Promise.all([
      this.getBinancePrice(),
      this.getCoinbasePrice(),
    ]);

    const prices: number[] = [];
    if (binance) prices.push(binance.price);
    if (coinbase) prices.push(coinbase.price);

    if (prices.length === 0) {
      if (this.lastPrice) {
        logger.warn('All price feeds failed, using last known price');
        return this.lastPrice;
      }
      throw new Error('All price feeds failed and no cached price available');
    }

    // Use median price for robustness
    prices.sort((a, b) => a - b);
    const medianPrice = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    const aggregated: SpotPrice = {
      source: 'aggregate',
      price: medianPrice,
      timestamp: Date.now(),
    };

    this.lastPrice = aggregated;
    this.priceHistory.push(aggregated);
    if (this.priceHistory.length > this.maxHistory) {
      this.priceHistory.shift();
    }

    logger.debug(`BTC Spot Price: $${medianPrice.toFixed(2)} (sources: ${prices.length})`);
    return aggregated;
  }

  /**
   * Get price volatility (standard deviation) over recent history
   */
  getRecentVolatility(): number {
    if (this.priceHistory.length < 5) return 0;
    const recentPrices = this.priceHistory.slice(-20).map(p => p.price);
    const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length;
    return Math.sqrt(variance) / mean * 100; // as percentage
  }

  /**
   * Get price trend direction (-1, 0, +1)
   */
  getPriceTrend(): number {
    if (this.priceHistory.length < 3) return 0;
    const recent = this.priceHistory.slice(-5).map(p => p.price);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const change = (last - first) / first * 100;
    if (change > 0.1) return 1;
    if (change < -0.1) return -1;
    return 0;
  }

  getLastPrice(): SpotPrice | null {
    return this.lastPrice;
  }

  getPriceHistory(): SpotPrice[] {
    return [...this.priceHistory];
  }
}
