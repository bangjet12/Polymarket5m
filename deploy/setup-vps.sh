#!/bin/bash
# ═══════════════════════════════════════════════════
# VPS SETUP SCRIPT - Polymarket BTC 5M Trader
# ═══════════════════════════════════════════════════
# Run as root on a fresh Ubuntu 22.04+ VPS
# 
# Usage: chmod +x setup-vps.sh && sudo ./setup-vps.sh
# ═══════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════"
echo " Polymarket BTC 5M Trader - VPS Setup"
echo "═══════════════════════════════════════════"

# Update system
echo "[1/8] Updating system..."
apt-get update && apt-get upgrade -y

# Install Node.js 22
echo "[2/8] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install PM2 globally
echo "[3/8] Installing PM2..."
npm install -g pm2

# Create trader user
echo "[4/8] Creating trader user..."
useradd -m -s /bin/bash trader || true

# Setup application directory
echo "[5/8] Setting up application..."
APP_DIR=/opt/polymarket-trader
mkdir -p $APP_DIR/logs
cp -r . $APP_DIR/
chown -R trader:trader $APP_DIR

# Install dependencies
echo "[6/8] Installing dependencies..."
su - trader -c "cd $APP_DIR && npm install --production"

# Build TypeScript
echo "[7/8] Building project..."
su - trader -c "cd $APP_DIR && npm run build"

# Setup PM2 with startup
echo "[8/8] Configuring PM2 startup..."
su - trader -c "cd $APP_DIR && pm2 start ecosystem.config.js"
pm2 startup systemd -u trader --hp /home/trader
su - trader -c "pm2 save"

echo ""
echo "═══════════════════════════════════════════"
echo " ✅ SETUP COMPLETE!"
echo "═══════════════════════════════════════════"
echo ""
echo " Next steps:"
echo " 1. Copy .env.example to .env and fill in credentials"
echo "    cp $APP_DIR/.env.example $APP_DIR/.env"
echo "    nano $APP_DIR/.env"
echo ""
echo " 2. Restart the bot:"
echo "    su - trader -c 'pm2 restart polymarket-btc-5m'"
echo ""
echo " 3. Check status:"
echo "    su - trader -c 'pm2 status'"
echo "    su - trader -c 'pm2 logs polymarket-btc-5m'"
echo ""
echo " Bot is running 24/7 with auto-restart!"
echo "═══════════════════════════════════════════"
