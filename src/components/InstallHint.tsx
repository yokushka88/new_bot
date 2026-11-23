// Підказка «встановити на телефон» для PWA.
// Android/Chrome: системна кнопка встановлення. iPhone: коротка інструкція,
// бо Safari не має кнопки — лише «Поділитися» → «На екран Додому».

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { shopConfig } from '../config/shop';
import { telegram } from '../services/telegram';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const KEY = 'install-hint-hidden';
const hidden = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
const hide = () => {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* немає доступу до сховища */
  }
};

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    // У Telegram і у вже встановленому застосунку підказка не потрібна
    if (telegram.available || standalone() || hidden()) return;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    if (isIos()) {
      const t = setTimeout(() => setShow(true), 2500);
      return () => {
        clearTimeout(t);
        window.removeEventListener('beforeinstallprompt', onPrompt);
      };
    }
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!show) return null;
  const close = () => {
    hide();
    setShow(false);
  };

  return (
    <div className="install-hint" role="dialog" aria-label="Встановити застосунок">
      <img src="/icons/icon-192.png" alt="" />
      <div className="install-text">
        <b>Встановіть «{shopConfig.name}» на телефон</b>
        {prompt ? (
          <span>Відкривається як застосунок, без браузера</span>
        ) : (
          <span>
            Натисніть <Icon name="share" size={15} /> «Поділитися» → «На екран Додому»
          </span>
        )}
      </div>
      {prompt && (
        <button
          className="btn btn-primary install-btn"
          onClick={async () => {
            await prompt.prompt();
            await prompt.userChoice.catch(() => null);
            close();
          }}
        >
          Встановити
        </button>
      )}
      <button className="icon-btn install-close" onClick={close} aria-label="Закрити">
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
