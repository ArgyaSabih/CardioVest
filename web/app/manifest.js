export default function manifest() {
  return {
    name: 'CardioVest',
    short_name: 'CardioVest',
    description: 'Pantauan jantung keluarga dari alat CardioVest',
    lang: 'id',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#E9EBEE',
    theme_color: '#0B3D91',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
