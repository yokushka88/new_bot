// Імітація Telegram Bot API для тестів: черга оновлень, журнал викликів, завантаження фото.
const http = require('http');
const fs = require('fs');
const photo = fs.readFileSync(__dirname + '/fixture.jpg');
let queue = [], calls = [], uid = 1, waiters = [];
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const ok = (r) => res.end(JSON.stringify({ ok: true, result: r }));
    if (req.url === '/__push') { const u = JSON.parse(b); u.update_id = uid++; queue.push(u); waiters.slice().forEach((w) => w()); return res.end('ok'); }
    if (req.url === '/__calls') return res.end(JSON.stringify(calls));
    if (req.url.startsWith('/file/botTEST:TOKEN/')) { res.setHeader('content-type', 'image/jpeg'); return res.end(photo); }
    if (!req.url.startsWith('/botTEST:TOKEN/')) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    const m = req.url.split('/').pop();
    const body = b ? JSON.parse(b) : {};
    if (m !== 'getUpdates') calls.push({ m, body });
    if (m === 'getMe') return ok({ username: 'TestShopsBot' });
    if (m === 'getFile') return ok({ file_path: 'photos/p.jpg', file_size: photo.length });
    if (m === 'getUpdates') {
      const send = () => { const u = queue.filter((x) => x.update_id >= (body.offset || 0)); queue = queue.filter((x) => x.update_id < (body.offset || 0) ? false : !u.includes(x)); ok(u); };
      if (queue.length) return send();
      let done = false;
      const fire = () => { if (done) return; done = true; waiters = waiters.filter((w) => w !== fire); send(); };
      setTimeout(fire, 800); waiters.push(fire); return;
    }
    if (m === 'sendMessage' || m === 'sendPhoto') return ok({ message_id: calls.length });
    ok(true);
  });
}).listen(9933, () => console.log('mock ok'));
