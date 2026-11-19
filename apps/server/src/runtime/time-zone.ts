/** Validate deployment configuration instead of allowing Node's invalid-TZ fallback. */
export function deploymentTimeZone(value = process.env.TZ ?? 'Asia/Shanghai'): string {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch (cause) {
    throw new Error(`INVALID_TIME_ZONE: ${value}`, { cause });
  }
}
