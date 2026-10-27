'use client';
// Halaman berat (Chart.js + jsPDF, jsQR + kamera) dimuat saat dibuka supaya beranda cepat tampil.
import dynamic from 'next/dynamic';

const loading = () => <p className="muted">Memuat…</p>;
export const EventDetail = dynamic(() => import('./EventDetail.jsx'), { ssr: false, loading });
export const Pair = dynamic(() => import('./Pair.jsx'), { ssr: false, loading });
