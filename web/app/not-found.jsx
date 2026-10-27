import Link from 'next/link';

export const metadata = { title: 'Halaman tidak ada' };

export default function NotFound() {
  return (
    <main className="page login">
      <h1>Halaman ini tidak ada</h1>
      <p>Alamatnya mungkin salah ketik, atau tautannya sudah lama.</p>
      <Link href="/" className="btn primary wide">Ke Beranda</Link>
    </main>
  );
}
