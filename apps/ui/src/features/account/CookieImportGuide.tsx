import { tr } from '../../shared/lib/i18n';

/** The account panel imports a session exported by the user's browser. */
export function CookieImportGuide({ origin }: { origin: string }): JSX.Element {
  return (
    <details className="cookie-import-help">
      <summary>{tr('如何导出 Cookies？')}</summary>
      <ol className="cookie-help cookie-import-guide">
        <li>
          <a href="https://cookie-editor.com/" target="_blank" rel="noopener noreferrer">
            {tr('安装 Cookie-Editor 扩展')}
          </a>
        </li>
        <li>
          <a href={`${origin}/favorites`} target="_blank" rel="noopener noreferrer">
            {tr('打开所选站点并登录')}
          </a>
        </li>
        <li>{tr('在该站点打开扩展，选择 Export → JSON，复制后粘贴到上方。')}</li>
      </ol>
    </details>
  );
}
