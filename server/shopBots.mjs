// Власні боти магазинів. Клієнт підключає свого бота з @BotFather, і покупці заходять
// у магазин через нього (з назвою й аватаркою клієнта). Такий бот лише відкриває магазин;
// керування товарами й замовлення лишаються в боті платформи.
// Клієнт будь-коли може відключити бота в налаштуваннях або відкликати токен у @BotFather.

import { shopUrl } from './config.mjs';
import { getShop, setShopBot, shopsWithBots } from './db.mjs';
import { decrypt } from './secret.mjs';
import { escapeHtml as h, tg } from './telegram.mjs';

const running = new Map(); // shopId → { stop }

export const shopBotToken = (shop) => (shop?.bot_token ? decrypt(shop.bot_token) : null);

async function openButton(token, chatId, shop) {
  const url = shopUrl(shop);
  if (!url) return tg('sendMessage', { chat_id: chatId, text: 'Магазин ще налаштовується. Спробуйте трохи пізніше.' }, token);
  return tg(
    'sendMessage',
    {
      chat_id: chatId,
      text: `🛍 <b>${h(shop.name)}</b>\n\nНатисніть кнопку нижче, щоб відкрити магазин.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🛍 Відкрити магазин', web_app: { url } }]] },
    },
    token,
  );
}

/**
 * Запускає long polling для бота магазину. onRevoked(shop) викликається, якщо Telegram
 * більше не приймає токен (клієнт його відкликав) — тоді бот відключається.
 */
export function startShopBot(shopId, onRevoked) {
  stopShopBot(shopId);
  const shop0 = getShop(shopId);
  const token = shopBotToken(shop0);
  if (!token) return;
  let stopped = false;
  running.set(shopId, { stop: () => (stopped = true) });

  (async () => {
    try {
      await tg('deleteWebhook', { drop_pending_updates: false }, token);
      const url = shopUrl(shop0);
      // Кнопка «Магазин» біля поля вводу — для всіх, хто відкриє цього бота
      if (url) await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Магазин', web_app: { url } } }, token);
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Відкрити магазин' }] }, token);
      console.log(`Бот магазину «${shop0.slug}»: @${shop0.bot_username} запущено`);
    } catch (e) {
      console.error(`Бот магазину «${shop0.slug}»:`, e.message);
    }
    let offset = 0;
    let delay = 1000;
    while (!stopped) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, token);
        delay = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (stopped || !m || m.chat?.type !== 'private') continue;
          const shop = getShop(shopId);
          if (!shop) continue;
          if (!shop.active) {
            await tg('sendMessage', { chat_id: m.chat.id, text: 'Магазин тимчасово недоступний.' }, token).catch(() => {});
            continue;
          }
          await openButton(token, m.chat.id, shop).catch((e) => console.error(`Бот «${shop.slug}»:`, e.message));
        }
      } catch (e) {
        if (stopped) break;
        if (/Unauthorized/i.test(e.message)) {
          console.error(`Бот магазину «${shop0.slug}»: токен відкликано, бота відключено`);
          stopped = true;
          running.delete(shopId);
          setShopBot(shopId, null, null);
          onRevoked?.(getShop(shopId));
          break;
        }
        if (!/Conflict/i.test(e.message)) console.error(`Бот магазину «${shop0.slug}»:`, e.message);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
      }
    }
  })();
}

export function stopShopBot(shopId) {
  running.get(shopId)?.stop();
  running.delete(shopId);
}

export function startAllShopBots(onRevoked) {
  for (const s of shopsWithBots()) startShopBot(s.id, onRevoked);
}
