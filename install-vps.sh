#!/usr/bin/env bash
# Script de Instalação Automática em VPS Linux (Ubuntu / Debian)
# Uso na VPS: sudo bash install-vps.sh

set -e

APP_DIR="/opt/chamado-tecnico"
REPO_URL="https://github.com/MALC89/chamado-tecnico.git"

echo "=== 1. Atualizando pacotes e instalando Python3 e Git ==="
apt-get update -y
apt-get install -y python3 git ufw

echo "=== 2. Baixando ou atualizando o sistema em $APP_DIR ==="
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git pull origin main
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

mkdir -p "$APP_DIR/dados"
if [ -f "$APP_DIR/database.db" ] && [ ! -f "$APP_DIR/dados/database.db" ]; then
  cp "$APP_DIR/database.db" "$APP_DIR/dados/database.db"
fi

echo "=== 3. Criando serviço automático no Linux (systemd) ==="
cat >/etc/systemd/system/chamado-tecnico.service <<EOF
[Unit]
Description=ServiceDesk Pro - Sistema de Chamados Tecnicos e SLA
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment="PORT=80"
Environment="HOST=0.0.0.0"
Environment="DB_PATH=$APP_DIR/dados/database.db"
ExecStart=/usr/bin/python3 $APP_DIR/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "=== 4. Ativando e iniciando o serviço na porta 80 ==="
systemctl daemon-reload
systemctl enable chamado-tecnico
systemctl restart chamado-tecnico

echo "=== 5. Liberando porta 80 no Firewall (se ativo) ==="
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true

PUBLIC_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "=========================================================="
echo "✅ SISTEMA INSTALADO E RODANDO 24H NA SUA VPS!"
echo "👉 Acesse pelo navegador: http://$PUBLIC_IP"
echo "📁 Banco SQLite protegido em: $APP_DIR/dados/database.db"
echo "=========================================================="
