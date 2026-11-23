// Перетворення даних з бази у формат, який розуміє застосунок магазину,
// і перевірка замовлень (ціни завжди беремо з бази, а не з браузера).

import { getProduct, listProducts } from './db.mjs';

export const CATEGORIES = [
  { id: 'clothing', name: 'Одяг', tagline: 'Одяг на кожен день' },
  { id: 'sneakers', name: 'Взуття', tagline: 'Кросівки та черевики' },
  { id: 'accessories', name: 'Аксесуари', tagline: 'Сумки, шапки та інше' },
  { id: 'perfume', name: 'Парфумерія', tagline: 'Аромати' },
  { id: 'watches', name: 'Годинники', tagline: 'Годинники' },
];
export const categoryName = (id) => CATEGORIES.find((c) => c.id === id)?.name ?? id;

const SWATCHES = {
  чорний: '#141414', білий: '#f1f1ee', сірий: '#8d8f93', графітовий: '#3f4245', бежевий: '#c9b18a',
  коричневий: '#6b4428', червоний: '#b3262e', бордовий: '#6d1f2c', рожевий: '#e0307a', синій: '#2b4fa8',
  'темно-синій': '#1e2a4d', блакитний: '#5aa9e6', зелений: '#4f5a35', оливковий: '#5c5a3e', хакі: '#6b6a45',
  жовтий: '#e2c043', помаранчевий: '#e0762b', фіолетовий: '#6b3fa0', кремовий: '#efe6d2', золотий: '#c9a85c',
  срібний: '#c0c3c7',
};
const swatchFor = (label) => SWATCHES[String(label).toLowerCase().trim()] ?? '#777';

const NEW_DAYS = 14;

function toAppProduct(p) {
  const options = [];
  if (p.colors.length > 1 || (p.colors.length === 1 && p.sizes.length === 0)) {
    options.push({
      id: 'color',
      label: 'Колір',
      values: p.colors.map((c, i) => ({ id: `c${i}`, label: c, swatch: swatchFor(c), available: true })),
    });
  }
  if (p.sizes.length) {
    options.push({ id: 'size', label: 'Розмір', values: p.sizes.map((s) => ({ id: s.id, label: s.label, available: !!s.available })) });
  }
  const attributes = [];
  if (p.colors.length === 1 && p.sizes.length) attributes.push({ label: 'Колір', value: p.colors[0] });
  const allSizesGone = p.sizes.length > 0 && p.sizes.every((s) => !s.available);
  const created = new Date(p.created_at.replace(' ', 'T') + 'Z');
  const tags = [];
  if (p.is_new && Date.now() - created.getTime() < NEW_DAYS * 864e5) tags.push('new');
  if (p.old_price && p.old_price > p.price) tags.push('sale');
  return {
    id: String(p.id),
    categoryId: p.category,
    subcategoryIds: [],
    brand: p.brand,
    name: p.name,
    shortDescription: p.description.split(/(?<=[.!?])\s|\n/)[0].slice(0, 90),
    description: p.description,
    price: p.price,
    oldPrice: p.old_price && p.old_price > p.price ? p.old_price : undefined,
    images: p.photos.map((f) => `/media/${f}`),
    attributes,
    options,
    stock: !p.in_stock || allSizesGone ? 'out_of_stock' : 'in_stock',
    tags,
    popularity: 0,
    addedAt: created.toISOString(),
  };
}

export function publicCatalog(shop) {
  const products = listProducts(shop.id).map(toAppProduct);
  const used = new Set(products.map((p) => p.categoryId));
  const categories = CATEGORIES.filter((c) => used.has(c.id)).map((c) => ({
    ...c,
    image: products.find((p) => p.categoryId === c.id && p.images[0])?.images[0] ?? '',
    subcategories: [],
    filterOptions: ['size', 'color'],
  }));
  const heroProduct = products.find((p) => p.images[0] && p.stock !== 'out_of_stock');
  return {
    shop: {
      slug: shop.slug,
      name: shop.name,
      subtitle: shop.subtitle,
      manager: shop.manager,
      deliveryNote: shop.delivery_note,
      reviewsUrl: shop.reviews_url,
      hero: {
        eyebrow: shop.name,
        title: shop.hero_title || 'Нові надходження',
        text: shop.hero_text || '',
        image: heroProduct?.images[0] ?? '',
      },
    },
    categories,
    products,
  };
}

// ───── Перевірка замовлення ─────

const METHODS = {
  np_branch: 'Нова пошта — відділення',
  np_locker: 'Нова пошта — поштомат',
  ukrposhta: 'Укрпошта',
  courier: 'Кур’єр',
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Повертає {order} або {error}. */
export function validateOrder(shop, body) {
  const fullName = str(body?.customer?.fullName, 80);
  const phone = str(body?.customer?.phone, 20).replace(/[^\d+]/g, '');
  const city = str(body?.delivery?.city, 60);
  const method = str(body?.delivery?.method, 20);
  const point = str(body?.delivery?.point, 120);
  const comment = str(body?.comment, 500);
  if (fullName.length < 3) return { error: 'Вкажіть ім’я та прізвище' };
  if (!/^\+380\d{9}$/.test(phone)) return { error: 'Некоректний номер телефону' };
  if (city.length < 2) return { error: 'Вкажіть місто' };
  if (!METHODS[method]) return { error: 'Оберіть спосіб доставки' };
  if (point.length < 2) return { error: 'Вкажіть відділення або адресу' };
  if (!Array.isArray(body?.lines) || !body.lines.length || body.lines.length > 30) return { error: 'Кошик порожній' };

  const lines = [];
  let total = 0;
  for (const l of body.lines) {
    const p = getProduct(Number(l?.productId));
    if (!p || p.shop_id !== shop.id) return { error: 'Товар не знайдено, оновіть кошик' };
    const app = toAppProduct(p);
    if (app.stock === 'out_of_stock') return { error: `«${p.name}» уже немає в наявності` };
    const qty = Math.max(1, Math.min(10, Math.floor(Number(l.qty) || 1)));
    const sel = l.selection && typeof l.selection === 'object' ? l.selection : {};
    const parts = [];
    for (const g of app.options) {
      const v = g.values.find((x) => x.id === sel[g.id]);
      if (!v) return { error: `Оберіть ${g.label.toLowerCase()} для «${p.name}»` };
      if (!v.available) return { error: `${g.label} ${v.label} для «${p.name}» уже немає` };
      parts.push(`${g.label}: ${v.label}`);
    }
    lines.push({ productId: p.id, name: p.name, brand: p.brand, variant: parts.join(', '), qty, price: p.price });
    total += p.price * qty;
  }
  return {
    order: {
      customer: { fullName, phone },
      delivery: { city, method: METHODS[method], point },
      comment,
      lines,
      total,
    },
  };
}
