// Налаштування магазину приходять із сервера разом із каталогом (див. catalogService).
// Тут — значення за замовчуванням, поки каталог завантажується.

export interface ShopInfo {
  slug: string;
  name: string;
  subtitle: string;
  manager: string;
  deliveryNote: string;
  reviewsUrl: string;
  hero: { eyebrow: string; title: string; text: string; image: string };
}

export const shopConfig = {
  slug: '',
  name: 'Магазин',
  subtitle: '',
  currency: '₴',
  isDemo: false,
  contacts: {
    phone: '' as string,
    /** Менеджер для покупців у Telegram, напр. '@username'. */
    telegram: '' as string,
    email: '' as string,
    hours: '' as string,
  },
  reviewsUrl: '' as string,
  deliveryNote: '' as string,
  hero: { eyebrow: '', title: '', text: '', image: undefined as string | undefined },
  delivery: { freeFrom: 0 },
};

/** Застосовує налаштування магазину, отримані з сервера. */
export function applyShop(s: ShopInfo) {
  shopConfig.slug = s.slug;
  shopConfig.name = s.name;
  shopConfig.subtitle = s.subtitle;
  shopConfig.contacts.telegram = s.manager;
  shopConfig.reviewsUrl = s.reviewsUrl;
  shopConfig.deliveryNote = s.deliveryNote;
  shopConfig.hero = { ...s.hero, image: s.hero.image || undefined };
  document.title = s.name;
}

/** Slug магазину з адреси /s/<slug>. */
export function shopSlug(): string {
  const m = window.location.pathname.match(/^\/s\/([a-z0-9_-]+)/);
  return m ? m[1] : '';
}

/** Посилання на чат з менеджером. */
export const managerUrl = () => {
  const u = shopConfig.contacts.telegram.replace(/^@/, '');
  return u ? `https://t.me/${u}` : '';
};
