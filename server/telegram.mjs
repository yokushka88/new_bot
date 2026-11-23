// Робота з Telegram Bot API: виклики, завантаження фото, перевірка initData.
// Токен бота використовується лише тут і ніколи не потрапляє в логи чи браузер.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';

export async function tg(method, body) {
  const res = await fetch(`${config.telegramApi}/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

const MAX_PHOTO = 10 * 1024 * 1024;

/** Завантажує фото з Telegram у DATA_DIR/media і повертає ім'я файлу. */
export async function downloadPhoto(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  if (!file.file_path) throw new Error('немає шляху до файлу');
  if (file.file_size && file.file_size > MAX_PHOTO) throw new Error('фото завелике');
  const res = await fetch(`${config.telegramApi}/file/bot${config.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`не вдалося завантажити фото (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PHOTO) throw new Error('фото завелике');
  // Telegram стискає фото в JPEG; ім'я випадкове, щоб його не можна було вгадати.
  const name = `${randomBytes(12).toString('hex')}.jpg`;
  await writeFile(join(config.dataDir, 'media', name), buf);
  return name;
}

/**
 * Перевіряє підпис initData з Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Повертає користувача Telegram або null, якщо підпис невірний чи дані застарілі.
 */
export function verifyInitData(initData, maxAgeSec = 24 * 3600) {
  if (!initData || !config.botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const calc = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !timingSafeEqual(given, calc)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
