'use client';
// Grafik EKG (satuan mV) di atas kertas EKG standar: 25 mm/detik, 10 mm/mV, kotak kecil 1 mm, kotak besar 5 mm.
// Mode live menampilkan sapuan seperti monitor bedside: data datang per 3,5 detik lalu
// "diputar" dengan kecepatan nyata, ada celah hapus di depan kursor.
import { useEffect, useRef } from 'react';
import { onEcg } from '../realtime.js';

const MM_PER_S = 25;
const MM_PER_MV = 10;
const PAPER = '#FFF4F4';
const MINOR = '#F6D3D3';
const MAJOR = '#E59C9C';
const INK = '#1A2433';

function drawGrid(ctx, w, h, pxPerMm) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  for (let mm = 0, x = 0; x <= w; mm++, x = mm * pxPerMm) {
    ctx.strokeStyle = mm % 5 === 0 ? MAJOR : MINOR;
    ctx.lineWidth = mm % 5 === 0 ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
    ctx.stroke();
  }
  const mid = h / 2;
  for (let k = -Math.ceil(mid / pxPerMm); k * pxPerMm <= mid; k++) {
    const y = mid + k * pxPerMm;
    ctx.strokeStyle = k % 5 === 0 ? MAJOR : MINOR;
    ctx.lineWidth = k % 5 === 0 ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
}

function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function LiveEcg({ fs = 250, height = 168, leadOff = false, paused = false, stale = false, overlay = null }) {
  const wrap = useRef(null);
  const canvas = useRef(null);
  const queue = useRef([]);
  const leadOffRef = useRef(leadOff);
  leadOffRef.current = leadOff;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  useEffect(() => onEcg((p) => {
    if (p.lead_off) return; // nol dari firmware selama elektroda lepas: jangan digambar sebagai garis datar
    queue.current.push(...p.mv);
    if (queue.current.length > fs * 12) queue.current.splice(0, queue.current.length - fs * 4); // tertinggal jauh: lompat
  }), [fs]);

  useEffect(() => {
    let raf = 0;
    let ctx, grid, w, pxPerMm, n, buf, wi = 0, last = performance.now(), carry = 0, started = false;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const layout = () => {
      w = wrap.current.clientWidth;
      pxPerMm = Math.max(2.2, Math.min(4, w / 125)); // ±5 detik terlihat di layar ponsel
      ctx = setupCanvas(canvas.current, w, height);
      grid = document.createElement('canvas');
      const g = setupCanvas(grid, w, height);
      drawGrid(g, w, height, pxPerMm);
      n = Math.floor(w / (pxPerMm * MM_PER_S) * fs);
      buf = new Float32Array(n).fill(NaN);
      wi = 0;
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(wrap.current);

    const frame = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const q = queue.current;
      if (!started && q.length >= fs * 4) started = true; // penyangga awal agar sapuan mulus
      if (started && !paused) {
        const rate = q.length > fs * 6 ? 1.3 : 1;
        carry += dt * fs * rate;
        let k = Math.floor(carry);
        carry -= k;
        if (reduce) k = Math.min(q.length, n); // tanpa animasi: tampilkan blok sekaligus
        while (k-- > 0 && q.length) {
          buf[wi] = q.shift();
          wi = (wi + 1) % n;
        }
      }
      ctx.drawImage(grid, 0, 0, w, height);
      const mid = height / 2;
      const dx = w / n;
      const gap = Math.round(fs * 0.12);
      ctx.strokeStyle = INK;
      ctx.globalAlpha = staleRef.current || leadOffRef.current ? 0.3 : 1; // data lama / elektroda lepas: redup
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const ahead = (i - wi + n) % n;
        const v = buf[i];
        if (ahead < gap || Number.isNaN(v)) {
          pen = false;
          continue;
        }
        const y = Math.max(2, Math.min(height - 2, mid - v * MM_PER_MV * pxPerMm));
        if (!pen) ctx.moveTo(i * dx, y);
        else ctx.lineTo(i * dx, y);
        pen = true;
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fs, height, paused]);

  // pesan (elektroda lepas, data lama) ditulis di DOM supaya terbaca pembaca layar, bukan di kanvas
  return (
    <div className="ecg-live">
      <div ref={wrap} className="ecg-paper" role="img" aria-label={stale ? 'EKG terakhir sebelum alat terputus' : 'EKG langsung dari alat'}>
        <canvas ref={canvas} />
      </div>
      {overlay && <p className="ecg-overlay" role="status">{overlay}</p>}
    </div>
  );
}

/** Rekaman statis yang bisa digeser (riwayat event). markAt = indeks sampel awal kejadian. */
export function StaticEcg({ samples, fs = 250, pxPerMm = 3, height = 180, markAt = null }) {
  const canvas = useRef(null);
  useEffect(() => {
    const w = Math.max(320, Math.ceil((samples.length / fs) * MM_PER_S * pxPerMm));
    const ctx = setupCanvas(canvas.current, Math.min(w, 30000), height);
    drawGrid(ctx, Math.min(w, 30000), height, pxPerMm);
    const mid = height / 2;
    const dx = (MM_PER_S * pxPerMm) / fs;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let pen = false;
    samples.forEach((s, i) => {
      if (s == null) {
        pen = false; // celah data (paket hilang): garis diputus, bukan disambung lurus
        return;
      }
      const y = Math.max(2, Math.min(height - 2, mid - s * MM_PER_MV * pxPerMm));
      if (!pen) ctx.moveTo(i * dx, y);
      else ctx.lineTo(i * dx, y);
      pen = true;
    });
    ctx.stroke();
    ctx.font = '12px "Atkinson Hyperlegible", system-ui';
    for (let s = 0; s * fs < samples.length; s += 5) {
      ctx.fillStyle = '#5C2A2A'; // kontras cukup juga di atas garis kisi besar
      ctx.fillText(`${s} s`, s * fs * dx + 3, 14);
    }
    if (markAt != null) {
      const x = markAt * dx;
      ctx.strokeStyle = '#C8102E';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillStyle = '#C8102E';
      ctx.font = 'bold 13px "Atkinson Hyperlegible", system-ui';
      ctx.fillText('Kejadian dimulai', x + 5, height - 10);
    }
  }, [samples, fs, pxPerMm, height, markAt]);
  return (
    <div className="ecg-paper ecg-scroll" tabIndex={0} aria-label="Rekaman EKG, geser ke samping">
      <canvas ref={canvas} />
    </div>
  );
}
