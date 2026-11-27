// Універсальний бот платформи. Один бот на всі магазини:
//  • покупцям — відкриває потрібний магазин за посиланням t.me/<бот>?start=s_<slug>;
//  • власникам — додавання товарів (можна просто переслати пост з каналу), наявність, ціни, налаштування;
//  • адміністратору платформи — створення магазинів і запрошення власників.
// Працює через long polling, стан діалогу зберігається в базі.

import { config, isAdmin, shopUrl } from './config.mjs';
import {
  SLUG_RE, addProduct, allShops, claimShop, countOrders, createShop, deleteProduct, getProduct, getSession,
  getShop, getShopBySlug, listProducts, newInvite, setSession, setShopBot, shopsOfOwner, shopsWithBots, toggleSize, updateProduct,
  updateShop,
} from './db.mjs';
import { CATEGORIES, categoryName } from './catalog.mjs';
import { parsePost, splitList } from './parse.mjs';
import { downloadPhoto, escapeHtml as h, TOKEN_RE, tg } from './telegram.mjs';
import { encrypt } from './secret.mjs';
import { shopBotToken, startAllShopBots, startShopBot, stopShopBot } from './shopBots.mjs';

let botUsername = '';
const botLink = (payload) => `https://t.me/${botUsername}?start=${payload}`;
/** Посилання для покупців: власний бот магазину, якщо підключено, інакше бот платформи. */
const buyerLink = (shop) => (shop.bot_username ? `https://t.me/${shop.bot_username}` : botLink(`s_${shop.slug}`));
const money = (n) => `${new Intl.NumberFormat('uk-UA').format(n)} ₴`;

// ───── Клавіатури ─────

const OWNER_KB = {
  keyboard: [
    [{ text: '➕ Додати товар' }, { text: '📦 Мої товари' }],
    [{ text: '🔗 Посилання' }, { text: '⚙️ Налаштування' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};
const CANCEL_KB = { keyboard: [[{ text: '❌ Скасувати' }]], resize_keyboard: true };
const PHOTOS_KB = { keyboard: [[{ text: '✅ Фото готові' }], [{ text: '❌ Скасувати' }]], resize_keyboard: true };
const inline = (rows) => ({ inline_keyboard: rows });

const say = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ───── Доступ ─────

/** Магазин, яким зараз керує користувач (адмін може керувати будь-яким). */
function currentShop(userId, session) {
  const own = shopsOfOwner(userId);
  const chosen = session.shopId ? getShop(session.shopId) : null;
  if (chosen && (chosen.owner_id === userId || isAdmin(userId))) return chosen;
  return own[0] || null;
}
const canManage = (userId, shop) => shop && (shop.owner_id === userId || isAdmin(userId));

// ───── Майстер додавання товару ─────

const STEPS = ['name', 'brand', 'price', 'category', 'sizes', 'colors', 'description'];
const QUESTIONS = {
  name: 'Як називається товар? Напр.: <i>Пуховик Polo Ralph Lauren</i>',
  brand: 'Бренд? Напр.: <i>Nike</i>. Якщо не треба — надішліть «-»',
  price: 'Ціна в гривнях? Лише число, напр.: <i>2699</i>',
  category: 'Оберіть категорію:',
  sizes: 'Розміри через кому, напр.: <i>S, M, L</i> або <i>40, 41, 42</i>. Якщо розмірів немає — «-»',
  colors: 'Кольори через кому, напр.: <i>Чорний, Сірий</i>. Якщо колір один або не важливий — «-»',
  description: 'Короткий опис (матеріал, особливості). Якщо не треба — «-»',
};

async function ask(chatId, s) {
  const step = s.step;
  if (step === 'category') {
    const rows = [];
    for (let i = 0; i < CATEGORIES.length; i += 2)
      rows.push(CATEGORIES.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `cat:${c.id}` })));
    return say(chatId, QUESTIONS.category, { reply_markup: inline(rows) });
  }
  return say(chatId, QUESTIONS[step], { reply_markup: CANCEL_KB });
}

function nextStep(draft) {
  return STEPS.find((k) => draft[k] === undefined) || 'confirm';
}

function draftSummary(d) {
  const lines = [
    `<b>${h(d.name)}</b>${d.brand ? ` · ${h(d.brand)}` : ''}`,
    `Ціна: <b>${money(d.price)}</b>`,
    `Категорія: ${h(categoryName(d.category))}`,
    `Розміри: ${d.sizes.length ? h(d.sizes.join(', ')) : '—'}`,
    `Кольори: ${d.colors.length ? h(d.colors.join(', ')) : '—'}`,
    `Фото: ${d.photos.length}`,
  ];
  if (d.description) lines.push(`\n${h(d.description)}`);
  return lines.join('\n');
}

async function showConfirm(chatId, s) {
  await say(chatId, `Перевірте товар:\n\n${draftSummary(s.draft)}`, {
    reply_markup: inline([
      [{ text: '✅ Опублікувати', callback_data: 'w:ok' }],
      [
        { text: '✏️ Назва', callback_data: 'we:name' },
        { text: '💰 Ціна', callback_data: 'we:price' },
        { text: '🗂 Категорія', callback_data: 'we:category' },
      ],
      [
        { text: '📏 Розміри', callback_data: 'we:sizes' },
        { text: '🎨 Кольори', callback_data: 'we:colors' },
        { text: '📝 Опис', callback_data: 'we:description' },
      ],
      [{ text: '❌ Скасувати', callback_data: 'w:no' }],
    ]),
  });
}

async function startWizard(chatId, userId, s, shop) {
  s.step = 'photos';
  s.draft = { photos: [], shopId: shop.id };
  setSession(userId, s);
  await say(
    chatId,
    `Додаємо товар у <b>${h(shop.name)}</b>.\n\n` +
      'Надішліть фото товару (до 10 шт.) або <b>просто перешліть пост зі свого каналу</b> — я сам візьму фото, назву, ціну й розміри.\n\n' +
      'Коли всі фото надіслано, натисніть «✅ Фото готові».',
    { reply_markup: PHOTOS_KB },
  );
}

async function finishPhotos(chatId, userId, s) {
  const d = s.draft;
  if (!d.photos.length) return say(chatId, 'Спочатку надішліть хоча б одне фото товару.');
  // Якщо фото прийшли з текстом поста — підставляємо те, що вдалося розпізнати.
  if (d.caption) {
    const p = parsePost(d.caption);
    if (p.name) d.name = p.name;
    if (p.price) d.price = p.price;
    if (p.sizes.length) d.sizes = p.sizes;
    if (p.colors.length) d.colors = p.colors;
    d.description = d.description ?? '';
    if (p.name || p.price) d.brand = d.brand ?? '';
    delete d.caption;
  }
  s.step = nextStep(d);
  setSession(userId, s);
  await say(chatId, `📷 Фото: ${d.photos.length}`, { reply_markup: { remove_keyboard: true } });
  return s.step === 'confirm' ? showConfirm(chatId, s) : ask(chatId, s);
}

async function wizardText(chatId, userId, s, text) {
  const d = s.draft;
  const step = s.step;
  const skip = text.trim() === '-';
  if (step === 'name') {
    if (text.trim().length < 2) return say(chatId, 'Назва закоротка, спробуйте ще раз.');
    d.name = text.trim().slice(0, 80);
  } else if (step === 'brand') {
    d.brand = skip ? '' : text.trim().slice(0, 40);
  } else if (step === 'price') {
    const n = parseInt(text.replace(/\D/g, ''), 10);
    if (!n || n > 10_000_000) return say(chatId, 'Надішліть ціну числом, напр.: 2699');
    d.price = n;
  } else if (step === 'sizes') {
    d.sizes = skip ? [] : splitList(text).slice(0, 30);
  } else if (step === 'colors') {
    d.colors = skip ? [] : splitList(text).slice(0, 12);
  } else if (step === 'description') {
    d.description = skip ? '' : text.trim().slice(0, 1000);
  } else if (step === 'category') {
    return say(chatId, 'Оберіть категорію кнопкою вище 👆');
  }
  s.step = s.returnToConfirm ? 'confirm' : nextStep(d);
  setSession(userId, s);
  return s.step === 'confirm' ? showConfirm(chatId, s) : ask(chatId, s);
}

async function publish(chatId, userId, s) {
  const d = s.draft;
  const shop = getShop(d.shopId);
  if (!canManage(userId, shop)) return;
  const id = addProduct(shop.id, {
    category: d.category,
    brand: d.brand,
    name: d.name,
    description: d.description,
    price: d.price,
    sizes: d.sizes.map((label) => ({ id: label, label, available: true })),
    colors: d.colors,
    photos: d.photos,
  });
  setSession(userId, { shopId: shop.id });
  await say(chatId, `✅ Товар <b>${h(d.name)}</b> опубліковано (№${id}).\n\nМожна одразу додати наступний або переслати ще один пост.`, {
    reply_markup: OWNER_KB,
  });
}

// ───── Товари: перегляд і зміни ─────

const PAGE = 15;
async function listView(chatId, shop, page = 0) {
  const items = listProducts(shop.id);
  if (!items.length) return say(chatId, 'Товарів ще немає. Натисніть «➕ Додати товар» або перешліть пост з каналу.', { reply_markup: OWNER_KB });
  const slice = items.slice(page * PAGE, page * PAGE + PAGE);
  const rows = slice.map((p) => [
    { text: `${p.in_stock ? '✅' : '🚫'} ${p.name.slice(0, 28)} · ${money(p.price)}`, callback_data: `p:${p.id}` },
  ]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀ Назад', callback_data: `list:${page - 1}` });
  if ((page + 1) * PAGE < items.length) nav.push({ text: 'Далі ▶', callback_data: `list:${page + 1}` });
  if (nav.length) rows.push(nav);
  return say(chatId, `<b>${h(shop.name)}</b> — товарів: ${items.length}\nОберіть товар, щоб змінити:`, { reply_markup: inline(rows) });
}

function productCaption(p) {
  return [
    `<b>${h(p.name)}</b>${p.brand ? ` · ${h(p.brand)}` : ''}`,
    `${money(p.price)}${p.old_price ? ` <s>${money(p.old_price)}</s>` : ''}`,
    p.in_stock ? '✅ В наявності' : '🚫 Немає в наявності',
    p.sizes.length ? `Розміри: ${p.sizes.map((z) => (z.available ? z.label : `<s>${h(z.label)}</s>`)).join(', ')}` : '',
    p.colors.length ? `Кольори: ${h(p.colors.join(', '))}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function productKb(p) {
  return inline([
    [{ text: p.in_stock ? '🚫 Немає в наявності' : '✅ Є в наявності', callback_data: `ps:${p.id}` }],
    [
      { text: '💰 Ціна', callback_data: `pe:${p.id}:price` },
      { text: '🏷 Стара ціна (знижка)', callback_data: `pe:${p.id}:old_price` },
    ],
    [
      { text: '📏 Наявність розмірів', callback_data: `pz:${p.id}` },
      { text: '✏️ Назва', callback_data: `pe:${p.id}:name` },
    ],
    [
      { text: '📝 Опис', callback_data: `pe:${p.id}:description` },
      { text: '🗑 Видалити', callback_data: `pdel:${p.id}` },
    ],
  ]);
}

async function productView(chatId, p) {
  const extra = { parse_mode: 'HTML', reply_markup: productKb(p) };
  if (p.photos[0] && config.publicUrl) {
    try {
      return await tg('sendPhoto', { chat_id: chatId, photo: `${config.publicUrl}/media/${p.photos[0]}`, caption: productCaption(p), ...extra });
    } catch {
      /* якщо Telegram не зміг забрати фото — покажемо текстом */
    }
  }
  return say(chatId, productCaption(p), { reply_markup: productKb(p) });
}

const EDIT_PROMPTS = {
  price: 'Нова ціна в гривнях (лише число):',
  old_price: 'Стара ціна для знижки (буде перекреслена). Щоб прибрати знижку — «-»:',
  name: 'Нова назва:',
  description: 'Новий опис. Щоб прибрати — «-»:',
};

async function applyEdit(chatId, userId, s, text) {
  const { productId, field } = s.edit;
  const p = getProduct(productId);
  const shop = p && getShop(p.shop_id);
  if (!canManage(userId, shop)) return;
  const skip = text.trim() === '-';
  if (field === 'price' || field === 'old_price') {
    const n = skip && field === 'old_price' ? null : parseInt(text.replace(/\D/g, ''), 10);
    if (n !== null && (!n || n > 10_000_000)) return say(chatId, 'Надішліть число, напр.: 2699');
    updateProduct(productId, field, n);
  } else if (field === 'name') {
    if (text.trim().length < 2) return say(chatId, 'Назва закоротка.');
    updateProduct(productId, 'name', text.trim().slice(0, 80));
  } else if (field === 'description') {
    updateProduct(productId, 'description', skip ? '' : text.trim().slice(0, 1000));
  }
  setSession(userId, { shopId: shop.id });
  await say(chatId, '✅ Збережено', { reply_markup: OWNER_KB });
  return productView(chatId, getProduct(productId));
}

// ───── Налаштування магазину ─────

const SETTINGS = {
  name: ['Назва магазину', 'Нова назва магазину:'],
  manager: ['Менеджер', 'Username менеджера для покупців, напр. @manager. Щоб прибрати — «-»:'],
  delivery_note: ['Доставка', 'Рядок про доставку на сторінці товару, напр. «Нова пошта 1–2 дні». Прибрати — «-»:'],
  reviews_url: ['Відгуки', 'Посилання на відгуки, напр. https://t.me/... Прибрати — «-»:'],
  hero_title: ['Заголовок банера', 'Заголовок на головній, напр. «Зимова колекція». Прибрати — «-»:'],
  hero_text: ['Текст банера', 'Підзаголовок на головній. Прибрати — «-»:'],
};

async function settingsView(chatId, shop) {
  const rows = Object.entries(SETTINGS).map(([k, [label]]) => [{ text: label, callback_data: `set:${k}` }]);
  rows.push([{ text: shop.bot_username ? `🤖 Свій бот: @${shop.bot_username}` : '🤖 Підключити свій бот', callback_data: 'bot:menu' }]);
  const v = (x) => (x ? h(x) : '—');
  await say(
    chatId,
    `<b>Налаштування «${h(shop.name)}»</b>\n\n` +
      `Менеджер: ${v(shop.manager)}\nДоставка: ${v(shop.delivery_note)}\nВідгуки: ${v(shop.reviews_url)}\n` +
      `Банер: ${v(shop.hero_title)} / ${v(shop.hero_text)}\nСвій бот: ${shop.bot_username ? '@' + h(shop.bot_username) : '—'}`,
    { reply_markup: inline(rows) },
  );
}

async function applySetting(chatId, userId, s, text) {
  const shop = getShop(s.setting.shopId);
  if (!canManage(userId, shop)) return;
  const field = s.setting.field;
  let value = text.trim() === '-' ? '' : text.trim().slice(0, 120);
  if (field === 'name' && value.length < 2) return say(chatId, 'Назва закоротка.');
  if (field === 'manager' && value) {
    value = '@' + value.replace(/^@|^https?:\/\/t\.me\//, '');
    if (!/^@[A-Za-z0-9_]{4,32}$/.test(value)) return say(chatId, 'Введіть username, напр. @manager');
  }
  if (field === 'reviews_url' && value && !/^https:\/\//.test(value)) return say(chatId, 'Посилання має починатися з https://');
  updateShop(shop.id, field, value);
  setSession(userId, { shopId: shop.id });
  await say(chatId, '✅ Збережено', { reply_markup: OWNER_KB });
  return settingsView(chatId, getShop(shop.id));
}

// ───── Власний бот магазину ─────

async function botMenu(chatId, userId, s, action) {
  const shop = currentShop(userId, s);
  if (!canManage(userId, shop)) return;
  if (action === 'menu') {
    if (shop.bot_username)
      return say(
        chatId,
        `🤖 Покупці заходять у магазин через <b>@${h(shop.bot_username)}</b>.\n\n` +
          'Керування товарами й замовлення лишаються тут. Відключити бота можна будь-коли — або тут, або відкликавши токен у @BotFather.',
        { reply_markup: inline([[{ text: 'Відключити свій бот', callback_data: 'bot:off' }]]) },
      );
    return say(
      chatId,
      '🤖 <b>Свій бот для магазину</b>\n\n' +
        'Покупці бачитимуть ваш бот — з вашою назвою й аватаркою.\n\n' +
        '1. Відкрийте @BotFather і надішліть /newbot\n' +
        '2. Придумайте назву й username (має закінчуватися на «bot»)\n' +
        '3. Скопіюйте токен, який надішле @BotFather, і надішліть його сюди.\n\n' +
        'Повідомлення з токеном я одразу видалю з чату, а сам токен зберігається на сервері в зашифрованому вигляді.',
      { reply_markup: inline([[{ text: 'Надіслати токен', callback_data: 'bot:set' }]]) },
    );
  }
  if (action === 'set') {
    setSession(userId, { shopId: shop.id, botTokenFor: shop.id });
    return say(chatId, 'Надішліть токен бота з @BotFather (виглядає як <code>123456789:AA…</code>):', { reply_markup: CANCEL_KB });
  }
  if (action === 'off')
    return say(chatId, `Відключити @${h(shop.bot_username || '')}? Покупці знову заходитимуть через бот платформи.`, {
      reply_markup: inline([[{ text: 'Так, відключити', callback_data: 'bot:offy' }, { text: 'Ні', callback_data: 'bot:menu' }]]),
    });
  if (action === 'offy') {
    const token = shopBotToken(shop);
    stopShopBot(shop.id);
    if (token) await tg('setChatMenuButton', { menu_button: { type: 'default' } }, token).catch(() => {});
    setShopBot(shop.id, null, null);
    return say(chatId, '✅ Свій бот відключено. Посилання для покупців тепер через бот платформи: «🔗 Посилання».', { reply_markup: OWNER_KB });
  }
}

async function connectShopBot(chatId, userId, s, msg) {
  const shop = getShop(s.botTokenFor);
  if (!canManage(userId, shop)) return;
  const token = (msg.text || '').trim();
  // Повідомлення з токеном одразу прибираємо з чату
  await tg('deleteMessage', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
  if (!TOKEN_RE.test(token)) return say(chatId, 'Це не схоже на токен. Скопіюйте його з @BotFather повністю й надішліть ще раз.');
  if (token === config.botToken) return say(chatId, 'Це токен бота платформи. Потрібен токен вашого власного бота.');
  if (shopsWithBots().some((x) => x.id !== shop.id && shopBotToken(x) === token))
    return say(chatId, 'Цей бот уже підключено до іншого магазину. Створіть окремого бота.');
  let me;
  try {
    me = await tg('getMe', {}, token);
  } catch {
    return say(chatId, 'Telegram не приймає цей токен. Перевірте, що скопіювали його повністю й не відкликали в @BotFather.');
  }
  setShopBot(shop.id, encrypt(token), me.username);
  setSession(userId, { shopId: shop.id });
  startShopBot(shop.id, onShopBotRevoked);
  return say(
    chatId,
    `✅ Підключено <b>@${h(me.username)}</b>.\n\nТепер посилання для покупців: https://t.me/${me.username}\n` +
      'Вставте його в канал або закріпіть. Замовлення й надалі приходитимуть сюди.',
    { reply_markup: OWNER_KB },
  );
}

/** Клієнт відкликав токен у @BotFather — повідомляємо власника. */
function onShopBotRevoked(shop) {
  if (!shop?.owner_id) return;
  say(
    shop.owner_id,
    `⚠️ Бот магазину «${h(shop.name)}» перестав працювати: токен відкликано в @BotFather. Покупці знову заходять через бот платформи. ` +
      'Щоб підключити бота знову: «⚙️ Налаштування» → «🤖 Підключити свій бот».',
  ).catch(() => {});
}

// ───── Посилання й привітання ─────

async function linksView(chatId, shop) {
  const web = shopUrl(shop);
  await say(
    chatId,
    `<b>Посилання на «${h(shop.name)}»</b>\n\n` +
      `🤖 Для покупців у Telegram (вставте в канал або закріпіть):\n${buyerLink(shop)}\n\n` +
      (web
        ? `🌐 Сайт, який можна встановити на телефон як застосунок:\n${web}\n\n` +
          'На Android браузер сам запропонує «Встановити». На iPhone: «Поділитися» → «На екран Додому».'
        : '⚠️ У сервера ще немає публічної адреси — веб-посилання з’явиться після налаштування домену в Railway.'),
    { reply_markup: OWNER_KB },
  );
}

async function openShopForBuyer(chatId, shop) {
  const url = shopUrl(shop);
  if (!url) return say(chatId, 'Магазин ще налаштовується. Спробуйте трохи пізніше.');
  await say(chatId, `🛍 <b>${h(shop.name)}</b>\n\nНатисніть кнопку нижче, щоб відкрити магазин.`, {
    reply_markup: inline([[{ text: '🛍 Відкрити магазин', web_app: { url } }]]),
  });
  // Кнопка меню біля поля вводу — саме для цього покупця.
  await tg('setChatMenuButton', { chat_id: chatId, menu_button: { type: 'web_app', text: 'Магазин', web_app: { url } } }).catch(() => {});
}

async function ownerHome(chatId, userId) {
  const shops = shopsOfOwner(userId);
  const s = getSession(userId);
  const shop = currentShop(userId, s);
  if (!shop) return false;
  let text = `Ви керуєте магазином <b>${h(shop.name)}</b>.\nТоварів: ${listProducts(shop.id).length}, замовлень: ${countOrders(shop.id)}.\n\n` +
    'Щоб додати товар — натисніть «➕ Додати товар» або просто перешліть сюди пост зі свого каналу.';
  if (shops.length > 1) text += '\n\nІнший магазин: /shop';
  await say(chatId, text, { reply_markup: OWNER_KB });
  return true;
}

const ADMIN_HELP =
  '<b>Адміністратор платформи</b>\n\n' +
  '/newshop <i>slug Назва</i> — створити магазин (slug — латиниця, напр. <code>/newshop snake Casual snake drop</code>)\n' +
  '/shops — усі магазини\n' +
  '/invite <i>slug</i> — нове запрошення для власника\n' +
  '/manage <i>slug</i> — керувати магазином самому\n' +
  '/pause <i>slug</i> і /resume <i>slug</i> — вимкнути/увімкнути магазин';

async function adminCommand(chatId, userId, text) {
  const [cmd, slugRaw, ...rest] = text.trim().split(/\s+/);
  const slug = (slugRaw || '').toLowerCase();
  if (cmd === '/shops') {
    const shops = allShops();
    if (!shops.length) return say(chatId, 'Магазинів ще немає. Створіть: /newshop slug Назва');
    return say(
      chatId,
      shops
        .map((s) => `${s.active ? '🟢' : '⏸'} <b>${h(s.name)}</b> (<code>${s.slug}</code>) — товарів ${listProducts(s.id).length}, замовлень ${countOrders(s.id)}, власник ${s.owner_id ? '✅' : '— запрошення не прийнято'}${s.bot_username ? `, бот @${s.bot_username}` : ''}`)
        .join('\n'),
    );
  }
  if (cmd === '/newshop') {
    const name = rest.join(' ').trim();
    if (!SLUG_RE.test(slug) || name.length < 2) return say(chatId, 'Формат: /newshop slug Назва\nslug — латиниця, цифри, «-» або «_», напр. <code>snake</code>');
    if (getShopBySlug(slug)) return say(chatId, 'Такий slug уже зайнятий.');
    const shop = createShop(slug, name);
    return say(
      chatId,
      `✅ Магазин <b>${h(name)}</b> створено.\n\n` +
        `👤 Запрошення для власника (одноразове, надішліть йому):\n${botLink(`own_${shop.invite_code}`)}\n\n` +
        `🛍 Посилання для покупців:\n${botLink(`s_${slug}`)}\n` +
        (shopUrl(shop) ? `🌐 Сайт: ${shopUrl(shop)}\n` : '') +
        `\nЩоб наповнити його самому: /manage ${slug}`,
    );
  }
  const shop = getShopBySlug(slug);
  if (!shop) return say(chatId, 'Магазин не знайдено. Список: /shops');
  if (cmd === '/invite') return say(chatId, `Нове запрошення для «${h(shop.name)}»:\n${botLink(`own_${newInvite(shop.id)}`)}`);
  if (cmd === '/manage') {
    setSession(userId, { shopId: shop.id });
    return say(chatId, `Тепер ви керуєте «${h(shop.name)}».`, { reply_markup: OWNER_KB });
  }
  if (cmd === '/pause' || cmd === '/resume') {
    updateShop(shop.id, 'active', cmd === '/resume' ? 1 : 0);
    return say(chatId, cmd === '/resume' ? '🟢 Магазин увімкнено' : '⏸ Магазин вимкнено: покупці його не бачать');
  }
}

// ───── Обробка повідомлень ─────

async function onMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.from) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  const s = getSession(userId);

  if (text.startsWith('/start')) {
    const payload = text.split(/\s+/)[1] || '';
    if (payload.startsWith('s_')) {
      const shop = getShopBySlug(payload.slice(2).toLowerCase());
      if (!shop || !shop.active) return say(chatId, 'Магазин не знайдено або тимчасово недоступний.');
      return openShopForBuyer(chatId, shop);
    }
    if (payload.startsWith('own_')) {
      const shop = claimShop(payload.slice(4), userId);
      if (!shop) return say(chatId, 'Запрошення недійсне або вже використане. Попросіть нове.');
      setSession(userId, { shopId: shop.id });
      await say(chatId, `🎉 Тепер ви власник магазину <b>${h(shop.name)}</b>!\n\nСюди приходитимуть замовлення від покупців.`);
      return ownerHome(chatId, userId);
    }
    setSession(userId, { shopId: s.shopId });
    if (await ownerHome(chatId, userId)) return;
    if (isAdmin(userId)) return say(chatId, ADMIN_HELP);
    return say(chatId, 'Вітаємо! 👋 Це бот магазинів. Відкрийте магазин за посиланням від продавця.');
  }

  if (text === '❌ Скасувати' || text === '/cancel') {
    setSession(userId, { shopId: s.shopId });
    if (!(await ownerHome(chatId, userId))) await say(chatId, 'Скасовано.', { reply_markup: { remove_keyboard: true } });
    return;
  }

  if (isAdmin(userId) && /^\/(newshop|shops|invite|manage|pause|resume)\b/.test(text)) return adminCommand(chatId, userId, text);
  if (text === '/help' && isAdmin(userId)) return say(chatId, ADMIN_HELP);

  if (text === '/shop') {
    const shops = isAdmin(userId) ? allShops() : shopsOfOwner(userId);
    if (!shops.length) return say(chatId, 'У вас немає магазинів.');
    return say(chatId, 'Оберіть магазин:', { reply_markup: inline(shops.map((x) => [{ text: x.name, callback_data: `shop:${x.id}` }])) });
  }

  const shop = currentShop(userId, s);
  if (!shop) {
    if (isAdmin(userId)) return say(chatId, ADMIN_HELP);
    return say(chatId, 'Щоб відкрити магазин, скористайтеся посиланням від продавця.');
  }

  // Активні діалоги
  if (s.step === 'photos') {
    if (msg.photo?.length) return addPhoto(chatId, userId, msg);
    if (text === '✅ Фото готові') return finishPhotos(chatId, userId, getSession(userId));
    return say(chatId, 'Надішліть фото або натисніть «✅ Фото готові».');
  }
  if (s.step && s.step !== 'confirm' && s.draft && text) return wizardText(chatId, userId, s, text);
  if (s.edit && text) return applyEdit(chatId, userId, s, text);
  if (s.setting && text) return applySetting(chatId, userId, s, text);
  if (s.botTokenFor && text) return connectShopBot(chatId, userId, s, msg);

  // Фото без майстра (напр., переслали пост) — одразу починаємо додавання товару
  if (msg.photo?.length) {
    await startWizard(chatId, userId, s, shop);
    return addPhoto(chatId, userId, msg);
  }

  if (text === '➕ Додати товар') return startWizard(chatId, userId, s, shop);
  if (text === '📦 Мої товари') return listView(chatId, shop);
  if (text === '🔗 Посилання') return linksView(chatId, shop);
  if (text === '⚙️ Налаштування') return settingsView(chatId, shop);
  return ownerHome(chatId, userId);
}

// Фото з альбому приходять окремими повідомленнями майже одночасно — обробляємо по черзі.
let photoQueue = Promise.resolve();
function addPhoto(chatId, userId, msg) {
  photoQueue = photoQueue.then(async () => {
    const s = getSession(userId);
    if (s.step !== 'photos') return;
    if (s.draft.photos.length >= 10) return say(chatId, 'Максимум 10 фото. Натисніть «✅ Фото готові».');
    const best = msg.photo[msg.photo.length - 1];
    try {
      const file = await downloadPhoto(best.file_id);
      s.draft.photos.push(file);
      if (msg.caption && !s.draft.caption) s.draft.caption = msg.caption;
      setSession(userId, s);
      // Підтверджуємо лише перше фото з альбому, щоб не засмічувати чат.
      if (s.draft.photos.length === 1 || !msg.media_group_id)
        await say(chatId, `📷 Фото додано (${s.draft.photos.length}). Ще фото або «✅ Фото готові».`, { reply_markup: PHOTOS_KB });
    } catch (e) {
      console.error('Фото:', e.message);
      await say(chatId, 'Не вдалося зберегти це фото, спробуйте ще раз.');
    }
  });
  return photoQueue;
}

async function onCallback(q) {
  const chatId = q.message?.chat?.id;
  const userId = q.from.id;
  const data = q.data || '';
  await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  if (!chatId) return;
  const s = getSession(userId);
  const [kind, a, b] = data.split(':');

  if (kind === 'shop') {
    const shop = getShop(Number(a));
    if (!canManage(userId, shop)) return;
    setSession(userId, { shopId: shop.id });
    return ownerHome(chatId, userId);
  }

  // Майстер
  if (kind === 'cat' && s.draft) {
    if (!CATEGORIES.some((c) => c.id === a)) return;
    s.draft.category = a;
    s.step = s.returnToConfirm ? 'confirm' : nextStep(s.draft);
    setSession(userId, s);
    return s.step === 'confirm' ? showConfirm(chatId, s) : ask(chatId, s);
  }
  if (kind === 'w' && s.draft) {
    if (a === 'ok') {
      if (s.step !== 'confirm') return;
      return publish(chatId, userId, s);
    }
    setSession(userId, { shopId: s.shopId });
    return ownerHome(chatId, userId);
  }
  if (kind === 'we' && s.draft && STEPS.includes(a)) {
    s.step = a;
    s.returnToConfirm = true;
    setSession(userId, s);
    return ask(chatId, s);
  }

  // Налаштування
  if (kind === 'bot') return botMenu(chatId, userId, s, a);

  if (kind === 'set' && SETTINGS[a]) {
    const shop = currentShop(userId, s);
    if (!canManage(userId, shop)) return;
    setSession(userId, { shopId: shop.id, setting: { shopId: shop.id, field: a } });
    return say(chatId, SETTINGS[a][1], { reply_markup: CANCEL_KB });
  }

  if (kind === 'list') {
    const shop = currentShop(userId, s);
    if (shop) return listView(chatId, shop, Number(a) || 0);
    return;
  }

  // Дії з товаром — завжди перевіряємо, що товар належить магазину користувача
  const p = getProduct(Number(a));
  const shop = p && getShop(p.shop_id);
  if (!canManage(userId, shop)) return;
  if (kind === 'p') return productView(chatId, p);
  if (kind === 'ps') {
    updateProduct(p.id, 'in_stock', p.in_stock ? 0 : 1);
    return productView(chatId, getProduct(p.id));
  }
  if (kind === 'pe' && EDIT_PROMPTS[b]) {
    setSession(userId, { shopId: shop.id, edit: { productId: p.id, field: b } });
    return say(chatId, EDIT_PROMPTS[b], { reply_markup: CANCEL_KB });
  }
  if (kind === 'pz') {
    if (!p.sizes.length) return say(chatId, 'У цього товару немає розмірів.');
    const rows = p.sizes.map((z) => [{ text: `${z.available ? '✅' : '❌'} ${z.label}`, callback_data: `pzt:${p.id}:${z.id}`.slice(0, 64) }]);
    rows.push([{ text: 'Готово', callback_data: `p:${p.id}` }]);
    return say(chatId, 'Натисніть на розмір, щоб змінити наявність:', { reply_markup: inline(rows) });
  }
  if (kind === 'pzt') {
    const sizeId = data.split(':').slice(2).join(':');
    toggleSize(p.id, sizeId);
    const fresh = getProduct(p.id);
    const rows = fresh.sizes.map((z) => [{ text: `${z.available ? '✅' : '❌'} ${z.label}`, callback_data: `pzt:${p.id}:${z.id}`.slice(0, 64) }]);
    rows.push([{ text: 'Готово', callback_data: `p:${p.id}` }]);
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: inline(rows) }).catch(() => {});
  }
  if (kind === 'pdel') {
    return say(chatId, `Видалити «${h(p.name)}»?`, {
      reply_markup: inline([[{ text: '🗑 Так, видалити', callback_data: `pdy:${p.id}` }, { text: 'Ні', callback_data: `p:${p.id}` }]]),
    });
  }
  if (kind === 'pdy') {
    deleteProduct(p.id);
    return say(chatId, `🗑 «${h(p.name)}» видалено.`, { reply_markup: OWNER_KB });
  }
}

// ───── Сповіщення про замовлення ─────

export async function notifyOrder(shop, o, buyerToken = config.botToken) {
  if (!config.botToken) return;
  const lines = o.lines.map((l) => `• ${h(l.name)}${l.variant ? ` (${h(l.variant)})` : ''} × ${l.qty} — ${money(l.price * l.qty)}`);
  const buyer = o.buyer
    ? `\nTelegram: ${o.buyer.username ? '@' + h(o.buyer.username) : `<a href="tg://user?id=${o.buyer.id}">${h(o.buyer.name || 'профіль')}</a>`}`
    : '';
  const text =
    `🛒 <b>Нове замовлення №${o.number}</b> — ${h(shop.name)}\n\n${lines.join('\n')}\n\n<b>Разом: ${money(o.total)}</b>\n\n` +
    `👤 ${h(o.customer.fullName)}\n📞 ${h(o.customer.phone)}${buyer}\n` +
    `🚚 ${h(o.delivery.method)}, ${h(o.delivery.city)}, ${h(o.delivery.point)}` +
    (o.comment ? `\n💬 ${h(o.comment)}` : '');
  const targets = shop.owner_id ? [shop.owner_id] : config.adminIds;
  for (const id of targets) await say(id, text).catch((e) => console.error('Сповіщення власнику:', e.message));
  if (o.buyer?.id) {
    // Підтвердження — від того бота, через який покупець відкрив магазин
    await tg(
      'sendMessage',
      {
        chat_id: o.buyer.id,
        parse_mode: 'HTML',
        text:
          `✅ Ваше замовлення №${o.number} у «${h(shop.name)}» прийнято на суму ${money(o.total)}.\n` +
          (shop.manager ? `Менеджер ${h(shop.manager)} зв’яжеться з вами найближчим часом.` : 'Продавець зв’яжеться з вами найближчим часом.'),
      },
      buyerToken,
    ).catch(() => {});
  }
}

// ───── Запуск ─────

export function startBot() {
  if (!config.botToken) {
    console.log('Бот: BOT_TOKEN не задано, бот вимкнено');
    return;
  }
  if (!config.publicUrl) console.log('Бот: немає публічної адреси (згенеруйте домен у Railway або задайте WEBAPP_URL)');
  if (!config.adminIds.length) console.log('Бот: ADMIN_IDS не задано — створювати магазини ніхто не зможе');

  (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await tg('deleteWebhook', { drop_pending_updates: false });
        const me = await tg('getMe');
        botUsername = me.username;
        await tg('setMyCommands', { commands: [{ command: 'start', description: 'Головне меню' }] });
        console.log(`Бот: @${botUsername} запущено${config.publicUrl ? `, сайт ${config.publicUrl}` : ''}`);
        startAllShopBots(onShopBotRevoked);
        break;
      } catch (e) {
        console.error('Бот: не вдалося запустити —', e.message);
        if (/Unauthorized|Not Found/i.test(e.message)) return console.error('Бот: перевірте BOT_TOKEN');
        await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * 2 ** attempt)));
      }
    }
    let offset = 0;
    let delay = 1000;
    for (;;) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
        delay = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          const job = u.message ? onMessage(u.message) : u.callback_query ? onCallback(u.callback_query) : null;
          if (job) await job.catch((e) => console.error('Бот:', e.message));
        }
      } catch (e) {
        if (/Unauthorized/i.test(e.message)) return console.error('Бот: токен недійсний. Бот зупинено.');
        console.error(/Conflict/i.test(e.message) ? 'Бот: цей токен уже використовує інший запущений бот. Чекаю…' : `Бот: ${e.message}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
  })();
}

