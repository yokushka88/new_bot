// Сервер платформи магазинів: сторінки магазинів (Mini App і PWA), API каталогу,
// прийом замовлень, фото товарів. Без сторонніх залежностей, із заголовками безпеки.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { config } from './server/config.mjs';
import { countOrders, getShopBySlug, saveOrder } from './server/db.mjs';
import { publicCatalog, validateOrder } from './server/catalog.mjs';
import { verifyInitData } from './server/telegram.mjs';
import { notifyOrder, startBot } from './server/bot.mjs';
import { shopBotToken } from './server/shopBots.mjs';

const DIST = resolve(config.root, 'dist');
const MEDIA = resolve(config.dataDir, 'media');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'frame-ancestors https://web.telegram.org https://*.telegram.org',
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, headers);
  res.end(body);
};
const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

/** Файл усередині теки base або null (захист від ../). */
function safePath(base, rel) {
  const full = normalize(join(base, rel));
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function serveFile(res, file, cache) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const body = await readFile(file);
    send(res, 200, body, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': cache,
    });
    return true;
  } catch {
    return false;
  }
}

// ───── Сторінка магазину ─────

let indexTemplate = '';
async function indexHtml() {
  if (!indexTemplate) indexTemplate = await readFile(join(DIST, 'index.html'), 'utf8');
  return indexTemplate;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function shopPage(res, shop) {
  let html = await indexHtml();
  const head = shop
    ? `<title>${esc(shop.name)}</title>
    <link rel="manifest" href="/s/${shop.slug}/manifest.webmanifest" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${esc(shop.name)}" />
    <link rel="apple-touch-icon" href="/icons/icon-180.png" />`
    : '<title>Магазин</title>';
  html = html.replace(/<title>[^<]*<\/title>/, head);
  send(res, shop ? 200 : 404, html, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
}

function manifest(res, shop) {
  const m = {
    name: shop.name,
    short_name: shop.name.slice(0, 12),
    description: `Магазин ${shop.name}`,
    start_url: `/s/${shop.slug}`,
    scope: `/s/${shop.slug}`,
    id: `/s/${shop.slug}`,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    lang: 'uk',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  send(res, 200, JSON.stringify(m), { 'Content-Type': TYPES['.webmanifest'], 'Cache-Control': 'no-cache' });
}

// ───── Замовлення ─────

const MAX_BODY = 32 * 1024;
function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(new Error('bad json'));
      }
    });
    req.on('error', fail);
  });
}

// Простий захист від спаму: не більше 5 замовлень за 10 хвилин з однієї адреси.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 5;
}

async function createOrder(req, res, shop) {
  // Адресу покупця беремо з того, що додав проксі Railway (X-Real-IP або останній запис
  // X-Forwarded-For): перші записи клієнт може підробити, щоб обійти обмеження.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const ip = String(req.headers['x-real-ip'] || xff[xff.length - 1] || req.socket.remoteAddress || '');
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'Забагато замовлень поспіль. Спробуйте за кілька хвилин.' });
  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'Некоректний запит' });
  }
  const { order, error } = validateOrder(shop, body);
  if (error) return sendJson(res, 400, { error });
  // Покупця з Telegram довіряємо лише якщо підпис initData правильний.
  // Магазин могли відкрити через бот платформи або через власний бот магазину — перевіряємо обидва підписи.
  let buyer = null;
  let buyerToken = config.botToken;
  if (body.telegramInitData) {
    const raw = String(body.telegramInitData);
    buyer = verifyInitData(raw);
    const own = shopBotToken(shop);
    if (!buyer && own && (buyer = verifyInitData(raw, own))) buyerToken = own;
    if (!buyer) return sendJson(res, 403, { error: 'Не вдалося перевірити дані Telegram. Відкрийте магазин заново.' });
  }
  if (buyer) order.buyer = { id: buyer.id, username: buyer.username || '', name: [buyer.first_name, buyer.last_name].filter(Boolean).join(' ') };
  const id = saveOrder(shop.id, order, order.total);
  const number = countOrders(shop.id);
  notifyOrder(shop, { ...order, number }, buyerToken).catch((e) => console.error('Замовлення: не вдалося сповістити —', e.message));
  sendJson(res, 200, { orderId: String(number), id });
}

// ───── Маршрути ─────

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let path;
  try {
    path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  try {
    let m;
    if ((m = path.match(/^\/api\/shops\/([a-z0-9_-]+)$/)) && req.method === 'GET') {
      const shop = getShopBySlug(m[1]);
      if (!shop || !shop.active) return sendJson(res, 404, { error: 'Магазин не знайдено' });
      return sendJson(res, 200, publicCatalog(shop));
    }
    if ((m = path.match(/^\/api\/shops\/([a-z0-9_-]+)\/orders$/)) && req.method === 'POST') {
      const shop = getShopBySlug(m[1]);
      if (!shop || !shop.active) return sendJson(res, 404, { error: 'Магазин не знайдено' });
      return await createOrder(req, res, shop);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { Allow: 'GET, HEAD' });

    if ((m = path.match(/^\/media\/([a-f0-9]{24}\.jpg)$/))) {
      if (await serveFile(res, safePath(MEDIA, m[1]), 'public, max-age=31536000, immutable')) return;
      return send(res, 404, 'Не знайдено');
    }
    if ((m = path.match(/^\/s\/([a-z0-9_-]+)\/manifest\.webmanifest$/))) {
      const shop = getShopBySlug(m[1]);
      return shop ? manifest(res, shop) : send(res, 404, 'Не знайдено');
    }
    if ((m = path.match(/^\/s\/([a-z0-9_-]+)\/?$/))) {
      const shop = getShopBySlug(m[1]);
      return await shopPage(res, shop && shop.active ? shop : null);
    }
    if (path === '/healthz') return send(res, 200, 'ok');

    const file = safePath(DIST, path);
    if (!file) return send(res, 400, 'Bad request');
    const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (path !== '/' && (await serveFile(res, file, cache))) return;
    if (extname(path)) return send(res, 404, 'Не знайдено');
    return await shopPage(res, null);
  } catch (e) {
    console.error('Помилка запиту:', e.message);
    if (!res.headersSent) send(res, 500, 'Помилка сервера');
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Сайт запущено: http://0.0.0.0:${config.port}`);
  console.log(`Дані: ${config.dataDir}`);
});
startBot();
