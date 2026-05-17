/**
 * PM2 Ecosystem Configuration
 * For 24/7 VPS deployment with auto-restart and monitoring
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 status
 *   pm2 logs polymarket-btc-5m
 *   pm2 restart polymarket-btc-5m
 */
module.exports = {
  apps: [
    {
      name: 'polymarket-btc-5m',
      script: './dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      
      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Restart policy
      restart_delay: 5000,         // Wait 5s before restart
      max_restarts: 50,            // Max restarts before stopping
      min_uptime: '30s',           // Min uptime to consider "started"
      
      // Logging
      log_file: './logs/pm2-combined.log',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Cron restart (daily at 4am UTC for clean slate)
      cron_restart: '0 4 * * *',
      
      // Health check
      listen_timeout: 10000,
      kill_timeout: 5000,
    },
  ],
};
