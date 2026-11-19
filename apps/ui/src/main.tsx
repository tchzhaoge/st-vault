import React from 'react';
import ReactDOM from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import App from './App';
import { tr } from './shared/lib/i18n';
import { LanguageSwitch } from './shared/ui/LanguageSwitch';
import './style.css';
import './design/liquid-glass.css';
import './design/panels.css';
import './design/player-overlays.css';

function ViewportNotice(): JSX.Element {
  useTranslation();
  return (
    <main className="viewport-notice">
      <LanguageSwitch compact />
      <h1>{tr('当前窗口尺寸不受支持')}</h1>
      <p>{tr('请放大窗口，或使用符合尺寸和比例要求的平板或电脑。')}</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="viewport-workspace">
      <App />
    </div>
    <ViewportNotice />
  </React.StrictMode>,
);
