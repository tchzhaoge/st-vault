import { tr } from './i18n';
import { DAY_MS, civilTime } from './time';

export function dayKey(at: number): string {
  return new Date(civilTime(at)).toISOString().slice(0, 10);
}
export function dayLabel(at: number, now = Date.now()): string {
  const days = Math.floor(civilTime(now) / DAY_MS) - Math.floor(civilTime(at) / DAY_MS);
  return days === 0 ? tr('今天') : days === 1 ? tr('昨天') : days === 2 ? tr('前天') : dayKey(at);
}
export function clockLabel(at: number, precise = false): string {
  return new Date(civilTime(at)).toISOString().slice(11, precise ? 23 : 19);
}
