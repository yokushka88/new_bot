// Імітація Telegram Bot API для тестів: кілька ботів (за токеном), черга оновлень,
// журнал викликів, завантаження фото. Токени з «BAD» Telegram «не приймає».
const http = require('http');
const fs = require('fs');
const photo = fs.readFileSync(__dirname + '/fixture.jpg');
const bots = new Map(); // token → { queue, waiters, revoked }
const calls = [];
let uid = 1;
const bot = (t) => {
  if (!bots.has(t)) bots.set(t, { queue: [], waiters: [], revoked: false });
  return bots.get(t);
};
const known = (t) => t === 'TEST:TOKEN' || (/^\d{6,12}:[\w-]{30,50}$/.test(t) && !t.includes('BAD'));

http
  .createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const ok = (r) => res.end(JSON.stringify({ ok: true, result: r }));
      const fail = (d) => res.end(JSON.stringify({ ok: false, description: d }));
      if (url.pathname === '/__push') {
        const u = JSON.parse(b);
        u.update_id = uid++;
        const bt = bot(url.searchParams.get('token') || 'TEST:TOKEN');
        bt.queue.push(u);
        bt.waiters.slice().forEach((w) => w());
        return res.end('ok');
      }
      if (url.pathname === '/__revoke') {
        bot(url.searchParams.get('token')).revoked = true;
        return res.end('ok');
      }
      if (url.pathname === '/__calls') return res.end(JSON.stringify(calls));
      if (url.pathname.startsWith('/file/bot')) {
        res.setHeader('content-type', 'image/jpeg');
        return res.end(photo);
      }
      const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!m) return fail('Not Found');
      const [, token, method] = m;
      const bt = bot(token);
      if (!known(token) || bt.revoked) return fail('Unauthorized');
      const body = b ? JSON.parse(b) : {};
      if (method !== 'getUpdates') calls.push({ token, m: method, body });
      if (method === 'getMe') return ok({ username: token === 'TEST:TOKEN' ? 'TestShopsBot' : `Shop${token.split(':')[0]}Bot` });
      if (method === 'getFile') return ok({ file_path: 'photos/p.jpg', file_size: photo.length });
      if (method === 'getUpdates') {
        const send = () => {
          const off = body.offset || 0;
          const u = bt.queue.filter((x) => x.update_id >= off);
          bt.queue = [];
          if (bt.revoked) return fail('Unauthorized');
          ok(u);
        };
        if (bt.queue.length) return send();
        let done = false;
        const fire = () => {
          if (done) return;
          done = true;
          bt.waiters = bt.waiters.filter((w) => w !== fire);
          send();
        };
        setTimeout(fire, 700);
        bt.waiters.push(fire);
        return;
      }
      if (method === 'sendMessage' || method === 'sendPhoto') return ok({ message_id: calls.length });
      ok(true);
    });
  })
  .listen(9933, () => console.log('mock ok'));
