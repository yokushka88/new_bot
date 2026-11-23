import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTelegram } from './services/telegram';
import './styles/app.css';

initTelegram('#0b0b0c');

// PWA: офлайн-кеш і можливість встановити магазин на телефон (поза Telegram)
if ('serviceWorker' in navigator && window.location.protocol === 'https:' && !/tgWebApp/.test(window.location.hash)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
