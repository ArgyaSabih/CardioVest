// Layanan ambulans cadangan di DIY untuk tombol "Tidak tersambung?" di layar Darurat. Yang dipilih adalah
// layanan terdekat dari lokasi GPS alat; tanpa lokasi, atau bila semuanya lebih dari BATAS_KM, layar
// menampilkan 119 saja. Dipakai server (lib/server) dan mode demo (src/demo), bukan oleh komponen layar.
//
// Nomor dicek 29-10-2026 dari situs resmi masing-masing:
//   RSUP Dr. Sardjito    sardjito.go.id, "Layanan Darurat (0274) 583613"
//   RS Bethesda          bethesda.or.id/in/kontak-kami.html, "IGD (Gawat Darurat) (0274) 586708"
//   RS Panti Rapih       pantirapih.or.id, "Ambulans Emergensi & Non-Emergensi (IGD) (0274) 552118" (26-02-2025)
//   RS PKU Muh. Yogya    rspkujogja.com, IGD lewat "0274-512653 ext 118" (diperbarui 11-02-2026)
//   RSA UGM              rsa.ugm.ac.id/nomor-telepon-penting, "0811 2548 118 (IGD, Telepon)"
//   PSC 119 per wilayah  pamor.jogjaprov.go.id (daftar dispatcher Pemda DIY)
// PSC 119 adalah layanan ambulans gawat darurat pemerintah; dipakai untuk wilayah yang jauh dari rumah
// sakit di atas. Titik PSC adalah pusat kota kabupatennya. Periksa ulang nomor ini sebelum dipakai sungguhan.

export const BATAS_KM = 30;

export const LAYANAN = [
  { name: 'IGD RSUP Dr. Sardjito', tel: '+62274583613', number: '(0274) 583613', lat: -7.7684, lng: 110.3735 },
  { name: 'IGD RS Bethesda', tel: '+62274586708', number: '(0274) 586708', lat: -7.783, lng: 110.378 },
  { name: 'IGD RS Panti Rapih', tel: '+62274552118', number: '(0274) 552118', lat: -7.77685, lng: 110.37635 },
  { name: 'IGD RS PKU Muhammadiyah Yogyakarta', tel: '+62274512653,118', number: '(0274) 512653 ext. 118', lat: -7.8007, lng: 110.3624 },
  { name: 'IGD RSA UGM', tel: '+628112548118', number: '0811 2548 118', lat: -7.7463, lng: 110.3525 },
  { name: 'PSC 119 Kota Yogyakarta', tel: '+62274420118', number: '(0274) 420118', lat: -7.8005, lng: 110.391 },
  { name: 'PSC 119 Sleman', tel: '+622748609000', number: '(0274) 8609000', lat: -7.7175, lng: 110.3556 },
  { name: 'PSC 119 Bantul', tel: '+622742811119', number: '(0274) 2811119', lat: -7.888, lng: 110.329 },
  { name: 'PSC 119 Gunungkidul', tel: '+62274391113', number: '(0274) 391113', lat: -7.966, lng: 110.6 },
  { name: 'PSC 119 Kulon Progo', tel: '+628225880119', number: '0822 5880 119', lat: -7.8575, lng: 110.159 },
];

/** Jarak dua titik di permukaan bumi (km), rumus haversine. */
export function jarakKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Layanan terdekat dari (lat, lng), atau null bila tidak ada lokasi / semuanya di luar BATAS_KM. */
export function layananTerdekat(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  for (const l of LAYANAN) {
    const km = jarakKm(lat, lng, l.lat, l.lng);
    if (!best || km < best.km) best = { ...l, km };
  }
  if (!best || best.km > BATAS_KM) return null;
  return { name: best.name, tel: best.tel, number: best.number, km: Math.round(best.km * 10) / 10 };
}

/** Titik GPS ditambah layanan terdekatnya (field `service`). */
export const denganLayanan = (g) => (g && g.lat != null ? { ...g, service: layananTerdekat(g.lat, g.lng ?? g.lon) } : g);
