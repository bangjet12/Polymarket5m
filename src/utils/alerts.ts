import axios from 'axios';
import { config } from '../config';
import { TradeSignal, RiskState, BotStatus } from '../types';
import { logger } from './logger';

/**
 * Alert & Notification System
 * Sends trading alerts via Telegram
 */
export class AlertManager {
  private enabled: boolean;
  private botToken: string;
  private chatId: string;
  private messageQueue: string[] = [];
  private rateLimitMs = 1000; // 1 message per second max
  private lastSentAt = 0;

  constructor() {
    this.botToken = config.alerts.telegramBotToken;
    this.chatId = config.alerts.telegramChatId;
    this.enabled = !!(this.botToken && this.chatId);

    if (this.enabled) {
      logger.info('Telegram alerts enabled');
    } else {
      logger.info('Telegram alerts disabled (no token/chatId configured)');
    }
  }

  /**
   * Send trade execution alert
   */
  async notifyTrade(signal: TradeSignal, success: boolean): Promise<void> {
    const emoji = success ? '✅' : '❌';
    const msg = [
      `${emoji} *Trade ${success ? 'Executed' : 'Failed'}*`,
      ``,
      `📊 Market: ${signal.market.question.slice(0, 60)}`,
      `📈 Side: ${signal.side} ${signal.outcome}`,
      `💰 Size: $${signal.suggestedSize.toFixed(2)}`,
      `🎯 Price: ${signal.suggestedPrice.toFixed(4)}`,
      `📏 Divergence: ${signal.divergence.toFixed(1)}%`,
      `🔮 Confidence: ${(signal.confidence * 100).toFixed(0)}%`,
      `💵 BTC Spot: $${signal.spotPrice.toFixed(0)}`,
    ].join('\n');

    await this.send(msg);
  }

  /**
   * Send risk alert
   */
  async notifyRisk(state: RiskState, message: string): Promise<void> {
    const msg = [
      `🚨 *Risk Alert*`,
      ``,
      `⚠️ ${message}`,
      ``,
      `💰 Exposure: $${state.totalExposure.toFixed(2)}`,
      `📊 Positions: ${state.openPositions}`,
      `📉 Daily P&L: $${state.dailyPnl.toFixed(2)}`,
      `🛑 Halted: ${state.isHalted ? 'YES' : 'No'}`,
    ].join('\n');

    await this.send(msg);
  }

  /**
   * Send status update
   */
  async notifyStatus(status: BotStatus): Promise<void> {
    const uptimeHours = (status.uptime / (1000 * 60 * 60)).toFixed(1);
    const msg = [
      `📡 *Bot Status Update*`,
      ``,
      `⏱️ Uptime: ${uptimeHours}h`,
      `💵 BTC: $${status.spotPrice.price.toFixed(0)}`,
      `📊 Markets: ${status.activeMarkets}`,
      `📋 Open Orders: ${status.openOrders}`,
      `💰 Exposure: $${status.riskState.totalExposure.toFixed(2)}`,
      `📈 Daily P&L: $${status.riskState.dailyPnl.toFixed(2)}`,
    ].join('\n');

    await this.send(msg);
  }

  /**
   * Send startup notification
   */
  async notifyStartup(): Promise<void> {
    const msg = [
      `🚀 *Polymarket BTC 5M Trader Started*`,
      ``,
      `⚙️ Interval: ${config.strategy.tradingIntervalMs / 1000}s`,
      `📏 Min Divergence: ${config.strategy.minDivergence}%`,
      `💰 Max Position: $${config.risk.maxPositionSize}`,
      `🛡️ Daily Loss Limit: $${config.risk.dailyLossLimit}`,
      ``,
      `_Trading is now active._`,
    ].join('\n');

    await this.send(msg);
  }

  /**
   * Send shutdown notification
   */
  async notifyShutdown(reason: string): Promise<void> {
    await this.send(`🔴 *Bot Shutdown*\n\nReason: ${reason}`);
  }

  /**
   * Send message via Telegram
   */
  private async send(text: string): Promise<void> {
    if (!this.enabled) return;

    // Rate limiting
    const now = Date.now();
    if (now - this.lastSentAt < this.rateLimitMs) {
      this.messageQueue.push(text);
      return;
    }

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text: text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        },
        { timeout: 5000 }
      );
      this.lastSentAt = Date.now();
    } catch (error: any) {
      logger.warn(`Telegram alert failed: ${error.message}`);
    }

    // Process queued messages
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.messageQueue.length === 0) return;
    setTimeout(async () => {
      const msg = this.messageQueue.shift();
      if (msg) await this.send(msg);
    }, this.rateLimitMs);
  }
}
