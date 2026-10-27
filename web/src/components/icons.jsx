// Piktogram CardioVest. Digambar dengan grid 24 px dan garis seragam, seperti piktogram papan penunjuk
// rumah sakit: bentuk sederhana yang tetap terbaca dari jauh dan oleh mata yang rabun.
const P = {
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z',
  pulse: 'M2.5 12.5h4.5l2.2-5 3.6 10 2.4-5h6.3',
  drop: 'M12 3.5s6 6.4 6 10.9a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z',
  walk: 'M13.5 5.2a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0zM9.5 21l2.3-6.2 2.7 2.7V21M11.8 14.8l-.9-4.6 4 2.1 2.1 2.7M10.9 10.2l-3.2 2.1-.8 3',
  alert: 'M12 3.5l9.5 16.5h-19zM12 10v4.8M12 17.4v.1',
  cross: 'M9 3.5h6v5.5h5.5v6H15v5.5H9V15H3.5V9H9z',
  unlinked: 'M3 3l18 18M9 7.5a8 8 0 0 1 11.5 2.2M3.5 9.7A8 8 0 0 1 6 8M6.8 13a5 5 0 0 1 2.2-1.3M15.3 12a5 5 0 0 1 1.9 1M12 18.5v.1',
  home: 'M3.5 11l8.5-7 8.5 7v9a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z',
  clock: 'M12 7v5l3.2 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  people: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20.5 19v-1a3 3 0 0 0-2-2.8M17 5.2a3 3 0 0 1 0 5.6M3.5 19v-1a3 3 0 0 1 2-2.8M7 5.2a3 3 0 0 0 0 5.6',
  user: 'M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  phone: 'M6.6 3h3l1.5 4.2-2 1.3a12 12 0 0 0 6.4 6.4l1.3-2 4.2 1.5v3a2 2 0 0 1-2.2 2A17.6 17.6 0 0 1 4.6 5.2 2 2 0 0 1 6.6 3z',
  arrow: 'M4.5 12h15M13.5 6l6 6-6 6',
  back: 'M19.5 12h-15M10.5 6l-6 6 6 6',
  pin: 'M12 21s-7-6.2-7-11.8a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM14.5 9.2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  download: 'M12 3.5v11.5M7 10.5l5 5 5-5M4 20.5h16',
  bell: 'M6 16.5v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20.5a2 2 0 0 0 4 0',
  lock: 'M5.5 11h13v10h-13zM8 11V7.5a4 4 0 0 1 8 0V11',
  device: 'M7.5 3h9v18h-9zM11 18h2',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5v1.5h2',
  check: 'M4.5 12.5l5 5 10-10',
  plus: 'M12 5v14M5 12h14',
  logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10',
  ecg: 'M2 12h5l2-6 4 12 2.5-8 1.5 2H22',
};

export default function Icon({ name, size = 24, stroke = 2.2, className, title }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name]} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
