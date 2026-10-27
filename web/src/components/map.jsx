'use client';
// Leaflet menyentuh window saat dimuat, jadi peta hanya dirender di browser.
import dynamic from 'next/dynamic';

export const LocationMap = dynamic(() => import('./LocationMap.jsx'), {
  ssr: false,
  loading: () => <div className="map" aria-hidden="true" />,
});

export const mapsLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
