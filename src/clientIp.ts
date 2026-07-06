import type { IncomingHttpHeaders } from 'node:http';

export function clientIp(
  headers: IncomingHttpHeaders,
  remoteAddress: string | null | undefined,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const forwardedFor = headers['x-forwarded-for'];
    const value = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const firstIp = value?.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  return remoteAddress ?? null;
}
