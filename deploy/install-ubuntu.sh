#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 server.
# Usage: sudo bash deploy/install-ubuntu.sh
set -e

MODEL="${MODEL:-llama3.2}"

echo "==> Installing Ollama"
curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama
sleep 3
echo "==> Downloading model: $MODEL"
ollama pull "$MODEL"

echo "==> Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "==> Installing MongoDB 7"
apt-get install -y gnupg curl
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg --yes
. /etc/os-release
CODENAME="$VERSION_CODENAME"; [ "$CODENAME" = "noble" ] && CODENAME="jammy"
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu $CODENAME/mongodb-org/7.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-7.0.list
apt-get update
apt-get install -y mongodb-org
systemctl enable --now mongod

echo "==> Installing PM2"
npm install -g pm2

echo "Done. Next: copy server/.env.example to server/.env, edit it, then run:"
echo "  npm run install:all && npm run build && pm2 start ecosystem.config.cjs && pm2 save"
