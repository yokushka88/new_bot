// Розбір тексту поста з каналу: назва, ціна, розміри, кольори.
// Нічого не вигадує: чого не знайдено — повертає порожнім.

const KEYCAPS = Object.fromEntries(
  Array.from({ length: 10 }, (_, d) => [
    [`${d}️⃣`, String(d)],
    [`${d}⃣`, String(d)],
  ]).flat(),
);

const normalizeDigits = (s) => Object.entries(KEYCAPS).reduce((acc, [k, v]) => acc.split(k).join(v), s);

export function parsePrice(text) {
  const t = normalizeDigits(String(text));
  const m = t.match(/(?:ціна|price|вартість|цена)\s*[:\-–—]?\s*([\d\s.,]{2,})/i) || t.match(/([\d][\d\s]{1,8})\s*(?:грн|₴|uah)/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\D/g, ''), 10);
  return n > 0 && n < 10_000_000 ? n : null;
}

/** Розбиває «S, M, L» / «38,39,40» / «M L» на список значень. */
export function splitList(s) {
  let parts = String(s).split(/[,;/]/);
  // «M L XL» без ком — розбиваємо за пробілами, якщо всі частини короткі
  if (parts.length === 1 && /\s/.test(parts[0].trim())) {
    const words = parts[0].trim().split(/\s+/);
    if (words.every((w) => w.length <= 5)) parts = words;
  }
  return parts
    .map((v) => v.trim().replace(/^[•\-–·*]\s*/, ''))
    .filter((v) => v && v !== '-' && v.length <= 24);
}

function lineAfter(text, re) {
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = m[1].replace(/\([^)]*\)/g, '').trim().replace(/^[:\-–—\s]+/, '');
    if (rest) return splitList(rest);
    // значення списком у наступних рядках: «• 41.5 (26 см)»
    const out = [];
    for (const l of lines.slice(i + 1)) {
      const b = l.match(/^\s*[•\-–·*]\s*(.+)$/);
      if (!b) {
        if (l.trim()) break;
        continue;
      }
      out.push(b[1].trim());
    }
    return out;
  }
  return [];
}

export function parsePost(text) {
  const t = String(text || '');
  const name =
    t
      .split('\n')
      .map((l) => l.replace(/\(живі фото\)/i, '').replace(/[✔️✅☑️🔥💯]+/gu, '').trim())
      .find((l) => l && !/^(розмір|ціна|price|колір|для замовлення)/i.test(l)) || '';
  return {
    name: name.slice(0, 80),
    price: parsePrice(t),
    sizes: lineAfter(t, /розмір(?:и)?\s*[:\-–—]?\s*(.*)/i),
    colors: lineAfter(t, /кол(?:ір|ьори|ьор)\s*[:\-–—]?\s*(.*)/i),
  };
}
