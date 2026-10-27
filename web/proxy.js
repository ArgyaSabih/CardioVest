// Hanya berperan di Vercel. Vercel tidak bisa menjalankan MQTT, Socket.IO, maupun SQLite, jadi semua
// permintaan /api diteruskan ke server CardioVest (VPS/Docker) yang alamatnya ada di CARDIOVEST_API.
// IP asli pengguna ikut dikirim bersama PROXY_SECRET, supaya pembatas percobaan login di server tidak
// menganggap semua pengguna sebagai satu alamat IP milik Vercel.
// Di server CardioVest sendiri CARDIOVEST_API kosong, dan berkas ini tidak melakukan apa-apa.
import { NextResponse } from 'next/server';

const upstream = process.env.CARDIOVEST_API?.replace(/\/$/, '');

export function proxy(request) {
  if (!upstream) return NextResponse.next();
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
