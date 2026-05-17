import { TradingEngine } from './core/tradingEngine';
import { logger } from './utils/logger';

/**
 * ═══════════════════════════════════════════════════════════════
 *   POLYMARKET BTC 5-MINUTE TRADING TERMINAL
 * ═══════════════════════════════════════════════════════════════
 * 
 * Fully automated trading bot that:
 * 1. Tracks BTC spot price from multiple exchanges
 * 2. Monitors Polymarket prediction markets for BTC
 * 3. Detects inefficiencies (spot vs implied price divergence)
 * 4. Executes trades instantly before price adjustment
 * 
 * Runs 24/7 on VPS - No emotion, no hesitation.
 * 
 * ═══════════════════════════════════════════════════════════════
 */

const engine = new TradingEngine();

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  logger.info('Received SIGINT - shutting down gracefully...');
  await engine.stop('SIGINT received');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM - shutting down gracefully...');
  await engine.stop('SIGTERM received');
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.error(error.stack || '');
  await engine.stop(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason: any) => {
  logger.error(`Unhandled Rejection: ${reason?.message || reason}`);
  // Don't exit - log and continue
});

// Start the trading engine
async function main() {
  try {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ⚡ POLYMARKET BTC 5M TRADER ⚡                          ║
║                                                           ║
║   Spot vs Prediction Market Inefficiency Engine           ║
║   Fully Automated | 24/7 | No Emotion                    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);

    await engine.start();
  } catch (error: any) {
    logger.error(`Fatal startup error: ${error.message}`);
    process.exit(1);
  }
}

main();
