import { NextResponse } from 'next/server';

const upstream = process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '');

export function proxy(request) {
  if (!upstream) return NextResponse.json({ error: 'NEXT_PUBLIC_BACKEND_URL belum diisi di Vercel.' }, { status: 503 });
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
