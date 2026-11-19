import { useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { setLanguage, tr, type Language } from '../lib/i18n';
import { Icon } from '../../design/Icon';
export function LanguageSwitch({ compact = false }: { compact?: boolean }): JSX.Element {
  const { i18n } = useTranslation();
  const english = i18n.language === 'en';
  const pointer = useRef<{ x: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const choose = (value: Language): void => {
    void setLanguage(value).catch((error) => console.error('Language change failed', error));
  };
  if (compact)
    return (
      <button
        type="button"
        className="language-icon"
        aria-label="中文 / English"
        title={english ? '切换为中文' : 'Switch to English'}
        onClick={() => choose(english ? 'zh-CN' : 'en')}
      >
        <Icon name="language" />
      </button>
    );
  return (
    <div className="language-setting">
      <span>{tr('语言')}</span>
      <button
        type="button"
        role="switch"
        className="language-toggle"
        aria-label="Language / 语言"
        aria-checked={english}
        data-language={english ? 'en' : 'zh-CN'}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pointer.current = { x: event.clientX, moved: false };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointer.current && Math.abs(event.clientX - pointer.current.x) > 4)
            pointer.current.moved = true;
        }}
        onPointerUp={(event) => {
          if (pointer.current?.moved) {
            dragged.current = true;
            const box = event.currentTarget.getBoundingClientRect();
            choose(event.clientX >= box.left + box.width / 2 ? 'en' : 'zh-CN');
          }
          pointer.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointer.current = null;
          dragged.current = true;
        }}
        onLostPointerCapture={() => {
          pointer.current = null;
        }}
        onClick={(event) => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          if (event.detail === 0) choose(english ? 'zh-CN' : 'en');
          else {
            const box = event.currentTarget.getBoundingClientRect();
            choose(event.clientX >= box.left + box.width / 2 ? 'en' : 'zh-CN');
          }
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') dragged.current = false;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            choose(event.key === 'ArrowLeft' ? 'zh-CN' : 'en');
          }
        }}
      >
        <i className="language-toggle-thumb" aria-hidden="true" />
        <span aria-hidden="true">中文</span>
        <span aria-hidden="true">English</span>
      </button>
    </div>
  );
}
