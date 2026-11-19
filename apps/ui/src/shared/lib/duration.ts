import { tr } from './i18n';
export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1000)),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60;
  return [
    hours && hours + tr('小时'),
    minutes && minutes + tr('分钟'),
    (rest || (!hours && !minutes)) && rest + tr('秒'),
  ]
    .filter(Boolean)
    .join('');
}
