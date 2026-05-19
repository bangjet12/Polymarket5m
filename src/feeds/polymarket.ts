import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { config } from '../config';
import { PolymarketMarket, Orderbook, OrderbookEntry } from '../types';
import { logger } from '../utils/logger';

/**
 * Polymarket API Client
 * Handles market discovery, orderbook data, and WebSocket streaming
 */
export class PolymarketClient {
  private httpClient: AxiosInstance;
  private clobClient: AxiosInstance;
  private ws: WebSocket | null = null;
  private btcMarkets: PolymarketMarket[] = [];
  private orderbooks: Map<string, Orderbook> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor() {
    // Gamma API for market discovery
    this.httpClient = axios.create({
      baseURL: config.polymarket.gammaUrl,
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    // CLOB API for trading
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
   * Fetch ALL active prediction markets (crypto + sports + politics + events)
   * Trades ANY binary market where YES/NO token is mispriced vs probability
   */
  async fetchBTCMarkets(): Promise<PolymarketMarket[]> {
    try {
      // Fetch markets from multiple categories to maximize coverage
      const tags = ['crypto', 'sports', 'politics', 'pop-culture', 'science', 'business'];
      const fetchPromises = tags.map(tag =>
        this.httpClient.get('/markets', {
          params: { active: true, closed: false, tag, limit: 50 },
        }).catch(() => ({ data: [] }))
      );

      // Also fetch without tag (general markets)
      fetchPromises.push(
        this.httpClient.get('/markets', {
          params: { active: true, closed: false, limit: 100 },
        }).catch(() => ({ data: [] }))
      );

      const responses = await Promise.all(fetchPromises);

      // Combine all markets and deduplicate by id
      const marketMap = new Map<string, any>();
      for (const response of responses) {
        const markets = response.data || [];
        for (const market of markets) {
          const id = market.id || market.condition_id;
          if (id && !marketMap.has(id)) {
            marketMap.set(id, market);
          }
        }
      }

      const allMarkets = Array.from(marketMap.values());

      // Filter: only markets with token data, liquidity > $100, and end date
      this.btcMarkets = allMarkets
        .filter((market: any) => {
          const liquidity = parseFloat(market.liquidity || market.liquidityNum || '0');
          const hasEndDate = !!(market.end_date_iso || market.endDateIso || market.endDate);
          const hasTokens = !!(market.clobTokenIds || (market.tokens && market.tokens.length >= 2));
          const hasOutcomes = !!(market.outcomes || market.outcomePrices);
          return (hasTokens || hasOutcomes) && liquidity >= 100 && hasEndDate;
        })
        .map((m: any) => this.normalizeMarket(m))
        .filter((m: PolymarketMarket) => m.tokens.length >= 2);

      logger.info(`Found ${this.btcMarkets.length} active markets on Polymarket (ALL categories)`);
      return this.btcMarkets;
    } catch (error: any) {
      logger.error(`Failed to fetch markets: ${error.message}`);
      return this.btcMarkets; // return cached
    }
  }

  /**
   * Fetch orderbook for a specific market token
   */
  async fetchOrderbook(tokenId: string): Promise<Orderbook | null> {
    try {
      const response = await this.clobClient.get('/book', {
        params: { token_id: tokenId },
      });

      const data = response.data;
      const orderbook: Orderbook = {
        market: tokenId,
        assetId: tokenId,
        bids: (data.bids || []).map((b: any) => ({
          price: parseFloat(b.price),
          size: parseFloat(b.size),
        })),
        asks: (data.asks || []).map((a: any) => ({
          price: parseFloat(a.price),
          size: parseFloat(a.size),
        })),
        timestamp: Date.now(),
      };

      this.orderbooks.set(tokenId, orderbook);
      return orderbook;
    } catch (error: any) {
      logger.warn(`Orderbook fetch failed for ${tokenId}: ${error.message}`);
      return this.orderbooks.get(tokenId) || null;
    }
  }

  /**
   * Get midpoint price for a token from orderbook
   */
  getMidPrice(tokenId: string): number | null {
    const ob = this.orderbooks.get(tokenId);
    if (!ob || ob.bids.length === 0 || ob.asks.length === 0) return null;
    const bestBid = ob.bids[0].price;
    const bestAsk = ob.asks[0].price;
    return (bestBid + bestAsk) / 2;
  }

  /**
   * Get best bid/ask for a token
   */
  getBBO(tokenId: string): { bid: number; ask: number; spread: number } | null {
    const ob = this.orderbooks.get(tokenId);
    if (!ob || ob.bids.length === 0 || ob.asks.length === 0) return null;
    const bid = ob.bids[0].price;
    const ask = ob.asks[0].price;
    return { bid, ask, spread: ask - bid };
  }

  /**
   * Get available liquidity at a price level
   */
  getLiquidity(tokenId: string, side: 'BUY' | 'SELL', depth: number = 3): number {
    const ob = this.orderbooks.get(tokenId);
    if (!ob) return 0;
    const entries = side === 'BUY' ? ob.asks.slice(0, depth) : ob.bids.slice(0, depth);
    return entries.reduce((sum, e) => sum + e.size * e.price, 0);
  }

  /**
   * Connect to WebSocket for real-time orderbook updates
   */
  connectWebSocket(tokenIds: string[]): void {
    if (this.ws) {
      this.ws.close();
    }

    try {
      this.ws = new WebSocket(config.polymarket.wsUrl);

      this.ws.on('open', () => {
        logger.info('WebSocket connected to Polymarket');
        this.reconnectAttempts = 0;

        // Subscribe to orderbook channels
        const subscribeMsg = {
          type: 'subscribe',
          channel: 'market',
          assets_ids: tokenIds,
        };
        this.ws!.send(JSON.stringify(subscribeMsg));
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(msg);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        logger.warn('WebSocket disconnected');
        this.scheduleReconnect(tokenIds);
      });

      this.ws.on('error', (error) => {
        logger.error(`WebSocket error: ${error.message}`);
      });
    } catch (error: any) {
      logger.error(`WebSocket connection failed: ${error.message}`);
      this.scheduleReconnect(tokenIds);
    }
  }

  private handleWsMessage(msg: any): void {
    if (msg.event_type === 'book') {
      const tokenId = msg.asset_id;
      if (tokenId && this.orderbooks.has(tokenId)) {
        const ob = this.orderbooks.get(tokenId)!;
        if (msg.bids) ob.bids = msg.bids.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }));
        if (msg.asks) ob.asks = msg.asks.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }));
        ob.timestamp = Date.now();
      }
    }
  }

  private scheduleReconnect(tokenIds: string[]): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    logger.info(`Reconnecting WebSocket in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connectWebSocket(tokenIds), delay);
  }

  /**
   * Disconnect WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Fetch recent trades for a specific token (for historical analysis)
   */
  async fetchTokenTrades(tokenId: string, limit: number = 100): Promise<any[]> {
    try {
      const response = await this.clobClient.get('/trades', {
        params: { asset_id: tokenId, limit },
      });
      return response.data || [];
    } catch (error: any) {
      logger.warn(`Token trades fetch failed for ${tokenId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch market resolution status
   */
  async fetchMarketStatus(marketId: string): Promise<any | null> {
    try {
      const response = await this.httpClient.get(`/markets/${marketId}`);
      return response.data || null;
    } catch (error: any) {
      logger.warn(`Market status fetch failed for ${marketId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch resolved markets (for ML training data)
   */
  async fetchResolvedMarkets(limit: number = 50): Promise<any[]> {
    try {
      const response = await this.httpClient.get('/markets', {
        params: {
          closed: true,
          tag: 'crypto',
          limit,
          order: 'end_date_iso',
          ascending: false,
        },
      });
      return response.data || [];
    } catch (error: any) {
      logger.warn(`Resolved markets fetch failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch market price history (time series)
   */
  async fetchPriceHistory(tokenId: string, interval: string = '5m'): Promise<any[]> {
    try {
      const response = await this.clobClient.get('/prices-history', {
        params: {
          token_id: tokenId,
          interval,
          fidelity: 60, // 1 min granularity
        },
      });
      return response.data?.history || [];
    } catch (error: any) {
      logger.debug(`Price history fetch failed for ${tokenId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get cached BTC markets
   */
  getBTCMarkets(): PolymarketMarket[] {
    return this.btcMarkets;
  }

  /**
   * Normalize raw market data to our type
   * Handles both formats: direct tokens array OR clobTokenIds + outcomePrices strings
   */
  private normalizeMarket(raw: any): PolymarketMarket {
    let tokens: any[] = [];

    // Format 1: tokens array already present
    if (raw.tokens && Array.isArray(raw.tokens) && raw.tokens.length > 0) {
      tokens = raw.tokens.map((t: any) => ({
        tokenId: t.token_id || t.tokenId || '',
        outcome: t.outcome || '',
        price: parseFloat(t.price || '0'),
        winner: t.winner || false,
      }));
    }
    // Format 2: clobTokenIds + outcomePrices as JSON strings (Gamma API format)
    else if (raw.clobTokenIds && raw.outcomePrices) {
      try {
        const tokenIds = JSON.parse(raw.clobTokenIds);
        const prices = JSON.parse(raw.outcomePrices);
        const outcomes = raw.outcomes ? JSON.parse(raw.outcomes) : ['Yes', 'No'];

        for (let i = 0; i < tokenIds.length; i++) {
          tokens.push({
            tokenId: tokenIds[i] || '',
            outcome: outcomes[i] || (i === 0 ? 'Yes' : 'No'),
            price: parseFloat(prices[i] || '0'),
            winner: false,
          });
        }
      } catch (e) {
        // If parsing fails, try direct values
      }
    }

    return {
      id: raw.id || raw.condition_id,
      conditionId: raw.condition_id || raw.conditionId || raw.conditionId || '',
      question: raw.question || '',
      slug: raw.slug || '',
      tokens,
      active: raw.active !== false,
      closed: raw.closed === true,
      endDate: raw.end_date_iso || raw.endDateIso || raw.endDate || '',
      volume: parseFloat(raw.volume || raw.volumeNum || '0'),
      liquidity: parseFloat(raw.liquidity || raw.liquidityNum || '0'),
    };
  }
}
