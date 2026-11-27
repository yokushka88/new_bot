// Налаштування платформи зі змінних середовища (Railway → Variables).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function cleanUrl(v) {
  const t = String(v || '').trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//.test(t) ? t.replace(/^http:/, 'https:') : `https://${t}`;
}

export const config = {
  root,
  port: Number(process.env.PORT) || 3000,
  /** Тека з базою й фото. На Railway — шлях, куди підключено Volume (напр. /data). */
  dataDir: resolve(process.env.DATA_DIR || resolve(root, 'data')),
  botToken: (process.env.BOT_TOKEN || '').trim(),
  /** Telegram ID адміністраторів платформи через кому. */
  adminIds: String(process.env.ADMIN_IDS || '')
    .split(/[\s,]+/)
    .map((s) => Number(s))
    .filter(Boolean),
  publicUrl: cleanUrl(process.env.WEBAPP_URL) || cleanUrl(process.env.RAILWAY_PUBLIC_DOMAIN),
  telegramApi: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org',
};

export const isAdmin = (id) => config.adminIds.includes(Number(id));

/** Адреса сторінки магазину (Mini App і PWA). Порожньо, поки немає публічного домену. */
export const shopUrl = (shop) => (config.publicUrl ? `${config.publicUrl}/s/${shop.slug}` : '');
