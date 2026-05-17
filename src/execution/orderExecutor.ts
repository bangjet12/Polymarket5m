import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { config } from '../config';
import { Order, TradeSignal, OrderStatus } from '../types';
import { logger } from '../utils/logger';

/**
 * Order Execution Engine
 * Places and manages orders on Polymarket CLOB
 * Handles order signing, submission, and status tracking
 */
export class OrderExecutor {
  private client: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private openOrders: Map<string, Order> = new Map();
  private orderHistory: Order[] = [];

  constructor() {
    this.client = axios.create({
      baseURL: config.polymarket.clobUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'POLY_API_KEY': config.polymarket.apiKey,
        'POLY_API_SECRET': config.polymarket.apiSecret,
        'POLY_PASSPHRASE': config.polymarket.apiPassphrase,
      },
    });

    // Initialize wallet for order signing
    if (config.wallet.privateKey) {
      this.wallet = new ethers.Wallet(config.wallet.privateKey);
      logger.info(`Execution wallet initialized: ${this.wallet.address}`);
    }
  }

  /**
   * Execute a trade signal by placing an order
   */
  async executeSignal(signal: TradeSignal): Promise<Order> {
    const order: Order = {
      market: signal.market.id,
      tokenId: signal.tokenId,
      side: signal.side,
      price: signal.suggestedPrice,
      size: signal.suggestedSize,
      type: config.strategy.orderType,
      status: 'PENDING',
      createdAt: Date.now(),
    };

    logger.info(`📝 Placing ${order.type} ${order.side} order: ` +
                `${order.size} USDC @ ${order.price.toFixed(4)} on ${signal.outcome}`);

    try {
      // Build order payload for Polymarket CLOB
      const orderPayload = await this.buildOrderPayload(order, signal);

      // Sign and submit order
      const response = await this.client.post('/order', orderPayload);

      if (response.data && response.data.orderID) {
        order.id = response.data.orderID;
        order.status = 'OPEN';
        this.openOrders.set(order.id, order);
        logger.info(`✅ Order placed successfully: ${order.id}`);
      } else {
        order.status = 'FAILED';
        logger.error(`❌ Order submission failed: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      order.status = 'FAILED';
      logger.error(`❌ Order execution error: ${error.message}`);
      if (error.response?.data) {
        logger.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
    }

    this.orderHistory.push(order);
    return order;
  }

  /**
   * Build the signed order payload for Polymarket
   */
  private async buildOrderPayload(order: Order, signal: TradeSignal): Promise<any> {
    if (!this.wallet) {
      throw new Error('Wallet not initialized - cannot sign orders');
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = Date.now().toString();

    // Order structure per Polymarket CLOB API
    const orderData = {
      tokenID: order.tokenId,
      price: order.price.toString(),
      size: order.size.toString(),
      side: order.side,
      feeRateBps: '0', // maker orders can be 0 fee
      nonce: nonce,
      expiration: '0', // GTC (Good Till Cancel)
      taker: '0x0000000000000000000000000000000000000000',
    };

    // Sign the order using EIP-712
    const signature = await this.signOrder(orderData);

    return {
      order: orderData,
      signature: signature,
      owner: this.wallet.address,
      orderType: order.type === 'MARKET' ? 'FOK' : 'GTC',
    };
  }

  /**
   * Sign order using EIP-712 typed data
   */
  private async signOrder(orderData: any): Promise<string> {
    if (!this.wallet) throw new Error('No wallet available');

    // Polymarket EIP-712 domain
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: 137, // Polygon
    };

    const types = {
      Order: [
        { name: 'tokenID', type: 'uint256' },
        { name: 'price', type: 'uint256' },
        { name: 'size', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'taker', type: 'address' },
      ],
    };

    const value = {
      tokenID: orderData.tokenID,
      price: ethers.parseUnits(orderData.price, 6).toString(),
      size: ethers.parseUnits(orderData.size, 6).toString(),
      side: orderData.side === 'BUY' ? 0 : 1,
      feeRateBps: orderData.feeRateBps,
      nonce: orderData.nonce,
      expiration: orderData.expiration,
      taker: orderData.taker,
    };

    const signature = await this.wallet.signTypedData(domain, types, value);
    return signature;
  }

  /**
   * Cancel an open order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.client.delete(`/order/${orderId}`);
      const order = this.openOrders.get(orderId);
      if (order) {
        order.status = 'CANCELLED';
        this.openOrders.delete(orderId);
      }
      logger.info(`Order cancelled: ${orderId}`);
      return true;
    } catch (error: any) {
      logger.error(`Failed to cancel order ${orderId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders(): Promise<void> {
    const orderIds = Array.from(this.openOrders.keys());
    logger.info(`Cancelling ${orderIds.length} open orders...`);
    await Promise.all(orderIds.map(id => this.cancelOrder(id)));
  }

  /**
   * Check and update status of open orders
   */
  async syncOrderStatus(): Promise<void> {
    for (const [orderId, order] of this.openOrders) {
      try {
        const response = await this.client.get(`/order/${orderId}`);
        const data = response.data;

        if (data.status === 'MATCHED' || data.status === 'FILLED') {
          order.status = 'FILLED';
          order.filledAt = Date.now();
          this.openOrders.delete(orderId);
          logger.info(`📊 Order filled: ${orderId}`);
        } else if (data.status === 'CANCELLED') {
          order.status = 'CANCELLED';
          this.openOrders.delete(orderId);
        }
      } catch (error: any) {
        logger.debug(`Status check failed for ${orderId}: ${error.message}`);
      }
    }
  }

  /**
   * Get open orders count
   */
  getOpenOrderCount(): number {
    return this.openOrders.size;
  }

  /**
   * Get order history
   */
  getOrderHistory(): Order[] {
    return [...this.orderHistory];
  }

  /**
   * Get all open orders
   */
  getOpenOrders(): Order[] {
    return Array.from(this.openOrders.values());
  }
}
