// Pemilihan layanan ambulans terdekat untuk tombol "Tidak tersambung?" (lib/layanan-darurat.js)
import assert from 'node:assert/strict';
import test from 'node:test';
import { LAYANAN, denganLayanan, jarakKm, layananTerdekat } from '../lib/layanan-darurat.js';

test('jarak haversine masuk akal', () => {
  // Tugu Yogyakarta ke Malioboro (ujung selatan) kira-kira 1,6 km
  const km = jarakKm(-7.7829, 110.3671, -7.7976, 110.3653);
  assert.ok(km > 1.4 && km < 1.8, `jarak ${km}`);
});

test('memilih layanan terdekat dari lokasi', () => {
  assert.equal(layananTerdekat(-7.7832, 110.3775).name, 'IGD RS Bethesda'); // depan RS Bethesda
  assert.equal(layananTerdekat(-7.8003, 110.3640).name, 'IGD RS PKU Muhammadiyah Yogyakarta'); // Jl. KH Ahmad Dahlan
  assert.equal(layananTerdekat(-7.766, 110.373).name, 'IGD RSUP Dr. Sardjito'); // kampus UGM utara
  assert.equal(layananTerdekat(-7.9, 110.33).name, 'PSC 119 Bantul'); // kota Bantul
  assert.equal(layananTerdekat(-7.97, 110.59).name, 'PSC 119 Gunungkidul'); // Wonosari
  assert.equal(layananTerdekat(-7.86, 110.16).name, 'PSC 119 Kulon Progo'); // Wates
});

test('tanpa lokasi atau jauh dari DIY: tidak ada layanan, layar memakai 119', () => {
  assert.equal(layananTerdekat(null, null), null);
  assert.equal(layananTerdekat(-6.2, 106.8), null); // Jakarta
  assert.equal(denganLayanan(null), null);
});

test('hasil berisi nomor, nama, dan jarak dibulatkan', () => {
  const s = denganLayanan({ lat: -7.7832, lng: 110.3775, acc: 6 }).service;
  assert.match(s.tel, /^\+62\d{8,12}(,\d+)?$/);
  assert.equal(typeof s.km, 'number');
  assert.equal(s.km, Math.round(s.km * 10) / 10);
});

test('semua nomor berformat internasional', () => {
  for (const l of LAYANAN) assert.match(l.tel, /^\+62\d{8,12}(,\d+)?$/, l.name);
});
