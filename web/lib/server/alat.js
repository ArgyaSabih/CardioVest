// Kelola alat yang boleh dipasangkan + cetak label QR pairing.
//   npm run alat -- daftar
//   npm run alat -- tambah cv-002           (kode pairing dibuat acak)
//   npm run alat -- kode-baru cv-001        (kode lama tidak berlaku lagi; alat yang terpasang tetap terpasang)
//   npm run alat -- lepas cv-001            (lepas pairing, mis. alat dipinjamkan ke orang lain)
// Di docker: docker compose exec web npm run alat -- tambah cv-002
// Label SVG berisi QR "CARDIOVEST:<id>:<kode>" disimpan di DATA_DIR/label-<id>.svg untuk ditempel di alat.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { cfg } from './config.js';
import { devices } from './store.js';

const [cmd, id, given] = process.argv.slice(2);
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

async function label(deviceId, code) {
  const qr = await QRCode.toString(`CARDIOVEST:${deviceId}:${code}`, { type: 'svg', margin: 1, width: 220 });
  const inner = qr
    .replace(/^<\?xml[^>]*>/, '')
    .replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1')
    .replace(/<svg([^>]*?)\s(width|height)="[^"]*"/g, '<svg$1')
    .replace('<svg', '<svg x="20" y="64" width="220" height="220"');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="340" viewBox="0 0 260 340" font-family="sans-serif">
  <rect width="260" height="340" rx="14" fill="#fff" stroke="#14213d" stroke-width="2"/>
  <text x="130" y="34" text-anchor="middle" font-size="20" font-weight="700" fill="#c8102e">CardioVest</text>
  <text x="130" y="54" text-anchor="middle" font-size="11" fill="#4a5568">Pindai di aplikasi: Beranda → Pasangkan alat</text>
  ${inner}
  <text x="130" y="306" text-anchor="middle" font-size="14" fill="#14213d">ID alat: ${deviceId}</text>
  <text x="130" y="326" text-anchor="middle" font-size="14" fill="#14213d">Kode pairing: ${code}</text>
</svg>`;
  const f = path.join(cfg.dataDir, `label-${deviceId}.svg`);
  fs.writeFileSync(f, svg);
  return f;
}

function check(deviceId) {
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(deviceId ?? '')) {
    console.error('ID alat wajib diisi: huruf, angka, - atau _, mis. cv-002 (harus sama dengan DEVICE_ID di firmware)');
    process.exit(1);
  }
}

if (cmd === 'daftar') {
  const list = devices.all();
  if (!list.length) console.log('Belum ada alat terdaftar.');
  for (const d of list) console.log(`${d.device_id.padEnd(12)} ${d.user_id ? `terpasang sejak ${new Date(d.paired_ts).toLocaleString('id-ID')}` : 'belum dipasangkan'}`);
} else if (cmd === 'tambah' || cmd === 'kode-baru') {
  check(id);
  if (cmd === 'tambah' && devices.get(id)) {
    console.error(`${id} sudah terdaftar. Pakai "kode-baru ${id}" untuk mengganti kodenya.`);
    process.exit(1);
  }
  if (cmd === 'kode-baru' && !devices.get(id)) {
    console.error(`${id} belum terdaftar. Pakai "tambah ${id}".`);
    process.exit(1);
  }
  const code = given && /^\d{6}$/.test(given) ? given : newCode();
  devices.upsert(id, code, { force: true });
  console.log(`ID alat     : ${id}\nKode pairing: ${code}\nLabel QR    : ${await label(id, code)}`);
  console.log('Kode hanya ditampilkan sekarang (yang disimpan hanya hash-nya). Tempel labelnya di alat.');
} else if (cmd === 'lepas') {
  check(id);
  devices.unpair(id);
  console.log(`${id} dilepas dari akunnya. Riwayat di database cloud tidak terhapus.`);
} else {
  console.log('Perintah: daftar | tambah <id> [kode6digit] | kode-baru <id> [kode6digit] | lepas <id>');
}
