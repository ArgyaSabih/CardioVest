import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@/src/styles.css';
import Providers from './providers';

export const metadata = {
  title: { default: 'CardioVest', template: '%s · CardioVest' },
  description: 'Pantauan jantung keluarga dari alat CardioVest',
  applicationName: 'CardioVest',
  appleWebApp: { capable: true, title: 'CardioVest', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' },
  formatDetection: { telephone: false },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B3D91',
};

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
