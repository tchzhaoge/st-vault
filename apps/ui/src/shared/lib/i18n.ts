import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../locales/en.json';
export const languages = [
  {
    id: 'zh-CN',
    name: '中文',
    messages: {
      ...Object.fromEntries(
        Object.keys(en)
          .filter((key) => !/_(compact|zero|one|two|few|many|other)$/.test(key))
          .map((key) => [key, key]),
      ),
    },
  },
  { id: 'en', name: 'English', messages: en },
] as const;
export type Language = (typeof languages)[number]['id'];
const STORAGE_KEY = 'stv-language';
function storedLanguage(): Language {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return languages.find((language) => language.id === saved)?.id ?? 'zh-CN';
  } catch (error) {
    console.warn(
      'Language preference unavailable',
      error instanceof Error ? error.name : 'unknown',
    );
    return 'zh-CN';
  }
}
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    languages.map((language) => [language.id, { translation: language.messages }]),
  ),
  lng: storedLanguage(),
  fallbackLng: 'zh-CN',
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  if (typeof window !== 'undefined')
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch (error) {
      console.warn(
        'Language preference could not be saved',
        error instanceof Error ? error.name : 'unknown',
      );
    }
});
if (typeof document !== 'undefined') document.documentElement.lang = i18n.language;
export function tr(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, { defaultValue: key, ...values });
}
export async function setLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
}
