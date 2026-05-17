import axios from 'axios';
import { config } from '../config';
import { SpotPrice } from '../types';
import { logger } from '../utils/logger';

/**
 * Spot Price Feed Module
 * Fetches BTC/USD price from 5 sources for maximum reliability:
 * - Binance (highest volume CEX)
 * - Coinbase (US regulated)
 * - CoinGecko (aggregator)
 * - Kraken (EU regulated)
 * - OKX (high volume global)
 * 
 * Returns aggregated price (median of all active sources)
 */
export class SpotPriceFeed {
  private lastPrice: SpotPrice | null = null;
  private priceHistory: SpotPrice[] = [];
  private readonly maxHistory = 200;
  private sourceStatus: Map<string, { failures: number; lastSuccess: number }> = new Map();

  constructor() {
    // Initialize source status tracking
    const sources = ['binance', 'coinbase', 'coingecko', 'kraken', 'okx'];
    for (const s of sources) {
      this.sourceStatus.set(s, { failures: 0, lastSuccess: 0 });
    }
  }

  /**
   * Get BTC spot price from Binance
   */
  async getBinancePrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(`${config.feeds.binanceUrl}/ticker/price`, {
        params: { symbol: 'BTCUSDT' },
        timeout: 5000,
      });
      this.markSuccess('binance');
      return {
        source: 'binance',
        price: parseFloat(response.data.price),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.markFailure('binance');
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
      this.markSuccess('coinbase');
      return {
        source: 'coinbase',
        price: parseFloat(response.data.data.amount),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.markFailure('coinbase');
      logger.warn(`Coinbase price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get BTC spot price from CoinGecko (aggregated)
   */
  async getCoinGeckoPrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: {
            ids: 'bitcoin',
            vs_currencies: 'usd',
          },
          timeout: 5000,
        }
      );
      this.markSuccess('coingecko');
      return {
        source: 'aggregate', // CoinGecko is itself an aggregator
        price: response.data.bitcoin.usd,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.markFailure('coingecko');
      logger.warn(`CoinGecko price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get BTC spot price from Kraken
   */
  async getKrakenPrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(
        'https://api.kraken.com/0/public/Ticker',
        {
          params: { pair: 'XBTUSD' },
          timeout: 5000,
        }
      );
      const result = response.data.result;
      // Kraken returns data under the pair key
      const pairKey = Object.keys(result)[0]; // 'XXBTZUSD'
      const lastPrice = parseFloat(result[pairKey].c[0]); // 'c' = last trade close
      this.markSuccess('kraken');
      return {
        source: 'aggregate',
        price: lastPrice,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.markFailure('kraken');
      logger.warn(`Kraken price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get BTC spot price from OKX
   */
  async getOKXPrice(): Promise<SpotPrice | null> {
    try {
      const response = await axios.get(
        'https://www.okx.com/api/v5/market/ticker',
        {
          params: { instId: 'BTC-USDT' },
          timeout: 5000,
        }
      );
      const data = response.data.data[0];
      this.markSuccess('okx');
      return {
        source: 'aggregate',
        price: parseFloat(data.last),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.markFailure('okx');
      logger.warn(`OKX price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Get aggregated BTC spot price (median of all 5 sources)
   * Falls back gracefully if some sources fail
   */
  async getSpotPrice(): Promise<SpotPrice> {
    const [binance, coinbase, coingecko, kraken, okx] = await Promise.all([
      this.getBinancePrice(),
      this.getCoinbasePrice(),
      this.getCoinGeckoPrice(),
      this.getKrakenPrice(),
      this.getOKXPrice(),
    ]);

    const prices: number[] = [];
    const activeSources: string[] = [];

    if (binance) { prices.push(binance.price); activeSources.push('Binance'); }
    if (coinbase) { prices.push(coinbase.price); activeSources.push('Coinbase'); }
    if (coingecko) { prices.push(coingecko.price); activeSources.push('CoinGecko'); }
    if (kraken) { prices.push(kraken.price); activeSources.push('Kraken'); }
    if (okx) { prices.push(okx.price); activeSources.push('OKX'); }

    if (prices.length === 0) {
      if (this.lastPrice) {
        logger.warn('All 5 price feeds failed, using last known price');
        return this.lastPrice;
      }
      throw new Error('All price feeds failed and no cached price available');
    }

    // Outlier rejection: remove prices that deviate more than 1% from median
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const rawMedian = sortedPrices[Math.floor(sortedPrices.length / 2)];
    const filteredPrices = prices.filter(p => Math.abs(p - rawMedian) / rawMedian < 0.01);

    // Use filtered prices if we still have enough, otherwise use all
    const finalPrices = filteredPrices.length >= 2 ? filteredPrices : prices;
    finalPrices.sort((a, b) => a - b);

    // Median of filtered prices
    const medianPrice = finalPrices.length % 2 === 0
      ? (finalPrices[finalPrices.length / 2 - 1] + finalPrices[finalPrices.length / 2]) / 2
      : finalPrices[Math.floor(finalPrices.length / 2)];

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

    logger.debug(`BTC Spot: $${medianPrice.toFixed(2)} | Sources: [${activeSources.join(', ')}] (${activeSources.length}/5)`);
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

  /**
   * Get cross-exchange price dispersion (how much exchanges disagree)
   * Low dispersion = high confidence in price, High dispersion = uncertainty
   */
  async getPriceDispersion(): Promise<number> {
    const [binance, coinbase, coingecko, kraken, okx] = await Promise.all([
      this.getBinancePrice(),
      this.getCoinbasePrice(),
      this.getCoinGeckoPrice(),
      this.getKrakenPrice(),
      this.getOKXPrice(),
    ]);

    const prices: number[] = [];
    if (binance) prices.push(binance.price);
    if (coinbase) prices.push(coinbase.price);
    if (coingecko) prices.push(coingecko.price);
    if (kraken) prices.push(kraken.price);
    if (okx) prices.push(okx.price);

    if (prices.length < 2) return 0;

    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxDev = Math.max(...prices.map(p => Math.abs(p - mean)));
    return (maxDev / mean) * 100; // as percentage
  }

  /**
   * Get source health status
   */
  getSourceHealth(): { source: string; healthy: boolean; failures: number }[] {
    return Array.from(this.sourceStatus.entries()).map(([source, status]) => ({
      source,
      healthy: status.failures < 3,
      failures: status.failures,
    }));
  }

  getLastPrice(): SpotPrice | null {
    return this.lastPrice;
  }

  getPriceHistory(): SpotPrice[] {
    return [...this.priceHistory];
  }

  private markSuccess(source: string): void {
    const status = this.sourceStatus.get(source);
    if (status) {
      status.failures = 0;
      status.lastSuccess = Date.now();
    }
  }

  private markFailure(source: string): void {
    const status = this.sourceStatus.get(source);
    if (status) {
      status.failures++;
    }
  }
}
