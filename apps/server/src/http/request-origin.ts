import type { IncomingHttpHeaders } from 'node:http';

export function acceptsRequestOrigin(
  headers: IncomingHttpHeaders,
  allowedOrigins: string[] = [],
): boolean {
  return (
    !headers.origin ||
    [`http://${headers.host}`, `https://${headers.host}`, ...allowedOrigins].includes(
      headers.origin,
    )
  );
}
