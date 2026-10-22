#!/usr/bin/env bash
# Script Automático para trocar o IP pelo Nome do Domínio + HTTPS (SSL Grátis) na VPS
# Uso: sudo bash configurar-dominio.sh chamados.suaempresa.com.br

set -e

DOMINIO="$1"

if [ -z "$DOMINIO" ]; then
  echo "❌ Informe o domínio que deseja usar!"
  echo "👉 Exemplo: sudo bash configurar-dominio.sh chamados.suaempresa.com.br"
  exit 1
fi

echo "=== 1. Ajustando o sistema ServiceDesk Pro para porta interna 8080 ==="
if [ -f /etc/systemd/system/chamado-tecnico.service ]; then
  sed -i 's/PORT=80$/PORT=8080/' /etc/systemd/system/chamado-tecnico.service
  systemctl daemon-reload
  systemctl restart chamado-tecnico
fi

echo "=== 2. Instalando servidor Caddy (Gerador automático de HTTPS/SSL) ==="
apt-get update -y
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -y
apt-get install -y caddy

echo "=== 3. Configurando o domínio $DOMINIO ==="
cat >/etc/caddy/Caddyfile <<EOF
$DOMINIO {
    reverse_proxy localhost:8080
}
EOF

systemctl enable caddy
systemctl restart caddy

ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true

echo ""
echo "=========================================================="
echo "✅ DOMÍNIO CONFIGURADO COM SUCESSO!"
echo "👉 Acesse agora pelo nome: https://$DOMINIO"
echo "🔒 Certificado HTTPS (cadeado de segurança) ativado automaticamente!"
echo "=========================================================="
