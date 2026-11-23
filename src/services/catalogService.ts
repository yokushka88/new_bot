// Каталог магазину завантажується з сервера платформи: GET /api/shops/<slug>.

import type { Catalog, Category, Product } from '../data/types';
import { applyShop, shopSlug, type ShopInfo } from '../config/shop';

export class CatalogError extends Error {
  constructor(
    message: string,
    public kind: 'no-shop' | 'not-found' | 'network',
  ) {
    super(message);
  }
}

export async function loadCatalog(): Promise<Catalog> {
  const slug = shopSlug();
  if (!slug) throw new CatalogError('Відкрийте магазин за посиланням від продавця.', 'no-shop');
  let res: Response;
  try {
    res = await fetch(`/api/shops/${slug}`, { cache: 'no-store' });
  } catch {
    throw new CatalogError('Перевірте з’єднання з інтернетом і спробуйте ще раз.', 'network');
  }
  if (res.status === 404) throw new CatalogError('Магазин не знайдено або він тимчасово недоступний.', 'not-found');
  if (!res.ok) throw new CatalogError('Не вдалося завантажити каталог. Спробуйте ще раз.', 'network');
  const data = (await res.json()) as { shop: ShopInfo; categories: Category[]; products: Product[] };
  applyShop(data.shop);
  return { categories: data.categories, products: data.products, isDemo: false };
}
