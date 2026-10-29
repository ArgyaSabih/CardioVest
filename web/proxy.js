import { NextResponse } from 'next/server';
import { BACKEND_URL as upstream } from './src/backend.js';

export function proxy(request) {
  const url = new URL(request.nextUrl.pathname + request.nextUrl.search, upstream);
  const headers = new Headers(request.headers);
  headers.delete('x-cv-client-ip');
  headers.delete('x-cv-proxy-secret');
  if (process.env.PROXY_SECRET) {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (ip) headers.set('x-cv-client-ip', ip);
    headers.set('x-cv-proxy-secret', process.env.PROXY_SECRET);
  }
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = { matcher: '/api/:path*' };
