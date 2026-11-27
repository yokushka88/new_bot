// Шифрування токенів ботів клієнтів у базі (AES-256-GCM).
// Ключ — зі змінної TOKEN_SECRET, а якщо її немає — похідний від BOT_TOKEN платформи.
// Тож навіть якщо хтось отримає файл бази, токенів клієнтів у відкритому вигляді там немає.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.mjs';

const key = () => createHash('sha256').update(`shop-bot-tokens:${process.env.TOKEN_SECRET || config.botToken}`).digest();

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(blob) {
  try {
    const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
