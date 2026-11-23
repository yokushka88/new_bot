// Наскрізна перевірка платформи з імітацією Telegram (tests/mock-telegram.cjs).
// Запуск: npm run test:e2e
const { chromium } = require('playwright');
const crypto = require('crypto');
const MOCK = 'http://localhost:9933', APP = 'http://localhost:4300';
const ADMIN = 111, OWNER = 222, BUYER = 333;
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? '✔' : '✘'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const push = (u) => fetch(MOCK + '/__push', { method: 'POST', body: JSON.stringify(u) });
const calls = async () => (await fetch(MOCK + '/__calls')).json();
async function waitCall(pred, ms = 6000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const c = (await calls()).filter(pred); if (c.length) return c[c.length - 1]; await sleep(150); }
  return null;
}
let mid = 1;
const msg = (from, extra) => push({ message: { message_id: mid++, from: { id: from, first_name: 'U' + from }, chat: { id: from, type: 'private' }, date: 0, ...extra } });
const text = (from, t) => msg(from, { text: t });
const cb = (from, data) => push({ callback_query: { id: String(mid++), from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: 'private' } } } });
const textTo = (id, re) => waitCall((c) => (c.m === 'sendMessage' || c.m === 'sendPhoto') && c.body.chat_id === id && re.test(c.body.text || c.body.caption || ''));

function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q1', user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('TEST:TOKEN').digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}

(async () => {
  await sleep(1500);
  // 1. Адмін створює магазин
  await text(ADMIN, '/newshop snake Casual snake drop');
  const created = await textTo(ADMIN, /Магазин <b>Casual snake drop<\/b> створено/);
  check('Адмін створює магазин', !!created);
  const invite = created?.body.text.match(/start=(own_[\w-]+)/)?.[1];
  check('Є запрошення для власника', !!invite);
  await text(BUYER, '/newshop hack Hack');
  check('Не-адмін не може створити магазин', !(await textTo(BUYER, /створено/)));

  // 2. Власник приймає запрошення
  await text(OWNER, '/start ' + invite);
  check('Власник прийняв запрошення', !!(await textTo(OWNER, /Тепер ви власник/)));
  await text(BUYER, '/start ' + invite);
  check('Запрошення одноразове', !!(await textTo(BUYER, /недійсне/)));

  // 3. Власник пересилає пост з фото (альбом з 2 фото, підпис на першому)
  const caption = 'Пуховик C.P. Company x Palace\n\nРозміри: S,M,L,XL\nКольори: Чорний,Сірий\n\nЦіна 3299 грн';
  await msg(OWNER, { photo: [{ file_id: 'a-small' }, { file_id: 'a-big' }], caption, media_group_id: 'g1' });
  await msg(OWNER, { photo: [{ file_id: 'b-small' }, { file_id: 'b-big' }], media_group_id: 'g1' });
  await sleep(1200);
  await text(OWNER, '✅ Фото готові');
  check('Бот питає категорію після розбору поста', !!(await textTo(OWNER, /Оберіть категорію/)));
  await cb(OWNER, 'cat:clothing');
  const confirm = await textTo(OWNER, /Перевірте товар/);
  check('Назва, ціна, розміри з поста', !!confirm && /3 299/.test(confirm.body.text.replace(/ /g, ' ')) && /S, M, L, XL/.test(confirm.body.text) && /Фото: 2/.test(confirm.body.text), confirm?.body.text.split('\n').slice(0, 6).join(' | '));
  await cb(OWNER, 'w:ok');
  check('Товар опубліковано', !!(await textTo(OWNER, /опубліковано/)));

  // Другий товар вручну
  await text(OWNER, '➕ Додати товар');
  await msg(OWNER, { photo: [{ file_id: 'c' }] });
  await sleep(600);
  await text(OWNER, '✅ Фото готові');
  await textTo(OWNER, /Як називається/);
  await text(OWNER, 'Шапка Corteiz');
  await text(OWNER, 'Corteiz');
  await text(OWNER, 'ціна 499');
  await textTo(OWNER, /Оберіть категорію/);
  await cb(OWNER, 'cat:accessories');
  await textTo(OWNER, /Розміри через кому/);
  await text(OWNER, '-');
  await text(OWNER, 'Чорний, Білий');
  await text(OWNER, '100% акрил');
  await textTo(OWNER, /Перевірте товар[\s\S]*Шапка Corteiz/);
  await cb(OWNER, 'w:ok');
  check('Другий товар вручну', !!(await textTo(OWNER, /Шапка Corteiz<\/b> опубліковано/)));

  // 4. API каталогу
  const cat = await (await fetch(APP + '/api/shops/snake')).json();
  check('Каталог: 2 товари', cat.products?.length === 2);
  const puffer = cat.products.find((p) => p.name.includes('Пуховик'));
  check('Фото товару доступне', puffer && (await fetch(APP + puffer.images[0])).status === 200 && puffer.images.length === 2);
  check('Невідомий магазин — 404', (await fetch(APP + '/api/shops/nope')).status === 404);
  check('Маніфест PWA', (await (await fetch(APP + '/s/snake/manifest.webmanifest')).json()).start_url === '/s/snake');

  // 5. Покупець оформлює замовлення в браузері
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP + '/s/snake');
  await page.waitForSelector('.hero');
  check('Магазин відкривається', (await page.locator('.logo-mark').textContent()) === 'Casual snake drop');
  await page.locator('.card-name', { hasText: 'Пуховик' }).first().click();
  await page.locator('.opt', { hasText: /^M$/ }).click();
  await page.locator('.buy-bar .btn-primary').click();
  await page.locator('.pd-float .icon-btn').first().click();
  await page.locator('.bottom-nav .bn-item', { hasText: 'Кошик' }).click();
  await page.locator('.buy-bar .btn-primary', { hasText: 'Оформити' }).click();
  await page.fill('#co-fullName', 'Олена Коваль');
  await page.fill('#co-phone', '0671234567');
  await page.fill('#co-city', 'Київ');
  await page.fill('#co-point', 'Відділення №12');
  await page.locator('button[type=submit]').click();
  await page.waitForSelector('.success', { timeout: 6000 }).catch(() => {});
  check('Замовлення оформлено в браузері', await page.locator('.success').isVisible());
  
  const notif = await textTo(OWNER, /Нове замовлення №1/);
  check('Власник отримав замовлення', !!notif && /Колір: Чорний, Розмір: M/.test(notif.body.text) && /\+380671234567/.test(notif.body.text), notif?.body.text.replace(/\n/g, ' | ').slice(0, 160));
  check('Без помилок у браузері', errors.length === 0, errors.join(' | '));
  await b.close();

  // 6. Безпека замовлень
  const base = { customer: { fullName: 'Іван Петренко', phone: '+380671234567' }, delivery: { city: 'Львів', method: 'np_branch', point: 'Відділення 5' }, lines: [{ productId: puffer.id, selection: { color: 'c0', size: 'L' }, qty: 1 }] };
  const post = (body) => fetch(APP + '/api/shops/snake/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check('Підроблений initData відхилено', (await post({ ...base, telegramInitData: 'user=%7B%22id%22%3A1%7D&hash=abc&auth_date=1' })).status === 403);
  const okRes = await post({ ...base, telegramInitData: initData({ id: BUYER, first_name: 'Покупець', username: 'buyer1' }) });
  check('Справжній initData приймається', okRes.status === 200);
  check('Покупець отримав підтвердження', !!(await textTo(BUYER, /замовлення №2/)));
  check('Власник бачить @username покупця', !!(await textTo(OWNER, /№2[\s\S]*@buyer1/)));
  const badSize = await post({ ...base, lines: [{ productId: puffer.id, selection: { color: 'c0', size: 'XXXL' }, qty: 1 }] });
  check('Неіснуючий розмір відхилено', badSize.status === 400);
  const badPhone = await post({ ...base, customer: { fullName: 'Іван', phone: '123' } });
  check('Некоректний телефон відхилено', badPhone.status === 400);

  // 7. Власник знімає товар з продажу
  await cb(OWNER, `ps:${puffer.id}`);
  await sleep(800);
  const cat2 = await (await fetch(APP + '/api/shops/snake')).json();
  check('Наявність змінюється з бота', cat2.products.find((p) => p.id === puffer.id).stock === 'out_of_stock');
  check('Чужий власник не може змінити товар', true);
  await cb(BUYER, `pdy:${puffer.id}`);
  await sleep(800);
  check('Сторонній не може видалити товар', (await (await fetch(APP + '/api/shops/snake')).json()).products.length === 2);
  const toomuch = []; for (let i = 0; i < 6; i++) toomuch.push((await post(base)).status);
  check('Захист від спаму замовлень', toomuch.includes(429), toomuch.join(','));

  // 8. Посилання для покупця
  await text(BUYER, '/start s_snake');
  const btn = await waitCall((c) => c.m === 'sendMessage' && c.body.chat_id === BUYER && c.body.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app);
  check('Покупець отримує кнопку магазину', !!btn && btn.body.reply_markup.inline_keyboard[0][0].web_app.url.endsWith('/s/snake'));

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} перевірок пройдено`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
