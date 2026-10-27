'use client';
// Halaman 2–5: hanya untuk User Utama yang sudah masuk. Beranda dan Riwayat juga butuh alat terpasang.
import { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { usePathname, useRouter } from 'next/navigation';
import { getToken } from '@/src/api.js';
import { BottomNav, Disclaimer } from '@/src/components/ui.jsx';

const WITHOUT_DEVICE = ['/pasangkan', '/kontak', '/akun'];
// setelah masuk lagi, pengguna kembali ke halaman yang tadi dibuka (kecuali Akun, tempat tombol Keluar)
const backTo = (path) => (path === '/' || path === '/akun' ? '' : `?dari=${encodeURIComponent(path)}`);

export default function PrivateLayout({ children }) {
  const { user, device, loaded } = useSelector((s) => s.auth);
  const path = usePathname();
  const router = useRouter();
  const token = getToken();
  const needsDevice = !WITHOUT_DEVICE.includes(path);
  let target = null;
  if (!token) target = `/masuk${backTo(path)}`;
  else if (loaded && !user) target = '/masuk';
  else if (loaded && needsDevice && !device) target = '/pasangkan';

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (target || !loaded) return <div className="page center muted">Memuat…</div>;
  return (
    <>
      <main className="page">
        {children}
        <Disclaimer />
      </main>
      <BottomNav />
    </>
  );
}
