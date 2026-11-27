#!/usr/bin/env bash
# Встановлення платформи магазинів на чистий сервер Ubuntu 22.04/24.04 (напр. Hetzner CX22).
# Запуск від root:
#   curl -fsSL https://raw.githubusercontent.com/yokushka88/new_bot/main/deploy/install.sh -o install.sh && bash install.sh
# Що робить: Node.js 22, Caddy (HTTPS), окремий користувач, автозапуск, фаєрвол,
# автоматичні оновлення безпеки, команда shop-update для оновлення з GitHub.
set -euo pipefail

REPO="https://github.com/yokushka88/new_bot.git"
APP=/opt/shop
DATA=/var/lib/shop
ENV_FILE=/etc/shop.env

if [ "$(id -u)" -ne 0 ]; then echo "Запустіть від root"; exit 1; fi

echo "=== Встановлення платформи магазинів ==="
read -rp "Адреса сайту (напр. myshops.duckdns.org): " DOMAIN
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
read -rsp "Токен бота з @BotFather (не відображається): " BOT_TOKEN; echo
read -rp "Ваш Telegram ID [1089178805]: " ADMIN_IDS
ADMIN_IDS="${ADMIN_IDS:-1089178805}"
if [ -z "$DOMAIN" ] || [ -z "$BOT_TOKEN" ]; then echo "Адреса й токен обов'язкові"; exit 1; fi

echo "--- Системні пакети"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https openssl

echo "--- Node.js 22"
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "--- Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "--- Користувач і код"
id shop >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin shop
mkdir -p "$DATA"
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
chown -R shop:shop "$APP" "$DATA"
chmod 700 "$DATA"
# Збираємо від імені користувача shop (runuser є в будь-якій Ubuntu, на відміну від sudo)
as_shop() { runuser -u shop -- env HOME="$APP" bash -c "$1"; }
as_shop "cd $APP && git pull --ff-only && npm ci --no-audit --no-fund && npm run build"

echo "--- Налаштування"
# Секрет для шифрування токенів ботів клієнтів створюється один раз і більше не змінюється
TOKEN_SECRET="$(grep -s '^TOKEN_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
[ -n "$TOKEN_SECRET" ] || TOKEN_SECRET="$(openssl rand -hex 32)"
umask 077
cat > "$ENV_FILE" <<ENV
PORT=3000
DATA_DIR=$DATA
BOT_TOKEN=$BOT_TOKEN
ADMIN_IDS=$ADMIN_IDS
WEBAPP_URL=https://$DOMAIN
TOKEN_SECRET=$TOKEN_SECRET
ENV
chmod 600 "$ENV_FILE"
umask 022

cat > /etc/systemd/system/shop.service <<UNIT
[Unit]
Description=Платформа магазинів (сайт і бот)
After=network-online.target
Wants=network-online.target

[Service]
User=shop
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY

cat > /usr/local/bin/shop-update <<'UPD'
#!/usr/bin/env bash
# Оновлення платформи з GitHub і перезапуск
set -euo pipefail
runuser -u shop -- env HOME=/opt/shop bash -c "cd /opt/shop && git pull --ff-only && npm ci --no-audit --no-fund && npm run build"
systemctl restart shop
echo "Оновлено. Журнал: journalctl -u shop -n 30"
UPD
chmod +x /usr/local/bin/shop-update

echo "--- Фаєрвол: відкриті лише SSH, 80, 443"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "--- Автоматичні оновлення безпеки"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable --now shop
systemctl restart caddy

sleep 4
echo
echo "=== Готово ==="
journalctl -u shop -n 8 --no-pager | sed 's/^.*\]: //'
echo
echo "Перевірка: https://$DOMAIN/healthz  (має показати ok; HTTPS-сертифікат може з'явитися за 1–2 хвилини)"
echo "Журнал:    journalctl -u shop -f"
echo "Оновлення: shop-update"
