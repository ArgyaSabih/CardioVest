// Konfigurasi Next.js CardioVest. Penerusan /api ke server CardioVest saat dipasang di Vercel ada di
// proxy.js, karena perlu menambahkan header IP pengguna.

// Mode demo: di Vercel tanpa CARDIOVEST_API (atau CARDIOVEST_DEMO=1), server CardioVest ditiru di
// browser (src/demo/backend.js), supaya aplikasi tetap bisa dicoba tanpa VPS.
const demo = process.env.CARDIOVEST_DEMO === '1' || (!!process.env.VERCEL && !process.env.CARDIOVEST_API);

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_CV_DEMO: demo ? '1' : '' },
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
