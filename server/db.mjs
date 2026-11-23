// База даних платформи: SQLite з Node (node:sqlite), без сторонніх залежностей.
// Файл лежить у DATA_DIR разом із фото, тож на Railway достатньо одного Volume.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';

mkdirSync(join(config.dataDir, 'media'), { recursive: true });

export const db = new DatabaseSync(join(config.dataDir, 'shops.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT 'store',
    owner_id INTEGER,
    invite_code TEXT,
    manager TEXT NOT NULL DEFAULT '',
    delivery_note TEXT NOT NULL DEFAULT '',
    reviews_url TEXT NOT NULL DEFAULT '',
    hero_title TEXT NOT NULL DEFAULT '',
    hero_text TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'clothing',
    brand TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL,
    old_price INTEGER,
    sizes TEXT NOT NULL DEFAULT '[]',
    colors TEXT NOT NULL DEFAULT '[]',
    in_stock INTEGER NOT NULL DEFAULT 1,
    is_new INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS products_shop ON products(shop_id, deleted);

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    pos INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Стан діалогу з ботом (майстер додавання товару тощо) — переживає перезапуск.
  CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}'
  );
`);

const json = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ───── Магазини ─────

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,30}$/;

export function createShop(slug, name) {
  const invite = randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO shops (slug, name, invite_code) VALUES (?, ?, ?)').run(slug, name, invite);
  return getShopBySlug(slug);
}

export const getShopBySlug = (slug) => db.prepare('SELECT * FROM shops WHERE slug = ?').get(slug);
export const getShop = (id) => db.prepare('SELECT * FROM shops WHERE id = ?').get(id);
export const shopsOfOwner = (ownerId) => db.prepare('SELECT * FROM shops WHERE owner_id = ? ORDER BY id').all(ownerId);
export const allShops = () => db.prepare('SELECT * FROM shops ORDER BY id').all();

export function claimShop(code, userId) {
  const shop = db.prepare('SELECT * FROM shops WHERE invite_code = ?').get(code);
  if (!shop) return null;
  // Код одноразовий: після використання видаляємо.
  db.prepare('UPDATE shops SET owner_id = ?, invite_code = NULL WHERE id = ?').run(userId, shop.id);
  return getShop(shop.id);
}

export function newInvite(shopId) {
  const invite = randomBytes(9).toString('base64url');
  db.prepare('UPDATE shops SET invite_code = ? WHERE id = ?').run(invite, shopId);
  return invite;
}

const SHOP_FIELDS = ['name', 'subtitle', 'manager', 'delivery_note', 'reviews_url', 'hero_title', 'hero_text', 'active'];
export function updateShop(id, field, value) {
  if (!SHOP_FIELDS.includes(field)) throw new Error('bad field');
  db.prepare(`UPDATE shops SET ${field} = ? WHERE id = ?`).run(value, id);
}

// ───── Товари ─────

export function addProduct(shopId, p) {
  const r = db
    .prepare(
      `INSERT INTO products (shop_id, category, brand, name, description, price, old_price, sizes, colors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(shopId, p.category, p.brand || '', p.name, p.description || '', p.price, p.oldPrice ?? null, JSON.stringify(p.sizes || []), JSON.stringify(p.colors || []));
  const id = Number(r.lastInsertRowid);
  (p.photos || []).forEach((file, i) => db.prepare('INSERT INTO photos (product_id, file, pos) VALUES (?, ?, ?)').run(id, file, i));
  return id;
}

export function getProduct(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND deleted = 0').get(id);
  return p ? hydrate(p) : null;
}

export function listProducts(shopId) {
  return db.prepare('SELECT * FROM products WHERE shop_id = ? AND deleted = 0 ORDER BY id DESC').all(shopId).map(hydrate);
}

function hydrate(p) {
  return {
    ...p,
    sizes: json(p.sizes, []),
    colors: json(p.colors, []),
    photos: db.prepare('SELECT file FROM photos WHERE product_id = ? ORDER BY pos').all(p.id).map((r) => r.file),
  };
}

const PRODUCT_FIELDS = ['name', 'brand', 'description', 'price', 'old_price', 'in_stock', 'category', 'is_new'];
export function updateProduct(id, field, value) {
  if (field === 'sizes' || field === 'colors') {
    db.prepare(`UPDATE products SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(value), id);
    return;
  }
  if (!PRODUCT_FIELDS.includes(field)) throw new Error('bad field');
  db.prepare(`UPDATE products SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
}

export const deleteProduct = (id) => db.prepare('UPDATE products SET deleted = 1 WHERE id = ?').run(id);

/** Розмір окремо може бути «немає в наявності». */
export function toggleSize(productId, sizeId) {
  const p = getProduct(productId);
  if (!p) return;
  const sizes = p.sizes.map((s) => (s.id === sizeId ? { ...s, available: !s.available } : s));
  updateProduct(productId, 'sizes', sizes);
}

// ───── Замовлення ─────

export function saveOrder(shopId, data, total) {
  const r = db.prepare('INSERT INTO orders (shop_id, data, total) VALUES (?, ?, ?)').run(shopId, JSON.stringify(data), total);
  return Number(r.lastInsertRowid);
}

export const countOrders = (shopId) => db.prepare('SELECT COUNT(*) AS n FROM orders WHERE shop_id = ?').get(shopId).n;

// ───── Сесії бота ─────

export function getSession(userId) {
  const r = db.prepare('SELECT data FROM sessions WHERE user_id = ?').get(userId);
  return r ? json(r.data, {}) : {};
}
export function setSession(userId, data) {
  db.prepare('INSERT INTO sessions (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data').run(
    userId,
    JSON.stringify(data),
  );
}
